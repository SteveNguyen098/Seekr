// End-to-end check of the snapshot pipeline: capture -> record -> pass ->
// detect a regression. Uses fixtures as stand-in "real pages" so no live
// application or API call is needed, and a throwaway corpus so the real
// snapshots/ directory is never touched.
import { chromium } from "playwright";
import { execFileSync } from "node:child_process";
import { captureFormSnapshot } from "../src/snapshot.ts";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";

const CORPUS = path.join(os.tmpdir(), "seekr-snaptest-corpus");
fs.rmSync(CORPUS, { recursive: true, force: true });

const APPLY = "src/apply.ts";
const originalApply = fs.readFileSync(APPLY, "utf-8");

let failures = 0;
const check = (name, actual, expected) => {
  const ok = JSON.stringify(actual) === JSON.stringify(expected);
  if (!ok) failures++;
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}${ok ? "" : `\n        expected ${JSON.stringify(expected)}\n        actual   ${JSON.stringify(actual)}`}`);
};

const runSpec = (args = []) => {
  try {
    const out = execFileSync("npx", ["tsx", "test/snapshots.spec.mts", ...args], {
      encoding: "utf-8", stdio: "pipe", shell: true,
      env: { ...process.env, SEEKR_SNAPSHOT_DIR: CORPUS },
    });
    return { code: 0, out };
  } catch (e) {
    return { code: e.status ?? 1, out: `${e.stdout ?? ""}${e.stderr ?? ""}` };
  }
};

try {
  // ---- 1. capture, through the same helper the CLI calls -----------------
  const browser = await chromium.launch();
  const page = await browser.newPage({ viewport: { width: 1280, height: 900 } });
  const fixture = pathToFileURL(path.resolve("test/fixtures/custom-widget-shapes.html")).href;
  await page.goto(fixture, { waitUntil: "load" });
  const dir = await captureFormSnapshot(page, CORPUS, "https://jobs.example.com/postings/1234", "Senior Widget Wrangler");
  await page.close();
  await browser.close();

  check("capture returned a directory", typeof dir === "string" && dir.length > 0, true);
  check("slug built from host + title", path.basename(dir), "jobs-senior-widget-wrangler");
  check("page.mhtml written", fs.existsSync(path.join(dir, "page.mhtml")), true);
  check("meta.json written", fs.existsSync(path.join(dir, "meta.json")), true);
  const meta = JSON.parse(fs.readFileSync(path.join(dir, "meta.json"), "utf-8"));
  check("meta records the source url", meta.sourceUrl, "https://jobs.example.com/postings/1234");
  check("meta has a guards field to fill in", "guards" in meta, true);

  // ---- 2. first replay records the golden --------------------------------
  let r = runSpec();
  check("first replay records rather than passing", /RECORDED\s+4 field\(s\)/.test(r.out), true);
  check("recording exits green", r.code, 0);
  check("expected.json now exists", fs.existsSync(path.join(dir, "expected.json")), true);

  const golden = JSON.parse(fs.readFileSync(path.join(dir, "expected.json"), "utf-8"));
  check("golden captured all four fields", golden.length, 4);
  check("golden preserved the CSS/widget findings", golden.some((g) => g.isCombobox === true), true);
  check("golden stores selectorKind, not a volatile raw selector", golden.every((g) => ["name", "id", "marker"].includes(g.selectorKind)), true);
  check("golden kept harvested sibling-button options", golden.some((g) => JSON.stringify(g.options) === JSON.stringify(["Yes", "No"])), true);

  // ---- 3. second replay compares and passes ------------------------------
  r = runSpec();
  check("second replay passes against its golden", /PASS\s+4 field\(s\) unchanged/.test(r.out), true);
  check("passing exits green", r.code, 0);

  // ---- 4. a real regression is caught ------------------------------------
  fs.writeFileSync(APPLY, originalApply.replace("} else if (ariaHiddenAttr && !hasVisibleLabelPartner) {", "} else if (ariaHiddenAttr) {"));
  r = runSpec();
  fs.writeFileSync(APPLY, originalApply);
  check("a reintroduced bug fails the snapshot", r.code, 1);
  check("the diff names the changed property", /skipAlways: false -> true/.test(r.out), true);
  check("the diff names the affected field", /State|combobox|select/i.test(r.out), true);
  check("failure explains how to accept an intended change", /--update/.test(r.out), true);

  // ---- 5. --update re-records --------------------------------------------
  r = runSpec(["--update"]);
  check("--update re-records", /RECORDED/.test(r.out), true);
  check("--update exits green", r.code, 0);

  // ---- 6. empty corpus is not a failure ----------------------------------
  fs.rmSync(CORPUS, { recursive: true, force: true });
  r = runSpec();
  check("an empty corpus exits green, not red", r.code, 0);
  check("...and says how to capture one", /--snapshot \.\/snapshots/.test(r.out), true);
} finally {
  fs.writeFileSync(APPLY, originalApply);
  fs.rmSync(CORPUS, { recursive: true, force: true });
}

console.log(failures ? `\n${failures} FAILING` : "\nall green");
process.exit(failures ? 1 : 0);
