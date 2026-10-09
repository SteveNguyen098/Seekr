import type { Page, Frame } from "playwright";
import { APPLY_CTA_RE } from "./apply.js";
import { readSearchIndex, watchForSearchIndex } from "./searchIndex.js";

export interface JobPosting {
  title: string;
  url: string;
  location: string;
}

/**
 * What a board scan found, alongside what the board claims to hold, so a
 * shortfall between the two can be disclosed instead of passing silently.
 */
export interface BoardListing {
  jobs: JobPosting[];
  /**
   * Entries enumerated before location variants were merged - what the
   * board's own total is counting. Equal to jobs.length for every DOM
   * scraper; higher for a search index that lists a role once per location.
   */
  rows: number;
  /** Null when the board states no total of its own. */
  statedTotal: number | null;
}

/**
 * A sentence describing a coverage shortfall, or null when there is none.
 *
 * Compares `rows` and not the posting count, because those are the two
 * numbers that mean the same thing. The measured index reports 625 rows for
 * 348 distinct postings, so a complete read of that board would otherwise
 * announce a 277-posting shortfall - a false alarm on the very fix meant to
 * remove the real one.
 *
 * The 10% tolerance absorbs a board whose stated total is slightly stale or
 * counts something marginally different; a scraper gap of the kind worth
 * reporting is not a rounding error (the real one was 4%).
 */
export function coverageShortfall(rows: number, statedTotal: number | null): string | null {
  if (statedTotal === null || rows >= statedTotal * 0.9) return null;
  return (
    `this board says it has ${statedTotal} - only ${rows} could be read, ` +
    `so the ranking below saw part of the board, not all of it.`
  );
}

const NAV_WORDS = new Set([
  "home", "about", "contact", "privacy", "terms", "login", "sign in", "careers",
  "blog", "help", "faq", "back to jobs", "apply", "submit",
]);

/** Hard stop, so a board that never returns an empty page can't loop forever. */
const MAX_BOARD_PAGES = 25;

/**
 * The board URL for page N.
 *
 * Its own function because the failure it guards against is silent and
 * easy to reintroduce: a board URL copied out of a browser usually already
 * carries "page=1", and appending rather than replacing yields
 * "?page=1&page=2" - which most servers resolve to the FIRST value, so
 * every request quietly returns page 1 and the walk stops after one page
 * having "found" 50 jobs. Other query params (gh_src and friends) must
 * survive, since some boards scope their results by them.
 */
export function boardPageUrl(careerUrl: string, pageNum: number): string {
  const url = new URL(careerUrl);
  url.searchParams.set("page", String(pageNum));
  return url.toString();
}

/**
 * Walks a paginated board and returns every posting across all its pages.
 *
 * THE BUG this fixes was silent, which is what made it worth measuring
 * rather than eyeballing: Greenhouse serves 50 postings per page, so a
 * board of 193 came back as 50 with no error, no warning, and a perfectly
 * plausible-looking list. Measured on Sony Interactive Entertainment's
 * board - 50/50/50/43 across four pages, matching the "193 jobs" the page
 * states about itself.
 *
 * Greenhouse paginates by URL (`?page=N`), which is why this works at all:
 * its own pager renders as JavaScript buttons with no hrefs, so there is
 * nothing to follow in the DOM. Confirmed on that board - a[href*='page=']
 * matches nothing.
 *
 * Scoped to Greenhouse deliberately. Lever and the generic fallback keep
 * their existing single-page behaviour rather than having an unverified
 * pagination scheme guessed at for them.
 *
 * Two independent stop conditions, because they fail differently: an empty
 * page ends a well-behaved board (verified: page=5 returns 0 here), and a
 * page contributing no NEW urls ends one that clamps out-of-range requests
 * to the last page instead - which would otherwise repeat forever.
 */
