import "dotenv/config";
import { chromium } from "playwright";
import Anthropic from "@anthropic-ai/sdk";
import readline from "node:readline/promises";
import path from "node:path";
import os from "node:os";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { loadResume } from "./resume.js";
import { listJobs, getJobDescription, classifyUrl } from "./scrape.js";
import { filterByTitle, filterByLocation, passesHardRequirements, detectLocationPreference, type Criteria } from "./filter.js";
import { rankJobs, type CandidateJob } from "./match.js";
import { openApplicationForm, fillApplication } from "./apply.js";
import { loadPersonalContext } from "./context.js";
import { generateTailoredResume } from "./resumeGenerator.js";
import { captureFormSnapshot } from "./snapshot.js";

function parseArgs(argv: string[]) {
  const args: Record<string, string> = {};
  for (let i = 0; i < argv.length; i++) {
    if (argv[i].startsWith("--")) {
      const key = argv[i].slice(2);
      const value = argv[i + 1] && !argv[i + 1].startsWith("--") ? argv[++i] : "true";
      args[key] = value;
    }
  }
  return args;
}

function usageAndExit(): never {
  console.error(`Usage:
  npx tsx src/index.ts --career-url <url> --resume <path.docx> [--criteria <path.json>] [--titles "title1,title2"] [--max-years N] [--out ./out]
  npx tsx src/index.ts --job-url <url> --resume <path.docx> [--out ./out]

A --criteria file supplies target titles and screening rules in one place
(see criteria.json). Individual flags override whatever it sets.
Either --criteria or --titles is required when scraping a career page with
--career-url.

--snapshot <dir> freezes the opened application form to <dir>/<slug>/page.mhtml
before any field is filled, building the regression corpus replayed by
"npm run test:snapshots". Captured through the real pipeline because the DOM
worth freezing only exists after the cookie banner and the Apply click; the
capture holds the blank form, never your data.

--job-url skips scraping/filtering/ranking entirely and applies directly to
one already-known posting - for ATS platforms whose listing page isn't
scrapable yet (confirmed on Ashby: the generic scraper returns 0 postings
even though the site clearly has openings), or when you already know
exactly which job you want.

Example:
  npx tsx src/index.ts \\
    --career-url "https://job-boards.greenhouse.io/attentive" \\
    --resume "./resume.docx" \\
    --criteria "./criteria.json"
`);
  process.exit(1);
}

interface CriteriaFile {
  titles?: string[];
  maxYearsExperience?: number;
  minSalaryAnnual?: number;
  minSalaryHourly?: number;
  requireFullTimeOrContractToHire?: boolean;
  acceptableLocations?: string[];
  minMatchScore?: number;
}

const args = parseArgs(process.argv.slice(2));
// --url lets a caller hand over a link without knowing which kind it is;
// it's classified against the live page below and routed accordingly.
const ambiguousUrl = args["url"];
let jobUrl = args["job-url"];
if (!args["resume"] || (!jobUrl && !ambiguousUrl && (!args["career-url"] || (!args["criteria"] && !args["titles"]))))
  usageAndExit();
if (!process.env.ANTHROPIC_API_KEY) {
  console.error("ANTHROPIC_API_KEY is not set. Add it to a .env file (see .env.example).");
  process.exit(1);
}

let careerUrl = args["career-url"];
const resumePath = args["resume"];
const outDir = path.resolve(args["out"] || "./out");
const MAX_CANDIDATES_TO_INSPECT = 8;

let fileCriteria: CriteriaFile = {};
if (args["criteria"]) {
  fileCriteria = JSON.parse(await readFile(path.resolve(args["criteria"]), "utf-8"));
}

const targetTitles = args["titles"]
  ? args["titles"].split(",").map((t) => t.trim()).filter(Boolean)
  : (fileCriteria.titles ?? []);
if (!jobUrl && targetTitles.length === 0) usageAndExit();

const criteria: Criteria = {
  targetTitles,
  maxYearsExperience: args["max-years"] ? Number(args["max-years"]) : fileCriteria.maxYearsExperience,
  minSalaryAnnual: args["min-salary-annual"] ? Number(args["min-salary-annual"]) : fileCriteria.minSalaryAnnual,
  minSalaryHourly: args["min-salary-hourly"] ? Number(args["min-salary-hourly"]) : fileCriteria.minSalaryHourly,
  requireFullTimeOrContractToHire:
    args["require-full-time-or-cth"] !== undefined
      ? args["require-full-time-or-cth"] === "true"
      : fileCriteria.requireFullTimeOrContractToHire,
  acceptableLocations: args["locations"]
    ? args["locations"].split(",").map((l) => l.trim()).filter(Boolean)
    : fileCriteria.acceptableLocations,
};
const minMatchScore = args["min-score"] ? Number(args["min-score"]) : (fileCriteria.minMatchScore ?? 0);

