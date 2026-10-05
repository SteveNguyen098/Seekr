/**
 * Drives the REAL Electron app through a board scan.
 *
 * The seam this covers - renderer -> preload -> main -> spawned CLI -> JSON
 * -> back to the renderer - is invisible to every other harness here. The
 * fixtures and snapshots replay DOM, the label specs are pure functions,
 * and the board-scan UI was previously only ever exercised against a
 * stubbed window.seekr. A bug in the IPC wiring would have shipped unseen.
 *
 * Opt-in, like test:pipeline: it launches a real browser, hits a real
 * board, and spends real API calls, so it has no business in `npm test`.
 *
 *   npm run test:electron
 *
 * Asserts on the SHAPE of what comes back, never on which jobs a board
 * happens to list - postings appear and disappear daily, and a smoke test
 * that fails because a company closed a role teaches nothing. A board with
 * nothing suitable on it is a pass, as long as it says so rather than
 * breaking.
 */
import { _electron as electron } from "playwright";
import path from "node:path";

const APP = path.resolve(import.meta.dirname, "..", "..", "desktop");
// Electron lives in the desktop app's own node_modules, not this package's.
const EXE = path.resolve(APP, "node_modules", "electron", "dist", "electron.exe");
const BOARD = process.env.SEEKR_SMOKE_BOARD || "https://jobs.ashbyhq.com/hoyoverse";
const SCAN_TIMEOUT_MS = 480000;

let pass = 0;
let fail = 0;
const ok = (name: string, condition: boolean, detail = "") => {
  condition ? pass++ : fail++;
  console.log(`  ${condition ? "PASS" : "FAIL"}  ${name}${condition || !detail ? "" : ` — ${detail}`}`);
};

console.log(`Launching ${APP}\nBoard: ${BOARD}\n`);
const app = await electron.launch({ args: [APP], executablePath: EXE });
const win = await app.firstWindow();
await win.waitForLoadState("domcontentloaded");

// Anything either process complains about is a failure in its own right.
const problems: string[] = [];
win.on("console", (m) => { if (m.type() === "error") problems.push("renderer: " + m.text().slice(0, 140)); });
win.on("pageerror", (e) => problems.push("pageerror: " + String(e).slice(0, 140)));
app.process().stderr?.on("data", (b) => { const t = b.toString().trim(); if (t) problems.push("main: " + t.slice(0, 140)); });

try {
  console.log("window");
  ok("the app opens a window titled Seekr", (await win.title()) === "Seekr");

  await win.waitForTimeout(1500);
  const settings = await win.evaluate(() => ({
    cap: document.getElementById("maxLinks")?.textContent,
    resumeSet: !/none set/i.test(document.getElementById("resume")?.textContent || ""),
    hasScan: !!document.getElementById("scan"),
  }));
  console.log("\nget-settings round-trip");
  ok("the link cap came from main, not the renderer's fallback", !!settings.cap && Number(settings.cap) > 0, String(settings.cap));
  ok("a resume template is configured", settings.resumeSet);
  ok("the board scan controls are present", settings.hasScan);

  console.log("\nscan-board round-trip (real scan, this takes a few minutes)");
  await win.fill("#boardUrl", BOARD);
  await win.click("#scan");
  await win.waitForFunction(
    () =>
      document.querySelectorAll(".suggestRow").length > 0 ||
      /didn't finish|Nothing on this board/i.test(document.getElementById("suggestNote")?.textContent || ""),
    undefined,
    { timeout: SCAN_TIMEOUT_MS }
  );

  const r = await win.evaluate(() => ({
    rows: document.querySelectorAll(".suggestRow").length,
    note: document.getElementById("suggestNote")?.textContent || "",
    meta: document.getElementById("suggestMeta")?.textContent || "",
    scanReenabled: !(document.getElementById("scan") as HTMLButtonElement)?.disabled,
    logGotOutput: /Triaging|found \d+ postings/i.test(document.getElementById("log")?.textContent || ""),
    everyRowHasScoreAndButton: [...document.querySelectorAll(".suggestRow")].every(
      (row) => !!row.querySelector(".suggestScore")?.textContent && !!row.querySelector("button")
    ),
  }));
  const broke = /didn't finish/i.test(r.note);
  ok("the scan finished rather than erroring", !broke, r.note.slice(0, 90));
  ok("the CLI's output reached the log pane", r.logGotOutput);
  ok("the scan button was re-enabled afterwards", r.scanReenabled);
  ok("the summary reports what was scanned", /scanned/.test(r.meta) || r.rows === 0, r.meta);
  if (r.rows > 0) {
    ok("every row carries a score and an Add button", r.everyRowHasScoreAndButton);
    console.log(`        (${r.rows} suggestion(s), ${r.meta})`);

    console.log("\nqueueing a suggestion");
    await win.click(".suggestRow button");
    const q = await win.evaluate(() => ({
      queued: [...document.querySelectorAll("#links input")].map((i) => (i as HTMLInputElement).value).filter(Boolean),
      disabled: (document.querySelector(".suggestRow button") as HTMLButtonElement)?.disabled,
    }));
    ok("the posting's URL landed in the run queue", q.queued.length === 1 && /^https?:/.test(q.queued[0]), JSON.stringify(q.queued));
    ok("the button disabled itself so it cannot be queued twice", q.disabled);
  } else {
    console.log(`        (no suggestions - treated as a pass: ${r.note.slice(0, 70)})`);
  }
} finally {
  console.log("\nprocess errors");
  ok("neither process reported an error", problems.length === 0, problems.slice(0, 4).join(" | "));
  await app.close();
}

console.log(`\n${"-".repeat(70)}`);
console.log(fail ? `${pass} passed, ${fail} FAILED` : `${pass} passed, 0 failed - the shell's IPC seam still works end to end`);
process.exit(fail ? 1 : 0);
