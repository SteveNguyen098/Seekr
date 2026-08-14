// Closes the one gap left: does index.ts actually CALL captureFormSnapshot
// when --snapshot is present? That join only runs after openApplicationForm,
// so it can't be unit-tested - but it can be reached without a live posting.
//
// A .txt resume makes the tailoring step throw early inside its own
// try/catch (it expects .docx), so the run warns and continues with no
// Anthropic call. --job-url skips scraping/ranking. The snapshot fires
// BEFORE fillApplication, so we kill the moment it lands and never reach the
// part that would spend tokens. Throwaway browser (--no-profile) and temp
// dirs throughout, so nothing real is touched.
import { spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";

const TMP = path.join(os.tmpdir(), "seekr-joincheck");
fs.rmSync(TMP, { recursive: true, force: true });
fs.mkdirSync(TMP, { recursive: true });

const resume = path.join(TMP, "resume.txt");
fs.writeFileSync(resume, "Test Candidate\ntest.candidate@example.com\n(404) 555-0100\nAtlanta, GA\n\nEXPERIENCE\nDid things.\n");

const snapDir = path.join(TMP, "snapshots");
const jobUrl = pathToFileURL(path.resolve("test/fixtures/custom-widget-shapes.html")).href;

const args = [
  "node_modules/tsx/dist/cli.mjs", "src/index.ts",
  "--job-url", jobUrl,
  "--resume", resume,
  "--out", path.join(TMP, "out"),
  "--snapshot", snapDir,
  "--no-profile", "true",
];

console.log(`running: tsx src/index.ts --job-url <fixture> --snapshot <tmp> --no-profile\n`);

const child = spawn("node", args, { cwd: process.cwd(), env: { ...process.env, FORCE_COLOR: "0" } });

let out = "";
let killed = false;
const done = new Promise((resolve) => {
  const onData = (b) => {
    const s = b.toString();
    out += s;
    process.stdout.write(s.split("\n").map((l) => (l.trim() ? `   | ${l}` : "")).join("\n"));
    // The moment the snapshot lands, stop - everything after this costs money.
    if (/snapshot saved to/i.test(out) && !killed) {
      killed = true;
      setTimeout(() => { try { child.kill("SIGKILL"); } catch {} }, 200);
    }
  };
  child.stdout.on("data", onData);
  child.stderr.on("data", onData);
  child.on("close", () => resolve());
  setTimeout(() => { try { child.kill("SIGKILL"); } catch {} }, 90000);
});

await done;

let failures = 0;
const check = (name, cond, detail = "") => {
  if (!cond) failures++;
  console.log(`\n${cond ? "PASS" : "FAIL"}  ${name}${cond || !detail ? "" : `\n        ${detail}`}`);
};

check("the CLI reached and announced the snapshot", /snapshot saved to/i.test(out), out.slice(-400));

const dirs = fs.existsSync(snapDir) ? fs.readdirSync(snapDir) : [];
check("a snapshot directory was created", dirs.length === 1, `found: ${JSON.stringify(dirs)}`);

if (dirs.length === 1) {
  const d = path.join(snapDir, dirs[0]);
  const mhtml = path.join(d, "page.mhtml");
  const meta = path.join(d, "meta.json");
  check("page.mhtml written", fs.existsSync(mhtml));
  check("meta.json written", fs.existsSync(meta));
  if (fs.existsSync(mhtml)) {
    const size = fs.statSync(mhtml).size;
    // Chromium writes "From: <Saved by Blink>" and Snapshot-Content-Location
    // ahead of the MIME headers, so this has to look past the first line.
    const head = fs.readFileSync(mhtml, "utf-8").slice(0, 1500);
    check(
      "the capture is real MHTML",
      /Saved by Blink/.test(head) && /MIME-Version/i.test(head) && /Content-Type:\s*multipart\/related/i.test(head),
      head.slice(0, 300)
    );
    check("the frozen DOM is in there", /<select|role="combobox"|type="tel"/i.test(fs.readFileSync(mhtml, "utf-8")));
    console.log(`        (${(size / 1024).toFixed(1)} KB, slug "${dirs[0]}")`);
  }
  if (fs.existsSync(meta)) {
    const m = JSON.parse(fs.readFileSync(meta, "utf-8"));
    check("meta records the source url", m.sourceUrl === jobUrl);
  }
  check("no resume was written, so we stopped before the paid work", !fs.existsSync(path.join(TMP, "out")) || fs.readdirSync(path.join(TMP, "out")).filter((f) => f.endsWith(".docx")).length === 0);
}

fs.rmSync(TMP, { recursive: true, force: true });
console.log(failures ? `\n${failures} FAILING` : "\nall green - the index.ts -> snapshot.ts join works");
process.exit(failures ? 1 : 0);
