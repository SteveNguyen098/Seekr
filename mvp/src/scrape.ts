import type { Page, Frame } from "playwright";
import { APPLY_CTA_RE } from "./apply.js";

export interface JobPosting {
  title: string;
  url: string;
  location: string;
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
export async function listJobs(page: Page, careerUrl: string): Promise<JobPosting[]> {
  if (!/greenhouse\.io/.test(careerUrl)) return listJobsOnePage(page, careerUrl);

  const collected: JobPosting[] = [];
  const seenUrls = new Set<string>();

  for (let pageNum = 1; pageNum <= MAX_BOARD_PAGES; pageNum++) {
    const batch = await listJobsOnePage(page, boardPageUrl(careerUrl, pageNum));
    if (batch.length === 0) break;

    const before = seenUrls.size;
    for (const job of batch) {
      if (seenUrls.has(job.url)) continue;
      seenUrls.add(job.url);
      collected.push(job);
    }
    if (seenUrls.size === before) break;
  }

  return collected;
}

/**
 * Layered strategy: try well-known ATS DOM patterns first (reliable), then
 * fall back to a generic heuristic for arbitrary career pages.
 */
async function listJobsOnePage(page: Page, careerUrl: string): Promise<JobPosting[]> {
  await page.goto(careerUrl, { waitUntil: "networkidle", timeout: 30000 }).catch(() =>
    page.goto(careerUrl, { waitUntil: "load", timeout: 30000 })
  );

  const isGreenhouse = /greenhouse\.io/.test(page.url());
  const isLever = /lever\.co/.test(page.url());

  let raw: { title: string; href: string }[] = [];

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
    return jobs;
  } else if (isLever) {
    const parsed = await page.$$eval("a.posting-title", (els) =>
      els.map((el) => {
        const title = el.querySelector("h5")?.textContent?.trim() || el.textContent?.trim() || "";
        const location = el.querySelector(".posting-categories")?.textContent?.trim() ?? "";
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
    return jobs;
  } else {
    raw = await page.$$eval("a[href]", (els) =>
      els
        .map((el) => ({ title: el.textContent?.trim() ?? "", href: (el as HTMLAnchorElement).href }))
        .filter((j) => /\/(job|jobs|position|positions|opening|openings|careers)\/[\w-]+/i.test(j.href))
    );
  }

  const seen = new Set<string>();
  const jobs: JobPosting[] = [];
  for (const { title, href } of raw) {
    const cleanTitle = title.trim();
    if (!cleanTitle || cleanTitle.length < 3 || cleanTitle.length > 150) continue;
    if (NAV_WORDS.has(cleanTitle.toLowerCase())) continue;
    if (seen.has(href)) continue;
    seen.add(href);
    jobs.push({ title: cleanTitle, url: href, location: "" });
  }

  return jobs;
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