await mkdir(outDir, { recursive: true });

const anthropic = new Anthropic();

console.log(`Loading resume from ${resumePath}...`);
const resume = await loadResume(resumePath);
console.log(`  -> ${resume.name} <${resume.email}>`);

const personalContext = await loadPersonalContext(process.cwd());
const contextLoaded = [
  personalContext.profile.address && "user_profile.txt",
  personalContext.qaContext && "qa_context.txt",
  personalContext.workAuthContext && "work_auth_context.txt",
].filter(Boolean);
console.log(`  -> personal context loaded: ${contextLoaded.length ? contextLoaded.join(", ") : "none found (contact/screening-question fields will be left blank)"}`);

const headed = args["headed"] === "true";
// Persistent browser profile. A fresh context every run means every
// employer sees a brand-new anonymous browser, so any email/identity
// verification has to be repeated each time. Reusing one on-disk profile
// keeps cookies and local storage between runs, so a verification you
// complete once (e.g. an emailed code on an Oracle HCM Cloud tenant) is
// remembered on later runs against that same employer. It's an ordinary
// browser profile on your own machine - the same thing a real browser
// keeps - not a way around any check: the first verification still has to
// be done by hand.
// Disable with --no-profile to get the old throwaway-context behaviour.
const useProfile = args["no-profile"] !== "true";
// Default lives outside the project for the same reason the desktop shell's
// does: a Chromium profile is thousands of constantly-rewritten files, and
// the repo sits inside a synced OneDrive tree. An explicit --profile still
// wins, so the desktop app's per-slot paths are unaffected.
const defaultProfileRoot = process.env.LOCALAPPDATA
  ? path.join(process.env.LOCALAPPDATA, "Seekr", "profiles")
  : path.join(os.homedir(), ".seekr", "profiles");
const profileDir = path.resolve(args["profile"] || path.join(defaultProfileRoot, "browser-profile"));
// Chromium under CDP automation (which is what Playwright always is) sets
// navigator.webdriver = true by default - confirmed live via a direct check
// of this same launch config. That's the single most common signal
// bot-management checks (Cloudflare Turnstile included) key on, and it
// doesn't stop applying once control passes back to a human: a real person
// clicking a real "verify you're human" checkbox in this same window still
// does so inside a page that self-reports as automated, so the challenge
// can legitimately refuse a pass token regardless of who's actually
// clicking - confirmed live on a Workable posting behind Cloudflare, where
// the checkbox failed with a generic "Something went wrong" every time.
// This flag only suppresses that one flag; it does not touch any actual
// CAPTCHA-solving logic (there isn't any - see detectCaptcha) and won't
// necessarily satisfy every bot-management check some sites layer on top.
const launchArgs = ["--disable-blink-features=AutomationControlled"];

// --cdp-port makes a run one TAB of a shared browser rather than its own
// window, which is how the desktop app fills a queued batch. Measured on a
// synthetic ATS page: a second window costs ~407 MB, a second tab ~65 MB.
//
// The bigger reason isn't memory, though. Separate windows need separate
// profile directories - Chromium holds a SingletonLock on a user-data-dir
// for its window's whole lifetime, so two live windows cannot share one -
// and separate profiles mean a verification completed for one link isn't
// there for the next. Tabs share the host's profile, so the persistence
// this file goes out of its way to preserve keeps working across a batch.
//
// Every job runs the same logic: try to attach, and launch as the host if
// nothing is listening yet. Nobody is designated the host in advance, so a
// batch whose first link is a dead URL doesn't lose tab-sharing for every
// link behind it - whoever launches first simply becomes the host. Jobs are
// started strictly one at a time, so there's no race for that role.
//
// Without --cdp-port this is byte-for-byte the old behaviour: no attach is
// attempted and no debugging port is opened.
const cdpPort = Number(args["cdp-port"]) || 0;

