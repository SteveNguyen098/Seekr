// Mutation check: does the fixture harness actually CATCH each regression?
//
// Reintroduces each historical bug into apply.ts one at a time, reruns only
// the fixture that guards it, and asserts the suite goes red. A guard that
// stays green under its own mutation is testing nothing.
//
// apply.ts is restored after every mutation, and verified clean via git at
// the end regardless of how this exits.
import { execFileSync } from "node:child_process";
import fs from "node:fs";

const APPLY = "src/apply.ts";
const original = fs.readFileSync(APPLY, "utf-8");

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
    bug: "let the proximity walk accept a widget's generic placeholder",
    fixture: "react-select",
    from: "const isGenericChrome = GENERIC_LABEL_RE.test(text);",
    to: "const isGenericChrome = false;",
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
    if (!original.includes(m.from)) {
      console.log(`SKIP    ${m.bug}\n        (anchor not found - mutation is stale, fix it)`);
      missed++;
      continue;
    }
    fs.writeFileSync(APPLY, original.replace(m.from, m.to));

    let red = false;
    try {
      execFileSync("npx", ["tsx", "test/fixtures.spec.mts", m.fixture], { stdio: "pipe", shell: true });
    } catch {
      red = true; // non-zero exit = the harness noticed
    }
    fs.writeFileSync(APPLY, original);

    if (red) {
      caught++;
      console.log(`CAUGHT  ${m.bug}\n        -> ${m.fixture} went red, as it should`);
    } else {
      missed++;
      console.log(`MISSED  ${m.bug}\n        -> ${m.fixture} stayed GREEN. That guard is not testing what it claims.`);
    }
  }
} finally {
  fs.writeFileSync(APPLY, original);
  // Compared against the content this run started with, NOT against git:
  // apply.ts legitimately carries uncommitted work most of the time, and a
  // git-based check reports that as a failed restore.
  const restored = fs.readFileSync(APPLY, "utf-8") === original;
  console.log(`\napply.ts restored: ${restored ? "byte-identical to how this run found it" : "MISMATCH - restore failed, check the file"}`);
}

console.log(`\n${caught} caught, ${missed} missed`);
process.exit(missed ? 1 : 0);
