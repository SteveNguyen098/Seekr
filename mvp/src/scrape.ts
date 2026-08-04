import type { Page } from "playwright";
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

/**
 * Layered strategy: try well-known ATS DOM patterns first (reliable), then
 * fall back to a generic heuristic for arbitrary career pages.
 */
export async function listJobs(page: Page, careerUrl: string): Promise<JobPosting[]> {
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
): Promise<{ kind: "job" | "board" | "unknown"; reason: string }> {
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

  const signals = await page.evaluate((applyCtaSrc) => {
    const links = Array.from(document.querySelectorAll("a[href]"));
    const postingLike = links.filter((a) => {
      const href = (a as HTMLAnchorElement).href;
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
  }, APPLY_CTA_RE.source);

  // A board's defining feature is many distinct posting links.
  if (signals.postingLinks >= 5) return { kind: "board", reason: `found ${signals.postingLinks} job links` };
  // A posting: an apply affordance (or a form) plus a substantial description.
  if ((signals.hasApply || signals.hasForm) && signals.textLength > 1200)
    return { kind: "job", reason: "has an apply action and a full description" };
  if (signals.postingLinks >= 2) return { kind: "board", reason: `found ${signals.postingLinks} job links` };
  if (/[?&](gh_jid|jid|jobId|requisitionId)=|\/(job|vacancy|posting)\/\d/i.test(url))
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