export async function listJobs(page: Page, careerUrl: string): Promise<BoardListing> {
  if (!/greenhouse\.io/.test(careerUrl)) {
    const { jobs, rows } = await listJobsOnePage(page, careerUrl);
    return { jobs, rows, statedTotal: await statedTotal(page) };
  }

  const collected: JobPosting[] = [];
  const seenUrls = new Set<string>();
  let rows = 0;

  for (let pageNum = 1; pageNum <= MAX_BOARD_PAGES; pageNum++) {
    const batch = await listJobsOnePage(page, boardPageUrl(careerUrl, pageNum));
    if (batch.jobs.length === 0) break;
    rows += batch.rows;

    const before = seenUrls.size;
    for (const job of batch.jobs) {
      if (seenUrls.has(job.url)) continue;
      seenUrls.add(job.url);
      collected.push(job);
    }
    if (seenUrls.size === before) break;
  }

  return { jobs: collected, rows, statedTotal: await statedTotal(page) };
}

/**
 * How many postings the board says it has, when it says so at all.
 *
 * Exists because the expensive failure here is a SILENT shortfall. A board
 * advertising "625 roles" that yields 26 of them produces a short, entirely
 * plausible-looking shortlist, and the thing that looks wrong is the
 * company's hiring rather than the scraper. Comparing what was collected
 * against what the board claims about itself is the cheapest available
 * check, and it needs no per-board knowledge.
 *
 * Reported, never acted on: it is a number the page wrote about itself, so
 * it can be marketing copy, and callers treat a shortfall as something to
 * disclose rather than as grounds to change what they do.
 */
export async function statedTotal(page: Page): Promise<number | null> {
  const text = await page
    .evaluate(() => document.body?.innerText?.slice(0, 20000) ?? "")
    .catch(() => "");
  // The count and its noun, adjacent: "625 roles", "193 jobs",
  // "41 roles across all departments in 3 locations".
  const counts = [...text.matchAll(/\b(\d[\d,]{0,6})\s+(?:open\s+)?(?:roles?|jobs?|positions?|openings?)\b/gi)]
    .map((m) => Number(m[1].replace(/,/g, "")))
    .filter((n) => Number.isFinite(n) && n > 0);
  if (!counts.length) return null;
  // The largest claim on the page: a board states its total once, while
  // smaller numbers beside it tend to be per-department or per-location
  // breakdowns of that same total.
  return Math.max(...counts);
}

/**
 * Layered strategy: try well-known ATS DOM patterns first (reliable), then
 * fall back to a generic heuristic for arbitrary career pages.
 */
