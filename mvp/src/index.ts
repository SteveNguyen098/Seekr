import "dotenv/config";
import { chromium } from "playwright";
import Anthropic from "@anthropic-ai/sdk";
import readline from "node:readline/promises";
import path from "node:path";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { loadResume } from "./resume.js";
import { listJobs, getJobDescription, classifyUrl } from "./scrape.js";
import { filterByTitle, filterByLocation, passesHardRequirements, detectLocationPreference, type Criteria } from "./filter.js";
import { rankJobs, type CandidateJob } from "./match.js";
import { openApplicationForm, fillApplication } from "./apply.js";
import { loadPersonalContext } from "./context.js";
import { generateTailoredResume } from "./resumeGenerator.js";

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
const profileDir = path.resolve(args["profile"] || "./.browser-profile");
const context = useProfile
  ? await chromium.launchPersistentContext(profileDir, { headless: !headed, viewport: { width: 1280, height: 900 } })
  : await (await chromium.launch({ headless: !headed })).newContext({ viewport: { width: 1280, height: 900 } });
const page = context.pages()[0] ?? (await context.newPage());
if (useProfile) console.log(`  -> browser profile: ${profileDir} (verifications persist between runs)`);
// Closing the context also closes its browser in both modes.
const browser = { close: () => context.close() };

try {
  // Work out what kind of link this is, so the caller doesn't have to.
  if (ambiguousUrl) {
    console.log(`\nInspecting the link...`);
    const verdict = await classifyUrl(page, ambiguousUrl);
    if (verdict.kind === "unknown") {
      console.log(`  -> This doesn't look like a job posting or a careers page (${verdict.reason}).`);
      console.log(`     Nothing was run. Check the link and try again.`);
      await browser.close();
      process.exit(0);
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
      await browser.close();
      process.exit(0);
    }

    const locationMatches = filterByLocation(titleMatches, criteria);
    if (criteria.acceptableLocations?.length) {
      console.log(
        `  -> ${locationMatches.length} pass the location filter [${criteria.acceptableLocations.join(", ")}] (${titleMatches.length - locationMatches.length} dropped for being tied to a specific non-matching place)`
      );
    }
    if (locationMatches.length === 0) {
      console.log("No postings survived the location filter.");
      await browser.close();
      process.exit(0);
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
      await browser.close();
      process.exit(0);
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
      await browser.close();
      process.exit(0);
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
  } else {
    console.log(`\nScreenshot saved to: ${report.screenshotPath}`);
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
          screenshots: report.screenshots ?? [report.screenshotPath],
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