async function openBrowser() {
  if (cdpPort) {
    try {
      const shared = await chromium.connectOverCDP(`http://127.0.0.1:${cdpPort}`, { timeout: 5000 });
      const ctx = shared.contexts()[0];
      if (ctx) {
        // No viewport is set here on purpose: a tab shares the host
        // window's dimensions, and forcing one would resize that window
        // out from under every other tab already open in it.
        return { context: ctx, page: await ctx.newPage(), attached: true };
      }
      // Connected but no context to put a tab in - unusable, so fall
      // through and host our own rather than proceeding half-attached.
    } catch {
      /* nothing listening yet (or it died) - we become the host below */
    }
  }
  // Fallback and first-run path alike. --profile matters here and only
  // here: an attached tab uses the host's profile, but a job that failed to
  // attach *cannot* use the host's directory even if it wanted to, because
  // that lock is exactly what it just failed to get past.
  if (cdpPort) launchArgs.push(`--remote-debugging-port=${cdpPort}`);
  const ctx = useProfile
    ? await chromium.launchPersistentContext(profileDir, { headless: !headed, viewport: { width: 1280, height: 900 }, args: launchArgs })
    : await (await chromium.launch({ headless: !headed, args: launchArgs })).newContext({ viewport: { width: 1280, height: 900 } });
  return { context: ctx, page: ctx.pages()[0] ?? (await ctx.newPage()), attached: false };
}

const { context, page, attached } = await openBrowser();
if (attached) console.log(`  -> attached to the shared browser on port ${cdpPort} (new tab, using its profile)`);
else if (useProfile) console.log(`  -> browser profile: ${profileDir} (verifications persist between runs)${cdpPort ? `, hosting the shared browser on port ${cdpPort}` : ""}`);

// Closing the context also closes its browser - which for an attached tab
// would take down the host and every other link's tab with it. An attached
// run therefore closes only its own page.
const browser = { close: attached ? async () => void (await page.close().catch(() => {})) : () => context.close() };

/**
 * Ends a run that cannot continue, capturing the page as it stands first.
 *
 * The --snapshot hook in the main flow fires only after openApplicationForm
 * succeeds, so every failure BEFORE that point produced no snapshot at all -
 * which is exactly when the page is most worth having. A Trillium Staffing
 * posting misclassified as a board left nothing to inspect but a log line;
 * diagnosing it needed the live site re-probed by hand, twice, because the
 * page it actually saw was gone.
 *
 * Captured under the same corpus root, so a failure can be replayed by the
 * regression harness the same way a filled form can.
 */
async function stopEarly(reason: string): Promise<void> {
  if (args["snapshot"]) {
    const title = await page.title().catch(() => "page");
    const dir = await captureFormSnapshot(page, args["snapshot"], ambiguousUrl || jobUrl || careerUrl || "", `${title} - ${reason}`);
    if (dir) console.log(`  -> page snapshot saved for reporting: ${dir}`);
  }
  await browser.close();
  process.exit(0);
}

