/**
 * Regression harness for classifyUrl(), the gate every run passes through
 * before anything else happens.
 *
 * Offline, like the field fixtures next door: the redirect a dead posting
 * performs is reproduced with location.replace() against local files, so
 * this needs no network and cannot rot when an employer edits a page.
 *
 *   npm run test:classify
 */
import { chromium } from "playwright";
import { boardPageUrl, classifyUrl, listJobs } from "../src/scrape.js";
import path from "node:path";
import { pathToFileURL } from "node:url";

const FIX = path.resolve(import.meta.dirname, "fixtures", "classify");
const url = (rel: string) => pathToFileURL(path.join(FIX, rel)).href;

interface Case {
  name: string;
  guards: string;
  rel: string;
  expect: "job" | "board" | "gone" | "unknown";
  reasonMatches?: RegExp;
}

const CASES: Case[] = [
  {
    name: "dead posting redirects to a board",
    guards: "a removed job was reported as 'no postings matched the target titles'",
    rel: "jobs/dead-12345.html",
    expect: "gone",
    reasonMatches: /redirected to/i,
  },
  {
    name: "live posting at a posting-shaped path",
    // Note what this does NOT guard: with no sibling links it exits at the
    // "form + description -> job" branch and never consults deadPosting, so
    // it stays green even if the redirect requirement is removed entirely.
    // careers/engineering.html below is what covers that.
    guards: "an ordinary posting still classifying as a job",
    rel: "jobs/live-67890.html",
    expect: "job",
  },
  {
    name: "board requested directly",
    guards: "the dead-posting rule keying on the redirect, not the destination alone",
    rel: "board.html",
    expect: "board",
  },
  {
    name: "live posting that also lists sibling jobs",
    guards: "a real posting with an 'other jobs' sidebar being scraped as a board (Trillium)",
    rel: "jobs/posting-with-sidebar.html",
    expect: "job",
  },
  {
    name: "board carrying a job-alert signup form",
    guards: "the posting rule keying on the Apply affordance, not on form presence",
    rel: "board-with-signup-form.html",
    expect: "board",
  },
  {
    name: "Ashby posting that links only to itself and its own apply page",
    guards: "a single posting read as a board because its own url and its own Apply button looked like two sibling jobs",
    rel: "ashby/5da60843-8dc5-4da2-a7b3-2dd37314f87f/index.html",
    expect: "job",
    reasonMatches: /opaque posting id/i,
  },
  {
    name: "the apply form itself, linked to directly",
    guards: "a bare application form classified 'unknown' - too little prose for the description rule, and 'Submit Application' contains no 'Apply'",
    rel: "ashby/5da60843-8dc5-4da2-a7b3-2dd37314f87f/application/index.html",
    expect: "job",
    reasonMatches: /application form/i,
  },
  {
    name: "posting linking to itself six times",
    guards: "the >= 5 board threshold being tripped by a posting's own repeated Apply and share links",
    rel: "ashby/7c1e4a90-1111-2222-3333-444455556666/index.html",
    expect: "job",
  },
  {
    name: "board whose own url carries an id",
    guards: "the id-based self-link rule over-excluding - the first version keyed on sub-paths and took every posting on a Greenhouse board with it",
    rel: "boards/998877/index.html",
    expect: "board",
  },
  {
    name: "board at a posting-shaped path, no redirect",
    guards: "the redirect half of the rule - a listing at /careers/<slug> is not a removed job",
    rel: "careers/engineering.html",
    expect: "board",
  },
];

// Optional substring filter, so mutation-check can run the single case that
// guards the rule it just broke.
const filter = process.argv[2];

const browser = await chromium.launch();
let passed = 0;
let failed = 0;

