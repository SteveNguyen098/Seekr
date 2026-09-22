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
  labels: "test/labels.spec.mts",
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
    bug: "stop skipping the site's job-search box, so it gets filled as the application",
    fixture: "trillium-signup",
    from: "        } else if (inSiteSearchForm) {",
    to: "        } else if (false && inSiteSearchForm) {",
  },
  {
    // The other direction: scoping by FIELD NAME instead of by form would
    // drop a real "location" field out of a working application form -
    // a real Greenhouse form has a required "Location (City)" input.
    bug: "scope the search-box rule by field name instead of by form",
    fixture: "trillium-signup",
    from: "        const inSiteSearchForm = (() => {",
    to: "        const inSiteSearchForm = (() => { if (/keywords|location/i.test(el.getAttribute('name') || '')) return true;",
  },
  {
    bug: "let the label walk claim text from another field's block",
    fixture: "trillium-signup",
    from: "&& !isFileChrome && !isGenericChrome && !isAnotherFieldsBlock) label = text;",
    to: "&& !isFileChrome && !isGenericChrome) label = text;",
  },
  {
    // The bug that shipped: a substring test for "city" also matches
    // "capacity", so a required bribery-disclosure question was answered
    // with the candidate's home city on a live Robinhood posting.
    bug: "match 'city' as a substring, so 'capacity' becomes a location field",
    spec: "labels",
    fixture: "",
    from: "    /(^|[^a-z])city([^a-z]|$)/.test(labelLower) ||",
    to: "    labelLower.includes('city') ||",
  },
  {
    // The opposite direction: the boundary must not become so strict that
    // the ordinary "Location (City)*" field stops being recognised.
    bug: "require city to stand completely alone, dropping the real Location (City) field",
    spec: "labels",
    fixture: "",
    from: "    /(^|[^a-z])city([^a-z]|$)/.test(labelLower) ||",
    to: "    labelLower === 'city' ||",
  },
  {
    // The bug that shipped: a REQUIRED Zynga consent combobox left blank,
    // because a title-shaped label never says "personal data" or
    // "recruitment" - the words the wording test demands.
    bug: "drop the title-shaped consent rule, leaving a required consent field blank",
    spec: "labels",
    fixture: "",
    from: "if (asTitle.length <= 60 && /(^|[^a-z])privacy[\\s/-]+(consent|agreement)([^a-z]|$)/i.test(asTitle)) return true;",
    to: "",
  },
  {
    // The other direction, and the one that would actually be dangerous:
    // without the length cap, any consent PARAGRAPH containing both words
    // gets auto-acknowledged without its scope ever being read.
    bug: "drop the length cap, letting a whole consent paragraph be auto-acknowledged",
    spec: "labels",
    fixture: "",
    from: "if (asTitle.length <= 60 && /(^|[^a-z])privacy[\\s/-]+(consent|agreement)([^a-z]|$)/i.test(asTitle))",
    to: "if (/(^|[^a-z])privacy[\\s/-]+(consent|agreement)([^a-z]|$)/i.test(asTitle))",
  },
  {
    // The dangerous direction. The whole point of the generic-only
    // patterns is that a B.B.A. must never be answered "Bachelor of Arts"
    // just because that option exists - a factual misstatement about
    // someone's education, which is worse than an empty field.
    //
    // Anchors here are deliberately backslash-free: writing a regex into
    // this file is how a \b became a literal backspace twice.
    bug: "match any option containing the level word, so a B.B.A. is answered 'Bachelor of Arts'",
    spec: "labels",
    fixture: "",
    from: "    if (level.test(value)) return generic;",
    to: "    if (level.test(value)) return [new RegExp(value.split(' ')[0], 'i')];",
  },
  {
    bug: "ignore the level test, so every degree falls back to the first level",
    spec: "labels",
    fixture: "",
    from: "    if (level.test(value)) return generic;",
    to: "    return generic;",
  },
  {
    // The other direction on scope: without the label check, a prose
    // answer that merely mentions a degree gets swapped for a dropdown
    // level.
    bug: "drop the education-label scope from the degree fallback",
    spec: "labels",
    fixture: "",
    from: "  if (!/degree|education|qualification|academic level|level of study/i.test(label)) return [];",
    to: "",
  },
  {
    // The bug that shipped: a resume reading "Georgia State University"
    // was answered "Arizona State University" on a live posting.
    bug: "stop checking a generated institution against the resume",
    spec: "labels",
    fixture: "",
    from: "  if (!/school|universit|college|institution|alma mater|employer/i.test(label)) return false;",
    to: "  return false;",
  },
  {
    // The over-reach direction: without the label scope this stops being a
    // fabrication guard and starts filtering ordinary prose answers.
    bug: "drop the institution-label scope, so any answer is checked against the resume",
    spec: "labels",
    fixture: "",
    from: "  if (!/school|universit|college|institution|alma mater|employer/i.test(label)) return false;",
    to: "",
  },
  {
    // The other over-reach: a value with nothing identifying in it
    // ("University") is not evidence of fabrication and must not be
    // rejected as if it were.
    bug: "fail closed when a value has no distinguishing word left",
    spec: "labels",
    fixture: "",
    from: "  if (!distinguishing.length) return false;",
    to: "  if (!distinguishing.length) return true;",
  },
  {
    // The bug that shipped: a required Axon checkbox reported as just
    // "Acknowledge", with the legend naming the firearms questionnaire
    // never consulted because the legend lookup ran only for radios.
    bug: "stop consulting a fieldset's legend for a bare-affirmation checkbox",
    fixture: "axon-acknowledge",
    from: '          const legend = el.closest("fieldset")?.querySelector(":scope > legend")?.textContent?.trim() || "";',
    to: '          const legend = "";',
  },
  {
    // The damaging direction: applied to EVERY checkbox, a group's shared
    // legend overwrites each option's own label, so "Asian" becomes the
    // race question and the self-identify handling loses what it keys on.
    bug: "take the legend for every checkbox, overwriting a group's own option labels",
    fixture: "axon-acknowledge",
    from: 'if (type === "checkbox" && /^(i\\s+)?(acknowledge|acknowledged|agree|accept|consent|confirm|yes)[\\s.:*-]*$/i.test(label.trim())) {',
    to: 'if (type === "checkbox") {',
  },
  {
    // Without the credential exclusion, "What degree did you earn at this
    // school?" is treated as the school-name field and answered with the
    // university, burying the real question.
    bug: "drop the credential exclusion, so a degree question asks for the school name",
    spec: "labels",
    fixture: "",
    from: "  if (/degree|level of (education|study)|major|field of study|gpa|graduation|years? attended|did you graduate/i.test(labelLower)) return false;",
    to: "",
  },
  // isTickableAcknowledgement agrees to something legal on the candidate's
  // behalf, so every guard in it gets its own mutation. Each of these is a
  // refusal that must keep working.
  {
    bug: "auto-tick an acknowledgement whose scope covers marketing or third-party sharing",
    spec: "labels",
    fixture: "",
    from: "  if (CONSENT_BROADER_SCOPE_RE.test(field.label)) return false;\n  // Nothing protected is ever ticked automatically.",
    to: "  // Nothing protected is ever ticked automatically.",
  },
  {
    bug: "auto-tick a protected-category checkbox",
    spec: "labels",
    fixture: "",
    from: "  if (SENSITIVE_RE.test(field.label.toLowerCase())) return false;\n  return true;",
    to: "  return true;",
  },
  {
    bug: "auto-tick an OPTIONAL acknowledgement, volunteering agreement nobody asked for",
    spec: "labels",
    fixture: "",
    from: "  if (!field.required) return false;",
    to: "",
  },
  {
    bug: "auto-tick a prose consent, not just the bare-affirmation shape",
    spec: "labels",
    fixture: "",
    from: "  if (!field.ownLabelWasAffirmation) return false;",
    to: "",
  },
  {
    bug: "auto-tick a non-checkbox control",
    spec: "labels",
    fixture: "",
    from: '  if (field.type !== "checkbox") return false;',
    to: "",
  },
  {
    // Without it, "Degree field of study" is answered with the credential
    // from the profile, burying the question that was actually asked.
    bug: "drop the subject/date exclusion, so a degree-adjacent question gets the credential",
    spec: "labels",
    fixture: "",
    from: "  if (/field of study|major|gpa|graduation|school name|university name/i.test(labelLower)) return false;",
    to: "",
  },
  {
    // Silent when it breaks: "?page=1&page=2" resolves to the first value
    // on most servers, so every request returns page 1 and a 193-job board
    // reports 50 with no error.
    bug: "append the page param instead of replacing it",
    source: "scrape",
    spec: "classify",
    fixture: "",
    from: '  url.searchParams.set("page", String(pageNum));',
    to: '  url.searchParams.append("page", String(pageNum));',
  },
  {
    // The bug that shipped: an Ashby posting counted its own url and its
    // own Apply button as two sibling jobs and classified as a board.
    bug: "count a link back to this same posting as a sibling job",
    source: "scrape",
    spec: "classify",
    // The two-link fixture next door cannot catch this: it stays under the
    // >= 5 threshold and the opaque-id rule rescues it. This one has six.
    fixture: "7c1e4a90",
    from: "          if (hereId && href.includes(hereId)) return false;",
    to: "",
  },
  {
    // The over-exclusion direction. The first version of this rule keyed on
    // "is a sub-path of this url" and took every posting on a
    // Greenhouse-shaped board with it - caught live, not here: that shape
    // needs a board url with no filename, which a file:// fixture cannot
    // have. What IS reproducible is the same failure's mechanism - an
    // id-bearing board url excluding postings that are not it.
    bug: "drop every posting link once the board's own url carries an id",
    source: "scrape",
    spec: "classify",
    fixture: "boards/998877",
    from: "          if (hereId && href.includes(hereId)) return false;",
    to: "          if (hereId) return false;",
  },
  {
    bug: "stop treating an opaque id in the url as posting-shaped",
    source: "scrape",
    spec: "classify",
    fixture: "ashby/5da60843-8dc5-4da2-a7b3-2dd37314f87f/index.html",
    from: "  if (opaquePostingUrl && signals.hasApply && signals.textLength > 1200)",
    to: "  if (false && opaquePostingUrl && signals.hasApply && signals.textLength > 1200)",
  },
  {
    bug: "require prose on an application form page, so a bare apply form is unrecognisable",
    source: "scrape",
    spec: "classify",
    fixture: "application",
    from: "  if (opaquePostingUrl && signals.hasForm)",
    to: "  if (opaquePostingUrl && signals.hasForm && signals.textLength > 1200)",
  },
  {
    bug: "stop telling display:none apart from 0x0, so hidden-modal fields get filled",
    fixture: "hidden-modal",
    from: 'if (getComputedStyle(n).display === "none") return "not-rendered";',
    to: 'if (false) return "not-rendered";',
  },
  {
    // The other direction: treating every 0x0 control as hidden would drop
    // the resume upload on every Greenhouse form, which renders it 1x1
    // behind a styled dropzone.
    bug: "treat any 0x0 control as not-rendered, killing dropzone file inputs",
    fixture: "hidden-modal",
    from: 'if (r.width <= 0 || r.height <= 0) return "inconclusive-zero-size";',
    to: 'if (r.width <= 0 || r.height <= 0) return "not-rendered";',
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
