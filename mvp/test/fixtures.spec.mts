/**
 * Regression harness for the form scanner.
 *
 * Replays findFormContext() + discoverFields() - the real ones, unmodified -
 * against a corpus of synthetic pages in ./fixtures, each reproducing the DOM
 * shape of a bug that actually shipped. Every assertion is named after the
 * bug it protects, so a failure says what broke rather than printing a diff.
 *
 * These fixtures encode our MODEL of each bug, not the original page. That
 * makes them cheap, readable, employer-content-free and rot-proof, at the cost
 * of fidelity: a fixture can pass for the wrong reason if the reconstruction
 * is wrong. Snapshot replay of real captured pages is the complement, not a
 * replacement.
 *
 *   npm test
 *   npm test -- paycom          # run only matching fixtures
 */
import { chromium, type Browser } from "playwright";
import { findFormContext, discoverFields, type DiscoveredField } from "../src/apply.js";
import path from "node:path";
import { pathToFileURL } from "node:url";

type Ctx = Awaited<ReturnType<typeof findFormContext>>;

interface T {
  is(name: string, actual: unknown, expected: unknown): void;
  ok(name: string, condition: boolean): void;
}

interface Case {
  file: string;
  /** The bug this exists to prevent coming back. */
  bug: string;
  check(fields: DiscoveredField[], t: T, ctx: Ctx): void | Promise<void>;
}

const byName = (fields: DiscoveredField[], name: string) => fields.filter((f) => f.groupName === name || f.idOrName.split(/\s+/).includes(name));
const one = (fields: DiscoveredField[], name: string) => byName(fields, name)[0];
const looksLikeCss = (s: string) => /[{}]|text-decoration|font-size|:hover/.test(s);