for (const c of CASES) {
  if (filter && !c.rel.includes(filter)) continue;
  const page = await browser.newPage({ viewport: { width: 1280, height: 900 } });
  let got: Awaited<ReturnType<typeof classifyUrl>> | null = null;
  let err = "";
  try {
    got = await classifyUrl(page, url(c.rel));
  } catch (e) {
    err = (e as Error).message.split("\n")[0];
  }
  await page.close();

  console.log(`\n${c.rel}\n  guards: ${c.guards}`);
  if (err) {
    failed++;
    console.log(`    FAIL  threw: ${err}`);
    continue;
  }
  const kindOk = got!.kind === c.expect;
  kindOk ? passed++ : failed++;
  console.log(kindOk ? `    PASS  classified as "${c.expect}"` : `    FAIL  expected "${c.expect}", got "${got!.kind}" — ${got!.reason}`);

  if (c.reasonMatches) {
    const reasonOk = c.reasonMatches.test(got!.reason);
    reasonOk ? passed++ : failed++;
    console.log(reasonOk ? `    PASS  reason says why: ${got!.reason}` : `    FAIL  reason did not match ${c.reasonMatches} — got "${got!.reason}"`);
  }
}

// listJobs on a board whose postings are named by opaque ids only. Ashby's
// shape, reproduced structurally - nothing here depends on the hostname,
// which is also how the fix is keyed.
{
  console.log("\nlistJobs - opaque-id board");
  const page = await browser.newPage({ viewport: { width: 1280, height: 900 } });
  const jobs = await listJobs(page, url("opaque-board/index.html"));
  await page.close();

  const checks: [string, boolean, string][] = [
    ["all four postings found", jobs.length === 4, `got ${jobs.length}`],
    ["titles come from the heading, not the whole card", jobs.every((j) => !/Full time/.test(j.title)), jobs[0]?.title ?? ""],
    ["location is the second field, not the department", jobs[0]?.location === "Los Angeles", jobs[0]?.location ?? ""],
    ["every posting has a location", jobs.every((j) => !!j.location.trim()), ""],
    ["the id-less 'About us' link was not counted", jobs.every((j) => !/board\.html/.test(j.url)), ""],
  ];
  for (const [name, ok, detail] of checks) {
    ok ? passed++ : failed++;
    console.log(`  ${ok ? "PASS" : "FAIL"}  ${name}${ok ? "" : ` — ${detail}`}`);
  }
}

await browser.close();

// boardPageUrl: pure, and the silent half of board pagination. Appending
// instead of replacing yields "?page=1&page=2", which most servers resolve
// to the FIRST value - so every request returns page 1, the walk stops
// after one page, and the board looks like it only had 50 jobs.
console.log("\nboardPageUrl");
const PAGE_URLS: [string, number, string, string][] = [
  [
    "https://job-boards.greenhouse.io/x?gh_src=abc&page=1",
    3,
    "https://job-boards.greenhouse.io/x?gh_src=abc&page=3",
    "THE BUG: a copied board URL already carries page=1 - it must be replaced, not appended",
  ],
  ["https://job-boards.greenhouse.io/x?gh_src=abc", 2, "https://job-boards.greenhouse.io/x?gh_src=abc&page=2", "other query params survive - some boards scope results by them"],
  ["https://job-boards.greenhouse.io/x", 1, "https://job-boards.greenhouse.io/x?page=1", "no query string at all"],
  ["https://job-boards.greenhouse.io/x?page=7&page=9", 2, "https://job-boards.greenhouse.io/x?page=2", "duplicates already present collapse to one"],
];
for (const [input, n, want, guards] of PAGE_URLS) {
  const got = boardPageUrl(input, n);
  const ok = got === want && new URL(got).searchParams.getAll("page").length === 1;
  ok ? passed++ : failed++;
  console.log(`  ${ok ? "PASS" : "FAIL"}  page ${n}: ${got}`);
  if (!ok) console.log(`        expected ${want} - ${guards}`);
}

console.log(`\n${"-".repeat(70)}`);
console.log(failed ? `${passed} passed, ${failed} FAILED` : `${passed} passed, 0 failed - a dead posting is still told apart from a board`);
process.exit(failed ? 1 : 0);
