// Mutation check: does the fixture harness actually CATCH each regression?
//
// Reintroduces each historical bug one at a time, reruns only the fixture
// that guards it, and asserts the suite goes red. A guard that stays green
// under its own mutation is testing nothing.
//
// Every mutated file is restored after each mutation and verified
// byte-identical at the end, regardless of how this exits.
import { execFileSync } from "node:child_process";
import fs from "node:fs";

// Files a mutation may touch. `original` is read once up front so a restore
// can never depend on state a half-finished run left behind.
const SOURCES = {
  apply: "src/apply.ts",
  scrape: "src/scrape.ts",
};
const ORIGINAL = Object.fromEntries(Object.entries(SOURCES).map(([k, p]) => [k, fs.readFileSync(p, "utf-8")]));

// Which spec proves which kind of guard.
const SPECS = {
  fields: "test/fixtures.spec.mts",
  classify: "test/classify.spec.mts",
};

const MUTATIONS = [
  {
    bug: "stop checking <legend> for a fieldset's question",
    fixture: "bamboohr",
    from: '":scope > legend, :scope > label"',
    to: '":scope > label"',
  },
  {
    bug: "stop skipping <style> subtrees in the proximity walk",
    fixture: "paycom",
    from: 'if (prevEl && !["STYLE", "SCRIPT", "NOSCRIPT", "TEMPLATE"].includes(prevEl.tagName)) {',
    to: "if (prevEl) {",
  },
  {
    bug: "stop treating the consent manager as out-of-form",
    fixture: "kforce",
    from: "} else if (inConsentManager) {",
    to: "} else if (false && inConsentManager) {",
  },
  {
    bug: "stop detecting a CSS-painted required asterisk",
    fixture: "ashby-css",
    from: "const required = requiredAttr || /\\*/.test(label) || cssRequiredAsterisk;",
    to: "const required = requiredAttr || /\\*/.test(label);",
  },
  {
    bug: "prefer the regenerated id over the stable name",
    fixture: "workable-stale",
    from: "if (nameAttr && document.getElementsByName(nameAttr).length === 1) {",
    to: "if (false && nameAttr) {",
  },
  {
    bug: "accept generic instruction words as real labels",
    fixture: "rippling",
    from: 'if (GENERIC_LABEL_RE.test(label.trim())) label = "";',
    to: "",
  },
  {
    bug: "skip every aria-hidden control, ignoring a visible label partner",
    fixture: "workable-aria-hidden",
    from: "} else if (ariaHiddenAttr && !hasVisibleLabelPartner) {",
    to: "} else if (ariaHiddenAttr) {",
  },
  {
    bug: "only ever look at the main frame, never iframes",
    fixture: "meridianlink",
    from: "function allContexts(page: Page): FormContext[] {",
    to: "function allContexts(page: Page): FormContext[] {\n  if (1) return [page];",
  },
  {
    bug: "let the link-count rule outrank a page's own Apply affordance",
    source: "scrape",
    spec: "classify",
    fixture: "posting-with-sidebar",
    from: "if (askedForOnePosting && signals.hasApply && signals.textLength > 1200)",
    to: "if (false && askedForOnePosting && signals.hasApply && signals.textLength > 1200)",
  },
  {
    // The other half: without the URL-shape requirement, any board whose
    // prose contains the word "apply" gets promoted to a posting. Not
    // hypothetical - this is exactly what happened when the fixture below
    // was padded with "Applying takes a few minutes".
    bug: "drop the URL-shape requirement, letting prose containing 'apply' promote a board",
    source: "scrape",
    spec: "classify",
    fixture: "board-with-signup-form",
    from: "if (askedForOnePosting && signals.hasApply && signals.textLength > 1200)",
    to: "if (signals.hasApply && signals.textLength > 1200)",
  },
  {
    bug: "stop telling a removed posting apart from an ordinary board",
    source: "scrape",
    spec: "classify",
    fixture: "dead",
    from: "const deadPosting = askedForOnePosting && strip(landed) !== strip(url) && !signals.hasApply;",
    to: "const deadPosting = false;",
  },
  {
    bug: "call any posting-shaped link dead, ignoring whether it redirected",
    source: "scrape",
    spec: "classify",
    // Deliberately NOT jobs/live-67890.html: with no sibling links that page
    // exits at the "form + description -> job" branch and never consults
    // deadPosting, so it stayed green under this mutation. Caught by this
    // very check.
    fixture: "engineering",
    from: "const deadPosting = askedForOnePosting && strip(landed) !== strip(url) && !signals.hasApply;",
    to: "const deadPosting = askedForOnePosting;",
  },
  {
    bug: "let the proximity walk accept a widget's generic placeholder",
    fixture: "react-select",
    from: "const isGenericChrome = GENERIC_LABEL_RE.test(text);",
    to: "const isGenericChrome = false;",
  },
  {
    bug: "stop recognising an account wall, so a login page gets filled",
    fixture: "auth-wall-login",
    from: "if (!visible) return null;",
    to: "if (visible) return null;",
  },
  {
    bug: "let a password field be filled like any other input",
    fixture: "auth-wall-login",
    from: 'skipReason = "password/credential field - never filled by this tool";',
    to: 'skipReason = "";\n          skipAlways = false;',
  },
  {
    // The false-positive direction: keying on wording rather than a visible
    // password field would stop on any form that merely links to a sign-in.
    bug: "treat a hidden login modal as an account wall",
    fixture: "real-form-with-signin-link",
    from: "          if (r.width === 0 || r.height === 0) return false;",
    to: "          if (false) return false;",
  },
  {
    bug: "stop rejecting file-picker chrome as a label",
    fixture: "bamboohr-file",
    from: 'const isFileChrome = type === "file" && /no file selected/i.test(text);',
    to: "const isFileChrome = false;",
  },
];

let caught = 0;
let missed = 0;

try {
  for (const m of MUTATIONS) {
    const srcKey = m.source ?? "apply";
    const specKey = m.spec ?? "fields";
    const file = SOURCES[srcKey];
    const original = ORIGINAL[srcKey];

    if (!original.includes(m.from)) {
      console.log(`SKIP    ${m.bug}\n        (anchor not found in ${file} - mutation is stale, fix it)`);
      missed++;
      continue;
    }
    fs.writeFileSync(file, original.replace(m.from, m.to));

    let red = false;
    try {
      execFileSync("npx", ["tsx", SPECS[specKey], m.fixture], { stdio: "pipe", shell: true });
    } catch {
      red = true; // non-zero exit = the harness noticed
    }
    fs.writeFileSync(file, original);

    if (red) {
      caught++;
      console.log(`CAUGHT  ${m.bug}\n        -> ${m.fixture} went red, as it should`);
    } else {
      missed++;
      console.log(`MISSED  ${m.bug}\n        -> ${m.fixture} stayed GREEN. That guard is not testing what it claims.`);
    }
  }
} finally {
  // Compared against the content this run started with, NOT against git:
  // these files legitimately carry uncommitted work most of the time, and a
  // git-based check reports that as a failed restore.
  for (const [key, file] of Object.entries(SOURCES)) {
    fs.writeFileSync(file, ORIGINAL[key]);
    const restored = fs.readFileSync(file, "utf-8") === ORIGINAL[key];
    console.log(`\n${file} restored: ${restored ? "byte-identical to how this run found it" : "MISMATCH - restore failed, check the file"}`);
  }
}

console.log(`\n${caught} caught, ${missed} missed`);
process.exit(missed ? 1 : 0);
