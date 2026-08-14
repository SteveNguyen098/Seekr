/**
 * Replays the scanner against frozen captures of REAL application forms.
 *
 * The complement to fixtures.spec.mts, not a replacement. Fixtures encode our
 * model of a bug - cheap, readable, but only as correct as the reconstruction.
 * These are the actual DOM that actually shipped, including whatever weirdness
 * nobody would think to reproduce.
 *
 * Capture one by adding --snapshot ./snapshots to any real run:
 *   npx tsx src/index.ts --url <posting> --resume <r.docx> --snapshot ./snapshots
 *
 * First replay of a new snapshot RECORDS its golden (expected.json) and
 * reports it as recorded, not passed - a golden nobody has read is not a test.
 * Open it, check the labels and skips are what the form actually asks, then
 * commit the judgement by leaving it in place.
 *
 *   npm run test:snapshots
 *   npm run test:snapshots -- --update    # re-record after an INTENDED change
 *
 * Goldens deliberately store selectorKind ("name" | "id" | "marker") rather
 * than the raw selector: platforms that regenerate ids would otherwise make
 * every re-capture a spurious diff, while the property actually worth pinning
 * is that a stable `name` still wins over a volatile id.
 */
import { chromium } from "playwright";
import { findFormContext, discoverFields, type DiscoveredField } from "../src/apply.js";
import fs from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";

// Overridable so the harness itself can be exercised against a throwaway
// corpus without touching the real one.
const ROOT = process.env.SEEKR_SNAPSHOT_DIR
  ? path.resolve(process.env.SEEKR_SNAPSHOT_DIR)
  : path.resolve(import.meta.dirname, "..", "snapshots");
const update = process.argv.includes("--update");

interface Golden {
  label: string;
  type: string;
  required: boolean;
  isCombobox: boolean;
  multiSelect: boolean;
  skipAlways: boolean;
  skipReason: string;
  groupQuestion: string;
  options: string[];
  selectorKind: "name" | "id" | "marker";
}

const project = (f: DiscoveredField): Golden => ({
  label: f.label,
  type: f.type,
  required: f.required,
  isCombobox: f.isCombobox,
  multiSelect: f.multiSelect,
  skipAlways: f.skipAlways,
  skipReason: f.skipReason,
  groupQuestion: f.groupQuestion,
  options: f.options,
  selectorKind: f.selector.startsWith("[name=") ? "name" : f.selector.startsWith("[data-seekr-field") ? "marker" : "id",
});

if (!fs.existsSync(ROOT)) {
  console.log(`No snapshots yet (${path.relative(process.cwd(), ROOT)} does not exist).`);
  console.log(`Capture one by adding --snapshot ./snapshots to a real run.`);
  process.exit(0);
}

const dirs = fs
  .readdirSync(ROOT, { withFileTypes: true })
  .filter((d) => d.isDirectory() && fs.existsSync(path.join(ROOT, d.name, "page.mhtml")))
  .map((d) => d.name);

if (dirs.length === 0) {
  console.log(`No snapshots yet. Capture one by adding --snapshot ./snapshots to a real run.`);
  process.exit(0);
}

const browser = await chromium.launch();
let passed = 0;
let failed = 0;
let recorded = 0;

for (const name of dirs) {
  const dir = path.join(ROOT, name);
  const goldenPath = path.join(dir, "expected.json");
  const meta = readJson(path.join(dir, "meta.json"));

  const page = await browser.newPage({ viewport: { width: 1280, height: 900 } });
  let actual: Golden[] = [];
  let error = "";
  try {
    await page.goto(pathToFileURL(path.join(dir, "page.mhtml")).href, { waitUntil: "load" });
    const ctx = await findFormContext(page);
    actual = (await discoverFields(ctx)).map(project);
  } catch (err) {
    error = (err as Error).message.split("\n")[0];
  } finally {
    await page.close();
  }

  const header = `\n${name}${meta?.guards ? `\n  guards: ${meta.guards}` : ""}${meta?.formUrl ? `\n  from:   ${meta.formUrl}` : ""}`;

  if (error) {
    failed++;
    console.log(`${header}\n    FAIL  snapshot could not be replayed: ${error}`);
    continue;
  }

  if (!fs.existsSync(goldenPath) || update) {
    fs.writeFileSync(goldenPath, JSON.stringify(actual, null, 2) + "\n");
    recorded++;
    console.log(`${header}\n    RECORDED  ${actual.length} field(s) -> expected.json  (read it and confirm it matches the real form)`);
    continue;
  }

  const expected: Golden[] = readJson(goldenPath) ?? [];
  const diffs = diff(expected, actual);
  if (diffs.length === 0) {
    passed++;
    console.log(`${header}\n    PASS  ${actual.length} field(s) unchanged`);
  } else {
    failed++;
    console.log(`${header}\n    FAIL  ${diffs.length} difference(s):`);
    for (const d of diffs.slice(0, 12)) console.log(`      ${d}`);
    if (diffs.length > 12) console.log(`      ... and ${diffs.length - 12} more`);
    console.log(`      (if this change was intended: npm run test:snapshots -- --update)`);
  }
}

await browser.close();

console.log(`\n${"-".repeat(70)}`);
const parts = [`${passed} passed`, failed ? `${failed} FAILED` : null, recorded ? `${recorded} newly recorded` : null].filter(Boolean);
console.log(parts.join(", "));
process.exit(failed ? 1 : 0);

// ---------------------------------------------------------------------------

function readJson(p: string) {
  try {
    return JSON.parse(fs.readFileSync(p, "utf-8"));
  } catch {
    return null;
  }
}

/** Field-by-field, so a report names the question that changed. */
function diff(expected: Golden[], actual: Golden[]): string[] {
  const out: string[] = [];
  if (expected.length !== actual.length) {
    out.push(`field count ${expected.length} -> ${actual.length}`);
  }
  const n = Math.max(expected.length, actual.length);
  for (let i = 0; i < n; i++) {
    const e = expected[i];
    const a = actual[i];
    if (!e) {
      out.push(`[${i}] appeared: "${a.label}" (${a.type})`);
      continue;
    }
    if (!a) {
      out.push(`[${i}] disappeared: "${e.label}" (${e.type})`);
      continue;
    }
    for (const k of Object.keys(e) as (keyof Golden)[]) {
      const ev = JSON.stringify(e[k]);
      const av = JSON.stringify(a[k]);
      if (ev !== av) out.push(`[${i}] "${e.label || e.type}" ${k}: ${ev} -> ${av}`);
    }
  }
  return out;
}
