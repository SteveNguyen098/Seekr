/**
 * Does a run let the process END?
 *
 * A headless run once finished all its work - report written, screenshot
 * saved, last line printed - and then sat there until something killed it.
 * openBrowser had collapsed two ownership models into one expression:
 *
 *   useProfile ? launchPersistentContext(...) : (await launch(...)).newContext(...)
 *
 * A persistent context owns its browser, so closing the context closes the
 * process. A plain launch does not, and that form threw the Browser away
 * immediately - so closing the context left Chromium running, and with it
 * the pipes and ProcessWrap holding Node's event loop open.
 *
 * Nothing else here can see that. The fixtures and snapshots replay DOM and
 * the label specs are pure functions, so a leaked browser is invisible to
 * all of them.
 *
 * WHAT THIS DOES NOT DO, and why: the first version of this check spawned
 * the CLI against a local fixture and asserted it exited. It passed with
 * the bug deliberately reinstated. Every early-exit path calls
 * process.exit(), which force-exits whatever is still open - so the only
 * runs that can show the symptom are ones that complete normally, and
 * those cost a real application fill. Asserting on leftover HANDLES instead
 * reproduces the fault exactly, offline and in about a second.
 *
 *   npm run test:exit
 */
import os from "node:os";
import path from "node:path";
import fs from "node:fs";
import { openBrowser } from "../src/browser.js";

let pass = 0;
let fail = 0;

// Playwright's own plumbing: a child process and the pipes talking to it.
// These are precisely what a leaked browser leaves behind.
const browserHandles = () =>
  process.getActiveResourcesInfo().filter((r) => r === "ProcessWrap" || r === "PipeWrap");

const check = (name: string, condition: boolean, detail = "") => {
  condition ? pass++ : fail++;
  console.log(`  ${condition ? "PASS" : "FAIL"}  ${name}${condition || !detail ? "" : ` — ${detail}`}`);
};

console.log("a closed browser must leave nothing holding the event loop open\n");

// The shape that was broken. A plain launch's Browser is not owned by its
// context, so teardown has to close it explicitly.
{
  // Measured against this block's own starting point, so a leak in one
  // case cannot be reported as a failure of the next.
  const base = browserHandles().length;
  const b = await openBrowser({ headed: false, useProfile: false, profileDir: "", cdpPort: 0, launchArgs: [] });
  await b.page.goto("about:blank").catch(() => {});
  const live = browserHandles().length;
  await b.close();
  const left = browserHandles().length - base;
  check("a plain launch actually started a browser process", live > base, `handles while open: ${live}`);
  check("and leaves none behind once closed", left === 0, `${left} still open: ${browserHandles().join(", ")}`);
}

// The shape that was always fine - so a regression in EITHER is caught, not
// just the one that happened to break.
{
  const base = browserHandles().length;
  const dir = path.join(os.tmpdir(), `seekr-exit-check-${Date.now()}`);
  const b = await openBrowser({ headed: false, useProfile: true, profileDir: dir, cdpPort: 0, launchArgs: [] });
  await b.page.goto("about:blank").catch(() => {});
  await b.close();
  const left = browserHandles().length - base;
  check("a persistent context leaves none behind either", left === 0, `${left} still open: ${browserHandles().join(", ")}`);
  fs.rmSync(dir, { recursive: true, force: true });
}

console.log(`\n${"-".repeat(70)}`);
console.log(fail ? `${pass} passed, ${fail} FAILED` : `${pass} passed, 0 failed - a closed browser stops holding the process open`);
process.exit(fail ? 1 : 0);