async function listJobsOnePage(
  page: Page,
  careerUrl: string
): Promise<{ jobs: JobPosting[]; rows: number }> {
  // Attached before navigation, because the board's search query fires
  // during page load - a listener added afterwards sees nothing.
  const searchIndex = watchForSearchIndex(page);
  try {
    await page.goto(careerUrl, { waitUntil: "networkidle", timeout: 30000 }).catch(() =>
      page.goto(careerUrl, { waitUntil: "load", timeout: 30000 })
    );

    // Preferred over anything in the DOM when it is available: a board that
    // answers from a search index renders only the first batch of hits, so
    // the DOM is a fraction of the board by construction, not by accident.
    const endpoint = searchIndex.found();
    if (endpoint) {
      const fromIndex = await readSearchIndex(page, endpoint);
      // Falls through to DOM scraping on an empty read rather than
      // reporting an empty board: an index whose fields are named
      // differently yields no postings here, and the DOM is still there.
      if (fromIndex.postings.length) return { jobs: fromIndex.postings, rows: fromIndex.rows };
    }
  } finally {
    searchIndex.stop();
  }

  const isGreenhouse = /greenhouse\.io/.test(page.url());
  const isLever = /lever\.co/.test(page.url());

  let raw: { title: string; href: string; location: string }[] = [];

  if (isGreenhouse) {
    const parsed = await page.$$eval("a[href*='/jobs/']", (els) =>
      els.map((el) => {
        const paras = Array.from(el.querySelectorAll("p"));
        const rawTitle = paras[0]?.textContent?.trim() || el.textContent?.trim() || "";
        // Greenhouse appends a "New" badge directly onto the title text with no separator.
        const title = rawTitle.replace(/(?<=[a-z])New$/, "");
        const location = paras[1]?.textContent?.trim() ?? "";
        return { title, href: (el as HTMLAnchorElement).href, location };
      })
    );
    const seen = new Set<string>();
    const jobs: JobPosting[] = [];
    for (const { title, href, location } of parsed) {
      if (!title || title.length < 3 || seen.has(href)) continue;
      seen.add(href);
      jobs.push({ title, url: href, location });
    }
    return { jobs, rows: jobs.length };
  } else if (isLever) {
    const parsed = await page.$$eval("a.posting-title", (els) =>
      els.map((el) => {
        const title = el.querySelector("h5")?.textContent?.trim() || el.textContent?.trim() || "";
        // Each category is its own element and they carry no separator of
        // their own, so reading the container's textContent runs them
        // together: measured on a live Lever board as
        // "Remote — Full-timeNew York, NY", which is the commitment and the
        // city welded into one word. Joined explicitly instead.
        const cats = el.querySelector(".posting-categories");
        const parts = cats
          ? [...cats.children]
              .map((c) =>
                (c.textContent || "")
                  .replace(/\s+/g, " ")
                  // Lever's workplace-type element carries its own trailing
                  // dash, so joining raw parts yields "Remote — — Full-time".
                  .replace(/^[\s–—-]+|[\s–—-]+$/g, "")
                  .trim()
              )
              .filter(Boolean)
          : [];
        const location = parts.length ? parts.join(" — ") : (cats?.textContent?.trim() ?? "");
        return { title, href: (el as HTMLAnchorElement).href, location };
      })
    );
    const seen = new Set<string>();
    const jobs: JobPosting[] = [];
    for (const { title, href, location } of parsed) {
      if (!title || title.length < 3 || seen.has(href)) continue;
      seen.add(href);
      jobs.push({ title, url: href, location });
    }
    return { jobs, rows: jobs.length };
  } else {
    raw = await page.$$eval("a[href]", (els) => {
      const herePage = location.origin + location.pathname;
      return els
        .map((el) => {
          // innerText, not textContent, because a responsive card renders
          // its contents TWICE - once for wide screens and once for narrow,
          // with CSS hiding whichever does not apply. textContent reads
          // both, which is how a title arrived as "Account Executive,
          // Broker Channel (Arkansas) SalesAR Account Executive, Broker
          // Channel (Arkansas) Sales - AR" and got triaged in that state.
          // innerText honours the hiding, so only the rendered variant is
          // read, and its line breaks separate the card's own fields.
          const lines = ((el as HTMLElement).innerText || el.textContent || "")
            .split("\n")
            .map((line) => line.replace(/\s+/g, " ").trim())
            .filter(Boolean);
          return {
            title: lines[0] ?? "",
            href: (el as HTMLAnchorElement).href,
            // The card's last line is its location when it has one; a plain
            // title-only link yields no second line and so no location.
            location: lines.length > 1 ? lines[lines.length - 1] : "",
          };
        })
        .filter((j) => /\/(job|jobs|position|positions|opening|openings|careers)\/[\w-]+/i.test(j.href))
        // A link into the CURRENT page is never a posting on it. Two of
        // these were measured on one board: the accessibility skip-link at
        // "/careers/open-roles#main-content", and - on the filtered view of
        // the same board - a "Clear filters" link back to
        // "/careers/open-roles". Both satisfy the filter above, so both
        // were scraped as jobs and ranked.
        //
        // Compared on origin + path, deliberately ignoring query and
        // fragment: "Clear filters" differs from the current URL only by
        // its query string, so comparing whole URLs let it through.
        // Dropped by target rather than by link text, so this holds for
        // whatever a given board calls those links.
        .filter((j) => {
          try {
            const target = new URL(j.href);
            return target.origin + target.pathname !== herePage;
          } catch {
            return true;
          }
        });
    });
    // Nothing matched, but the page may still list postings behind opaque
    // ids that name no concept at all.
    //
    // THE GAP: an Ashby board returned ZERO postings while classifyUrl
    // correctly called it a board - so a pasted Ashby board scanned
    // cleanly and reported nothing suitable, which reads as a verdict on
    // the company rather than a scraper gap. Measured on HoYoverse: 19
    // links, 14 of them postings, 0 matching the filter above, because it
    // wants the word job/position/opening in the href and Ashby's are
    // /<company>/<uuid>.
    //
    // A fallback keyed on link SHAPE rather than on the hostname: it costs
    // nothing on a board the filter above already handled (it only runs
    // when that found nothing), covers any ATS using opaque ids rather
    // than just this one, and can be exercised offline - a hostname test
    // could only ever be checked against the live site.
    if (raw.length === 0) {
      const parsed = await page.$$eval("a[href]", (els) =>
        els
          .filter((el) =>
            /\/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}(?:[/?#]|$)/i.test((el as HTMLAnchorElement).href)
          )
          .map((el) => {
            const full = (el.textContent || "").replace(/\s+/g, " ").trim();
            // Structure, not class names: Ashby's are build-hashed
            // (_title_1dvh9_382) and would break on their next deploy.
            const title = el.querySelector("h3")?.textContent?.replace(/\s+/g, " ").trim() || full;
            // The rest of the card is a "bullet"-separated line - measured as
            // department, location, commitment, workplace across all 14
            // postings on that board. Taking the whole line as the location
            // would drag the department into location matching.
            const rest = full.startsWith(title) ? full.slice(title.length).trim() : "";
            const parts = rest.split("•").map((x) => x.trim()).filter(Boolean);
            const location = parts.length >= 2 ? parts[1] : parts[0] ?? "";
            return { title, href: (el as HTMLAnchorElement).href, location };
          })
      );
      const seenOpaque = new Set<string>();
      const opaqueJobs: JobPosting[] = [];
      for (const { title, href, location } of parsed) {
        if (!title || title.length < 3 || seenOpaque.has(href)) continue;
        seenOpaque.add(href);
        opaqueJobs.push({ title, url: href, location });
      }
      if (opaqueJobs.length) return { jobs: opaqueJobs, rows: opaqueJobs.length };
    }
  }

  const seen = new Set<string>();
  const jobs: JobPosting[] = [];
  for (const { title, href, location } of raw) {
    const cleanTitle = title.trim();
    if (!cleanTitle || cleanTitle.length < 3 || cleanTitle.length > 150) continue;
    if (NAV_WORDS.has(cleanTitle.toLowerCase())) continue;
    if (seen.has(href)) continue;
    seen.add(href);
    jobs.push({ title: cleanTitle, url: href, location });
  }

  return { jobs, rows: jobs.length };
}

/**
 * Decides whether a URL is a single job posting or a listings/career page,
 * so a UI can just take a link instead of asking the user to classify it.
 *
 * Structure first, URL patterns second. A page carrying many posting-shaped
 * links is a board; one carrying an Apply control and a long block of prose
 * is a posting. URL shape alone is unreliable - plenty of boards sit at
 * /careers/jobs and plenty of postings sit at /careers/<slug> - so it's only
 * consulted to break a tie.
 *
 * Returns "unknown" when neither signal fires, which callers should treat as
 * "this may not be a job page at all" rather than silently guessing.
 */
export async function classifyUrl(
  page: Page,
  url: string
): Promise<{ kind: "job" | "board" | "gone" | "unknown"; reason: string }> {
  const ok = await page
    .goto(url, { waitUntil: "networkidle", timeout: 30000 })
    .then(() => true)
    .catch(() =>
      page
        .goto(url, { waitUntil: "load", timeout: 30000 })
        .then(() => true)
        .catch(() => false)
    );
  if (!ok) return { kind: "unknown", reason: "the page could not be loaded" };

  // Boards on SPA platforms render their listings after load.
  await page.waitForTimeout(2500);

  // Gathered from EVERY frame, not just the main document. A company that
  // embeds its ATS (Greenhouse/Lever/Ashby all ship a JS embed) keeps the
  // entire posting - description, Apply button, the lot - inside a
  // cross-origin iframe, leaving the host page with only marketing chrome.
  // Measured live on a MeridianLink careers URL: the main frame reported
  // hasApply=false and no posting links, while the real posting sat in
  // jobs.ashbyhq.com/<company>/<uuid>?embed=js - so a perfectly valid job
  // link was rejected outright as "not a job posting or careers page" and
  // the run never started. The fill pipeline behind this gate already
  // walks every frame (see allContexts/findFormContext in apply.ts), so
  // the classifier was strictly more restrictive than the machinery it
  // guards. Combined by max/OR rather than sum, so one posting rendered in
  // both a frame and its host can't be double-counted into looking like a
  // board.
  // The URL the links are relative to. Passed in rather than read from
  // location.href inside evaluate(), because collect() also runs in frames,
  // where location.href is the frame's own URL and self-links would stop
  // being recognisable as self-links.
  const here = page.url().split(/[?#]/)[0].replace(/\/+$/, "");
  // This page's own posting id, if it has one. A link carrying the SAME id
  // is this posting again (its apply page, a canonical form); a link
  // carrying a different one is a sibling. Null on a board URL, which names
  // no single posting - and that is what keeps a board's postings counted.
  const hereId =
    here.match(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i)?.[0] ??
    here.match(/\/(\d{6,})(?:\/|$)/)?.[1] ??
    null;

  const collect = (ctx: Page | Frame) =>
    ctx
      .evaluate(({ applyCtaSrc, here, hereId }) => {
        const links = Array.from(document.querySelectorAll("a[href]"));
        const postingLike = links.filter((a) => {
          const href = (a as HTMLAnchorElement).href;
          // A link back to THIS posting is not a sibling job.
          //
          // THE BUG: an Ashby posting was classified "board - found 2 job
          // links". The two links were the posting's own URL and its own
          // "Apply for this Job" button, which lives at <posting>/application.
          // Both match the opaque-id rule below, so a single job advert was
          // read as a listings page purely for linking to itself, and the
          // application was never opened.
          //
          // Matched on the posting ID, NOT on "is a sub-path of this URL" -
          // that was the first attempt and it broke board detection
          // outright, because on a Greenhouse board every posting is a
          // sub-path of the board's own URL. hereId is null there, so
          // nothing is excluded and the postings still count.
          const bare = href.split(/[?#]/)[0].replace(/\/+$/, "");
          if (bare === here) return false;
          if (hereId && href.includes(hereId)) return false;
          // Path names the concept: /jobs/x, /careers/x, /vacancy/x ...
          if (/\/(jobs?|careers?|vacanc(y|ies)|positions?|openings?|postings?)\/[^/?#]{2,}/i.test(href)) return true;
          // ...or the link ends in an opaque posting id. Ashby uses
          // /<company>/<uuid> with no such word anywhere in the path, and
          // Greenhouse-style boards use long numeric ids, so neither is caught
          // by the pattern above.
          return /\/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-/i.test(href) || /\/\d{6,}(?:[/?#]|$)/.test(href);
        });
        const uniq = new Set(postingLike.map((a) => (a as HTMLAnchorElement).href.split(/[?#]/)[0]));
        const text = document.body.innerText || "";
        return {
          postingLinks: uniq.size,
          hasApply: new RegExp(applyCtaSrc, "i").test(text),
          hasForm: !!document.querySelector("input[type=file], form input[type=email]"),
          textLength: text.length,
        };
      }, { applyCtaSrc: APPLY_CTA_RE.source, here, hereId })
      .catch(() => ({ postingLinks: 0, hasApply: false, hasForm: false, textLength: 0 }));

  const perFrame = await Promise.all([page, ...page.frames()].map(collect));
  const signals = perFrame.reduce(
    (acc, s) => ({
      postingLinks: Math.max(acc.postingLinks, s.postingLinks),
      hasApply: acc.hasApply || s.hasApply,
      hasForm: acc.hasForm || s.hasForm,
      textLength: Math.max(acc.textLength, s.textLength),
    }),
    { postingLinks: 0, hasApply: false, hasForm: false, textLength: 0 }
  );

  // A link that named ONE posting but landed somewhere else, on a page that
  // reads as a listing, means that posting was taken down: ATSs redirect a
  // dead job to the company's board rather than 404ing. Confirmed live - a
  // Greenhouse posting that worked days earlier now answers 200 and lands on
  // "/procaresolutions?error=true", whose signals are indistinguishable from
  // that company's own board (12 links, no apply text, no form, same ~20.5k
  // of text). The ?error=true param is a strong extra hint but is
  // vendor-specific, so it isn't required here.
  //
  // Worth its own kind rather than reporting "board": the caller asked for
  // one specific job, and quietly scraping the board instead can end up
  // filling out a DIFFERENT role than the link pointed at - a worse outcome
  // than stopping. It also stops the failure surfacing as "no postings
  // matched the target titles", which sends whoever reads it off editing
  // criteria.json when the real cause is a dead link.
  //
  // Both conditions are required - a posting-shaped request AND a
  // board-shaped destination - so a posting that merely canonicalises its
  // URL, or hops to an embed host the way Ashby's ?ashby_jid= links do,
  // still classifies as a job.
  const landed = page.url();
  const strip = (u: string) => u.split(/[?#]/)[0].replace(/\/+$/, "");
  const askedForOnePosting =
    /\/(jobs?|careers?|vacanc(y|ies)|positions?|openings?|postings?)\/[^/?#]{2,}/i.test(url) ||
    /[?&][a-z]*_?(jid|job_?id|requisition_?id)=/i.test(url);
  // ...and the destination offers no Apply affordance of its own. A posting
  // that redirects to ANOTHER posting (canonicalisation, an embed host) is
  // still very much alive, and hasApply is what tells the two apart.
  const deadPosting = askedForOnePosting && strip(landed) !== strip(url) && !signals.hasApply;

  // An Apply affordance in the page's own text, plus a real description, is
  // ONE posting - even when the page also links to many sibling jobs.
  //
  // Checked BEFORE the link-count rule below, which otherwise wins and calls
  // it a board. Confirmed live on a Trillium Staffing posting
  // ("Autonomous Vehicle Operator"): a genuine, live posting carrying a
  // 13-link "other jobs" sidebar, reported as "a careers/listings page",
  // scraped for listings, matched against target titles, and abandoned with
  // "No postings matched the target titles" - a run that never fetched the
  // job description, never tailored a resume, and never opened the form.
  //
  // Keyed on hasApply ALONE, deliberately, not the broader (hasApply ||
  // hasForm) rule further down. Measured across four real boards: every one
  // had hasApply=false, but Trillium's OWN board carries a job-alert signup
  // form, so hasForm is true there too - keying on form presence would have
  // turned that board into a posting. The measured separator is the Apply
  // affordance:
  //
  //   page                         links  hasApply  hasForm  textLen
  //   Trillium posting                13      true     true     4762
  //   Trillium board                  21     false     true     2827
  //   Procare board                   13     false    false    20630
  //   12twenty board                   5     false    false      880
  //   12twenty posting                 1      true     true     6706
  //
  // Also requires the URL to name ONE posting, and that is load-bearing
  // rather than belt-and-braces. hasApply is a substring test over the
  // page's whole text, so ordinary prose trips it: a board fixture padded
  // with "Applying takes a few minutes" set hasApply true and was promoted
  // to a posting on the spot. That was the exact risk noted here as
  // hypothetical, demonstrated minutes later by the corpus. Any board whose
  // copy happens to contain the word - "apply today", "how to apply" - would
  // do the same. The URL shape is the independent signal that keeps a
  // listings page a listings page no matter what its prose says.
  if (askedForOnePosting && signals.hasApply && signals.textLength > 1200)
    return { kind: "job", reason: "has an apply action and a full description" };

  // A board's defining feature is many distinct posting links.
  if (signals.postingLinks >= 5)
    return deadPosting
      ? { kind: "gone", reason: `it redirected to ${landed}` }
      : { kind: "board", reason: `found ${signals.postingLinks} job links` };
  // The same posting shape, for URLs that name no concept at all.
  //
  // askedForOnePosting above keys on a path segment like /jobs/ or
  // /careers/. Ashby's postings are /<company>/<uuid> and the only "jobs"
  // in the URL is the HOSTNAME, jobs.ashbyhq.com - so that test can never
  // fire there and a real posting fell through to the link-count rules.
  //
  // The link-side filter already treats a trailing opaque id as
  // posting-shaped; this applies the identical reasoning to the URL that
  // was actually requested, which is the inconsistency that hid the bug.
  //
  // Deliberately placed AFTER the >= 5 board check, unlike its
  // sibling rule: an opaque id is a weaker signal than a named path, so a
  // board that happens to carry a UUID must still lose to a page that is
  // plainly listing many jobs.
  const opaquePostingUrl =
    /\/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}(?:[/?#]|$)/i.test(url) ||
    /\/\d{6,}(?:[/?#]|$)/.test(url);
  if (opaquePostingUrl && signals.hasApply && signals.textLength > 1200)
    return { kind: "job", reason: "an opaque posting id, an apply action and a full description" };

  // The application form itself, linked to directly.
  //
  // Ashby's apply page lives at <posting>/application and is a bare form:
  // measured at 852 characters of text, so the "full description" rule
  // below rejects it, and its button reads "Submit Application" - which
  // does not contain "Apply", so hasApply is false too. It failed every
  // branch and came back "unknown".
  //
  // No prose requirement here, because a form page legitimately has none.
  // The length test exists to stop a newsletter signup on a marketing page
  // being read as a job; an opaque posting id in the URL is the independent
  // signal that already rules that out.
  if (opaquePostingUrl && signals.hasForm)
    return { kind: "job", reason: "an opaque posting id and a real application form" };

  // A posting whose Apply lives behind a form rather than the word "Apply".
  if (signals.hasForm && signals.textLength > 1200)
    return { kind: "job", reason: "has an application form and a full description" };
  if (signals.postingLinks >= 2)
    return deadPosting
      ? { kind: "gone", reason: `it redirected to ${landed}` }
      : { kind: "board", reason: `found ${signals.postingLinks} job links` };
  // The job-id parameter is matched with an optional vendor prefix
  // ("ashby_jid", "gh_jid", ...) rather than a bare alternation: [?&]jid=
  // cannot match "?ashby_jid=", since the character before "jid" there is
  // "_", not a delimiter. Confirmed live - a MeridianLink URL carrying
  // ?ashby_jid=<uuid> failed every branch above and fell through to
  // "unknown".
  if (/[?&][a-z]*_?(jid|job_?id|requisition_?id)=|\/(job|vacancy|posting)\/\d/i.test(url))
    return { kind: "job", reason: "URL identifies a specific posting" };
  return { kind: "unknown", reason: "no job listings or application form found on this page" };
}

export async function getJobDescription(
  page: Page,
  jobUrl: string
): Promise<{ title: string; text: string }> {
  await page.goto(jobUrl, { waitUntil: "networkidle", timeout: 30000 }).catch(() =>
    page.goto(jobUrl, { waitUntil: "load", timeout: 30000 })
  );
  const title = (await page.title()) || jobUrl;
  const text = await page.innerText("body");
  return { title, text: text.trim() };
}