const CASES: Case[] = [
  {
    file: "paycom-style-block-as-label.html",
    bug: "a <style> block was handed to Claude as the question text",
    check(fields, t) {
      const contains = one(fields, "q_contains_style");
      const isStyle = one(fields, "q_is_style");
      t.is("label comes from the sibling's real text, not its <style>", contains?.label, "What is your preferred contact method?");
      t.ok("no label contains CSS", fields.every((f) => !looksLikeCss(f.label)));
      t.ok("a <style> sibling never becomes the label", !looksLikeCss(isStyle?.label ?? ""));
    },
  },
  {
    file: "bamboohr-fieldset-legend.html",
    bug: "every radio question inherited the previous question's text",
    check(fields, t) {
      const office = byName(fields, "office_days");
      const referred = byName(fields, "referred");
      t.ok("both radio groups discovered", office.length === 2 && referred.length === 2);
      t.ok("first group reads its own <legend>", /office/i.test(office[0]?.groupQuestion ?? ""));
      t.ok("second group reads its own <legend>", /referred/i.test(referred[0]?.groupQuestion ?? ""));
      t.ok("second group did NOT inherit the first's text", !/office/i.test(referred[0]?.groupQuestion ?? ""));
      t.ok("group question differs from the option's own label", referred[0]?.groupQuestion !== referred[0]?.label);
    },
  },
  {
    file: "kforce-consent-panel.html",
    bug: "the cookie consent centre was mistaken for the application form",
    check(fields, t) {
      const consent = fields.filter((f) => /^ot-/.test(f.idOrName));
      t.ok("all consent controls found", consent.length === 3);
      t.ok("every consent control is skipped", consent.every((f) => f.skipAlways));
      t.ok("skip reason names the consent manager", consent.every((f) => /consent/i.test(f.skipReason)));
      t.is("the real email field survives", one(fields, "email")?.skipAlways, false);
      t.is("a question merely mentioning cookies survives", one(fields, "cookie_policy_ack")?.skipAlways, false);
    },
  },
  {
    file: "ashby-css-only-asterisk.html",
    bug: "a required field marked only by label::after content was reported optional",
    check(fields, t) {
      const loc = one(fields, "current_location");
      t.is("CSS-painted asterisk marks the field required", loc?.required, true);
      t.is("the asterisk does not leak into the label text", loc?.label, "Current Location");
      t.is("a field with no asterisk rule stays optional", one(fields, "linkedin_url")?.required, false);
    },
  },
  {
    file: "workable-stale-id-selector.html",
    bug: "a captured #id selector stopped resolving after a re-render",
    check(fields, t) {
      t.is("a unique name beats a regenerated id", one(fields, "city.value")?.selector, '[name="city.value"]');
      const state = fields.find((f) => f.idOrName === "FabricTextField-380");
      t.is("id is used when there is no name", state?.selector, "#FabricTextField-380");
      const postal = fields.find((f) => /postal/i.test(f.label));
      t.ok("no name and no id falls back to the synthetic marker", !!postal?.selector.startsWith('[data-seekr-field='));
      const radios = byName(fields, "sponsorship");
      t.ok("a shared radio name is NOT collapsed into one selector", radios.every((f) => f.selector !== '[name="sponsorship"]'));
      t.ok("radio selectors are unique per option", new Set(radios.map((f) => f.selector)).size === radios.length);
    },
  },
  {
    file: "oracle-honeypot-and-ai-widget.html",
    bug: "a honeypot got filled, and an AI-assistant textarea was treated as a required application field",
    check(fields, t) {
      const hp = one(fields, "honeypot");
      const oda = fields.find((f) => /^oda-/.test(f.idOrName));
      t.is("honeypot is skipped", hp?.skipAlways, true);
      t.ok("honeypot reason names it as anti-bot", /honeypot|anti-bot/i.test(hp?.skipReason ?? ""));
      t.is("AI-assistant widget is skipped", oda?.skipAlways, true);
      t.ok("AI widget reason names the widget, not a honeypot", /assistant/i.test(oda?.skipReason ?? "") && !/honeypot/i.test(oda?.skipReason ?? ""));
      t.is("the real application field survives", one(fields, "email")?.skipAlways, false);
    },
  },
  {
    file: "workable-aria-hidden-real-question.html",
    bug: "two real required questions were discarded as invisible plumbing",
    check(fields, t) {
      const vehicle = byName(fields, "vehicle");
      t.ok("both radios survived", vehicle.length === 2);
      t.ok("aria-hidden with a visible partner is NOT skipped", vehicle.every((f) => !f.skipAlways));
      t.ok("the real question text is attached", /vehicle/i.test(vehicle[0]?.groupQuestion ?? ""));
      const shadow = one(fields, "rs-shadow-input");
      t.is("aria-hidden with no visible partner IS skipped", shadow?.skipAlways, true);
      t.ok("plumbing is not mislabelled a honeypot", !/honeypot/i.test(shadow?.skipReason ?? ""));
    },
  },
  {
    file: "bamboohr-file-input-chrome.html",
    bug: "the resume upload was left empty on a required field, with no error",
    check(fields, t) {
      const file = fields.find((f) => f.type === "file");
      t.is("the real label wins over the widget's own chrome", file?.label, "Resume*");
      t.ok("aria-label='file-input' was not accepted", file?.label !== "file-input");
      t.ok("file-picker chrome was rejected", !/no file selected|choose file/i.test(file?.label ?? ""));
      t.is("the asterisk still marks it required", file?.required, true);
      t.ok("label matches the resume check (contains resume/cv)", /resume|cv/i.test(file?.label ?? ""));
    },
  },
  {
    file: "rippling-generic-label.html",
    bug: "two different questions were both labelled 'Select', and one was answered wrong",
    check(fields, t) {
      t.ok("no field kept a generic instruction word as its label", fields.every((f) => !/^(select|search|choose)\.{0,3}$/i.test(f.label.trim())));
      const labels = fields.map((f) => f.label);
      t.ok("every label is distinct", new Set(labels).size === labels.length);
      t.ok("first question recovered from DOM proximity", labels.some((l) => /accepted state/i.test(l)));
      t.ok("second question recovered from DOM proximity", labels.some((l) => /sponsorship/i.test(l)));
      t.ok("aria-labelledby outranks a generic aria-label", labels.some((l) => /identify your race/i.test(l)));
    },
  },
  {
    file: "custom-widget-shapes.html",
    bug: "decorative selects, button-driven yes/no questions and tel country lists were all mishandled",
    check(fields, t) {
      const state = one(fields, "state");
      t.is("a readonly aria-hidden <select> routes through the combobox path", state?.isCombobox, true);
      t.is("...and is not skipped, because it has a visible label", state?.skipAlways, false);

      const auth = fields.find((f) => /authorized to work/i.test(f.label));
      t.is("sibling buttons are harvested as the real options", JSON.stringify(auth?.options), JSON.stringify(["Yes", "No"]));

      const agree = one(fields, "agree") ?? fields.find((f) => /agree to the terms/i.test(f.label));
      t.ok("a single unrelated button is not harvested", (agree?.options.length ?? 0) === 0);

      const tel = fields.find((f) => f.type === "tel");
      t.is("a huge country-code list is replaced, not used as the label", tel?.label, "Phone number");
    },
  },
  {
    file: "react-select-placeholder-proximity.html",
    bug: "a widget's 'Select...' placeholder became the label via DOM proximity, bypassing the generic-word clear",
    check(fields, t) {
      t.ok("no field settled for the widget's placeholder", fields.every((f) => !/^(select|search)\.{0,3}$/i.test(f.label.trim())));
      const labels = fields.map((f) => f.label);
      t.ok("every question is distinguishable", new Set(labels).size === labels.length);
      t.ok("work authorisation question recovered", /authorized to work/i.test(one(fields, "q_work_auth")?.label ?? ""));
      t.ok("sponsorship question recovered", /sponsorship/i.test(one(fields, "q_sponsorship")?.label ?? ""));
      t.ok("'Search' chrome is rejected too, not just 'Select...'", /region/i.test(one(fields, "q_region")?.label ?? ""));
      t.ok("these are live fields, not skipped", fields.every((f) => !f.skipAlways));
    },
  },
  {
    file: "meridianlink-iframe-host.html",
    bug: "a valid job link was rejected because the form lived in an embedded iframe",
    check(fields, t, ctx) {
      t.ok("the form context is the iframe, not the host page", "url" in ctx && /iframe-form/.test((ctx as { url(): string }).url()));
      t.is("all four embedded fields discovered", fields.length, 4);
      t.ok("fields come from the form, not the host chrome", fields.some((f) => /first name/i.test(f.label)));
      t.ok("host page's decoy inputs are not what was picked", !fields.some((f) => /newsletter|search this site/i.test(f.label)));
    },
  },
];

