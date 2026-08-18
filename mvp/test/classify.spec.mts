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
import { classifyUrl } from "../src/scrape.js";
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
    console.log(reasonOk ? `    PASS  reason explains the redirect` : `    FAIL  reason did not match ${c.reasonMatches} — got "${got!.reason}"`);
  }
}

await browser.close();
console.log(`\n${"-".repeat(70)}`);
console.log(failed ? `${passed} passed, ${failed} FAILED` : `${passed} passed, 0 failed - a dead posting is still told apart from a board`);
process.exit(failed ? 1 : 0);