try {
  // Work out what kind of link this is, so the caller doesn't have to.
  if (ambiguousUrl) {
    console.log(`\nInspecting the link...`);
    const verdict = await classifyUrl(page, ambiguousUrl);
    if (verdict.kind === "gone") {
      console.log(`  -> This posting is no longer listed (${verdict.reason}).`);
      console.log(`     The employer took it down - the link now lands on their careers board.`);
      console.log(`     Nothing was run. Your criteria are fine; this is a dead link, not a filter problem.`);
      await stopEarly("posting removed");
    }
    if (verdict.kind === "unknown") {
      console.log(`  -> This doesn't look like a job posting or a careers page (${verdict.reason}).`);
      console.log(`     Nothing was run. Check the link and try again.`);
      await stopEarly("unclassifiable link");
    }
    console.log(`  -> ${verdict.kind === "job" ? "a single job posting" : "a careers/listings page"} (${verdict.reason})`);
    if (verdict.kind === "job") jobUrl = ambiguousUrl;
    else careerUrl = ambiguousUrl;
  }

  let best: { job: CandidateJob; score: number; reasoning: string };

  if (jobUrl) {
    // Skips scraping/filtering/ranking entirely - for platforms whose
    // listing page isn't scrapable yet (confirmed on Ashby), or when the
    // job is already known. score/reasoning are synthetic (no ranking
    // happened) purely so this shares the same `best.job.*` shape the
    // rest of the pipeline below already expects.
    console.log(`\nFetching job posting: ${jobUrl}`);
    const { title, text } = await getJobDescription(page, jobUrl);
    console.log(`  -> ${title}`);
    best = { job: { title, url: jobUrl, location: "", descriptionText: text }, score: 100, reasoning: "direct --job-url, no ranking performed" };
  } else {
    console.log(`\nScraping career page: ${careerUrl}`);
    const allJobs = await listJobs(page, careerUrl!);
    console.log(`  -> found ${allJobs.length} postings`);

    const titleMatches = filterByTitle(allJobs, criteria);
    console.log(`  -> ${titleMatches.length} match target titles [${targetTitles.join(", ")}]`);
    if (titleMatches.length === 0) {
      console.log("No postings matched the target titles. Try broader keywords.");
      await stopEarly("no title matches");
    }

    const locationMatches = filterByLocation(titleMatches, criteria);
    if (criteria.acceptableLocations?.length) {
      console.log(
        `  -> ${locationMatches.length} pass the location filter [${criteria.acceptableLocations.join(", ")}] (${titleMatches.length - locationMatches.length} dropped for being tied to a specific non-matching place)`
      );
    }
    if (locationMatches.length === 0) {
      console.log("No postings survived the location filter.");
      await stopEarly("no location matches");
    }

    const candidates: CandidateJob[] = [];
    for (const job of locationMatches.slice(0, MAX_CANDIDATES_TO_INSPECT)) {
      const { text } = await getJobDescription(page, job.url);
      const hardCheck = passesHardRequirements(text, criteria);
      if (!hardCheck.pass) {
        console.log(`  skip "${job.title}": ${hardCheck.reason}`);
        continue;
      }
      candidates.push({ title: job.title, url: job.url, location: job.location, descriptionText: text });
    }

    if (candidates.length === 0) {
      console.log("No postings survived the hard-requirements filter.");
      await stopEarly("no candidates after hard requirements");
    }

    console.log(`\nAsking Claude to rank ${candidates.length} candidate posting(s) against the resume...`);
    const ranked = await rankJobs(anthropic, resume.text, candidates);
    for (const r of ranked) {
      console.log(`  [${r.score.toFixed(0)}] ${r.job.title} (${r.job.location}) - ${r.reasoning}`);
    }

    best = ranked[0];

    if (best.score < minMatchScore) {
      console.log(
        `\nBest candidate "${best.job.title}" scored ${best.score.toFixed(0)}, below the minimum match score of ${minMatchScore}.`
      );
      console.log(`No posting was a strong enough fit to fill out. Try different titles, or lower --min-score.`);
      await stopEarly("below minimum match score");
    }

    console.log(`\nBest match: "${best.job.title}" (score ${best.score.toFixed(0)})\n  ${best.job.url}`);
  }

  // Advisory soft-flag (never a skip): surface a stated non-Eastern
  // timezone/region preference before any resume is generated, so it can be
  // reviewed and the run aborted manually if it's a dealbreaker.
  const locPref = detectLocationPreference(best.job.descriptionText);
  if (locPref.flagged) {
    console.log(`\n! LOCATION/TIMEZONE SOFT-FLAG: this posting mentions ${locPref.matched.join(", ")}, which doesn't match your Atlanta / US-Eastern location.`);
    console.log(`  Context: "...${locPref.snippet}..."`);
    console.log(`  This is a soft-fit concern, NOT a hard requirement - review it before proceeding; the run continues either way.`);
  }

  let resumeToUpload = resumePath;
  if (resumePath.toLowerCase().endsWith(".docx")) {
    console.log(`\nTailoring resume to this role...`);
    try {
      const generated = await generateTailoredResume(
        anthropic,
        resumePath,
        best.job.descriptionText,
        best.job.title,
        resume.text,
        resume.name,
        outDir,
        personalContext.qaContext
      );
      if (!generated) {
        console.log(`  -> no bracketed+italicized placeholders detected in the resume template; using it as-is.`);
      } else if (generated.converged) {
        console.log(`  -> tailored resume saved (${generated.pageCount} page(s), matches the original): ${generated.path}`);
        resumeToUpload = generated.path;
      } else {
        console.log(
          `  -> WARNING: tailored resume saved but did NOT converge on the original page count after ${generated.attempts} attempt(s) - it rendered ${generated.pageCount} page(s) vs. the original's ${generated.originalPageCount}. Review it closely before using: ${generated.path}`
        );
        resumeToUpload = generated.path;
      }
    } catch (err) {
      console.log(`  -> WARNING: resume tailoring failed (${(err as Error).message}); using the original resume file instead.`);
    }
  }

  console.log(`\nOpening application form...`);
  await openApplicationForm(page, best.job.url);

  // Bank a frozen copy of the form for the regression corpus, if asked.
  // Placed here on purpose: the form is open but nothing has been filled, so
  // the capture is the blank form as served and carries none of the
  // candidate's data.
  if (args["snapshot"]) {
    const dir = await captureFormSnapshot(page, args["snapshot"], best.job.url, best.job.title);
    if (dir) console.log(`  -> snapshot saved to ${dir}`);
  }

  console.log(`Filling application using resume + job description...`);
  const report = await fillApplication(
    page,
    anthropic,
    resume,
    resumeToUpload,
    best.job.descriptionText,
    outDir,
    personalContext,
    best.job.title,
    {
      headed,
      // Pause (headed only) so a human can type a verification code the tool
      // can't read. Timeout so an unattended run can't hang forever.
      onPagePrompt: async (msg: string, timeoutMs: number) => {
        console.log(msg);
        const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
        await Promise.race([
          rl.question("\nPress Enter once you've entered it... "),
          new Promise((r) => setTimeout(r, timeoutMs)),
        ]);
        rl.close();
      },
    }
  );

  const groundTruth = report.filled.filter((f) => !f.generated);
  const generated = report.filled.filter((f) => f.generated && !f.lowConfidence);
  const lowConfidence = report.filled.filter((f) => f.lowConfidence);

  console.log(`\nFilled ${report.filled.length} field(s) from your resume/profile/context:`);
  for (const f of groundTruth) console.log(`  - ${f.label}: ${f.value}`);

  if (generated.length > 0) {
    console.log(`\n${generated.length} of those were AI-generated or AI-selected - review these carefully before submitting:`);
    for (const f of generated) console.log(`  - ${f.label}: ${f.value}`);
  }

  if (lowConfidence.length > 0) {
    console.log(`\n${lowConfidence.length} LOW-CONFIDENCE answer(s) - the AI had to extrapolate rather than answer from something concrete, double check these especially carefully:`);
    for (const f of lowConfidence) console.log(`  - ${f.label}: ${f.value}`);
  }

  const requiredSkipped = report.skipped.filter((s) => s.required);
  const optionalSkipped = report.skipped.filter((s) => !s.required);

  if (requiredSkipped.length > 0) {
    console.log(`\n${requiredSkipped.length} REQUIRED field(s) still need your input before this can be submitted:`);
    for (const s of requiredSkipped) console.log(`  - ${s.label}: ${s.reason}`);
  }
  if (optionalSkipped.length > 0) {
    console.log(`\n${optionalSkipped.length} optional field(s) left for manual review:`);
    for (const s of optionalSkipped) console.log(`  - ${s.label}: ${s.reason}`);
  }

  if (report.screenshots && report.screenshots.length > 1) {
    console.log(`\nScreenshots (one per page):`);
    for (const s of report.screenshots) console.log(`  - ${s}`);
  } else if (report.screenshotPath) {
    console.log(`\nScreenshot saved to: ${report.screenshotPath}`);
  } else {
    console.log(`\nNo screenshot was taken - the flow stopped before reaching a fillable page. Check the notes below.`);
  }

  if (report.notes?.length) {
    console.log(`\nFlow notes:`);
    for (const n of report.notes) console.log(`  ! ${n}`);
  }

  console.log(`\nThe application was NOT submitted.`);

  // Optional machine-readable copy of everything just printed. Purely
  // additive: the console output above is unchanged, and nothing in the
  // pipeline behaves differently when this flag is absent. Exists so a UI
  // wrapper can render structured results instead of scraping stdout.
  if (args["json-out"]) {
    await writeFile(
      path.resolve(args["json-out"]),
      JSON.stringify(
        {
          job: {
            title: best.job.title,
            url: best.job.url,
            location: best.job.location,
            score: best.score,
            reasoning: best.reasoning,
          },
          resumeUploaded: resumeToUpload,
          locationFlag: locPref.flagged ? { matched: locPref.matched, snippet: locPref.snippet } : null,
          filled: report.filled,
          skipped: report.skipped,
          screenshots: report.screenshots ?? (report.screenshotPath ? [report.screenshotPath] : []),
          notes: report.notes ?? [],
          submitted: false,
        },
        null,
        2
      )
    ).catch(() => {});
  }

  if (headed) {
    console.log(`Review the open browser window and submit manually if it looks right.`);
    const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
    await rl.question("\nPress Enter to close the browser...");
    rl.close();
  } else {
    console.log(`Ran headless - review the screenshot above, or re-run with --headed to watch/submit live.`);
  }
} finally {
  await browser.close();
}