// ---------------------------------------------------------------------------

const FIXTURES = path.resolve(import.meta.dirname, "fixtures");
const filter = process.argv[2];

let failed = 0;
let passed = 0;

async function run(browser: Browser, c: Case) {
  const page = await browser.newPage({ viewport: { width: 1280, height: 900 } });
  const results: string[] = [];
  const t: T = {
    is(name, actual, expected) {
      const ok = JSON.stringify(actual) === JSON.stringify(expected);
      ok ? passed++ : failed++;
      results.push(
        ok ? `    PASS  ${name}` : `    FAIL  ${name}\n            expected ${JSON.stringify(expected)}\n            actual   ${JSON.stringify(actual)}`
      );
    },
    ok(name, condition) {
      condition ? passed++ : failed++;
      results.push(condition ? `    PASS  ${name}` : `    FAIL  ${name}`);
    },
  };

  try {
    await page.goto(pathToFileURL(path.join(FIXTURES, c.file)).href, { waitUntil: "load" });
    const ctx = await findFormContext(page);
    const fields = await discoverFields(ctx);
    await c.check(fields, t, ctx);
  } catch (err) {
    failed++;
    results.push(`    FAIL  threw: ${(err as Error).message.split("\n")[0]}`);
  } finally {
    await page.close();
  }

  console.log(`\n${c.file}\n  guards: ${c.bug}`);
  console.log(results.join("\n"));
}

const browser = await chromium.launch();
for (const c of CASES) {
  if (filter && !c.file.includes(filter)) continue;
  await run(browser, c);
}
await browser.close();

console.log(`\n${"-".repeat(70)}`);
console.log(failed ? `${passed} passed, ${failed} FAILED` : `${passed} passed, 0 failed - the scanner still handles every known regression`);
process.exit(failed ? 1 : 0);
