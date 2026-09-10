/**
 * Regression harness for the pure label-classification predicates.
 *
 * These decide what a field MEANS from its label alone, and they are the
 * riskiest code in the project to get wrong: a misclassification does not
 * throw, does not fail a type check, and does not look wrong in a report -
 * it just puts the wrong answer on someone's job application.
 *
 * Separate from fixtures.spec.mts because these need no DOM at all. That is
 * the point: the bug that prompted this file lived inside the fill loop
 * where nothing could reach it, and only surfaced on a live Robinhood
 * posting.
 *
 *   npm run test:labels
 */
import { isLocationLabel, isStandardRecruitmentConsent } from "../src/apply.js";

interface Case {
  label: string;
  want: boolean;
  why: string;
}

const LOCATION: Case[] = [
  { label: "Location (City)*", want: true, why: "the ordinary Greenhouse city field" },
  { label: "City", want: true, why: "bare city label" },
  { label: "Current Location", want: true, why: "Ashby's combined city/state/country combobox" },
  { label: "Where will you be working from?", want: true, why: "work-location phrasing" },
  { label: "Where do you plan on working from (for payroll tax purposes)?", want: true, why: "payroll-jurisdiction phrasing" },

  {
    label:
      "Robinhood adheres to applicable laws and regulations in relation to government officials given inherent bribery and/or corruption risk. A government official is any person that performs a public function on any level or acts in any official capacity on behalf of a government or government owned entity.",
    want: false,
    why: "THE BUG: 'capacity' ends in 'city'. Confirmed live - answered 'Decatur, Georgia' on a required bribery disclosure",
  },
  { label: "In what capacity did you work with this team?", want: false, why: "'capacity' again, everyday phrasing" },
  { label: "What is your ethnicity?", want: false, why: "'ethnicity' ends in 'city' - guarded earlier by SENSITIVE_RE, pinned here anyway" },
  { label: "Are you legally authorized to work in the location where this role is based?", want: false, why: "auth question phrased around location (Vanta)" },
  { label: "Are you open to relocation?", want: false, why: "'relocation' must not be swallowed - it has its own qa_context answer" },
  { label: "Do you require sponsorship to work in this country?", want: false, why: "sponsorship, not location" },
];

// Consent labels that SHOULD be auto-acknowledged vs left for the human.
const CONSENT: Case[] = [
  { label: "Privacy Notice Acknowledgement", want: true, why: "standard data-processing acknowledgement" },
  { label: "I acknowledge the Privacy Policy", want: true, why: "acknowledge + privacy policy" },
  { label: "Data Protection Notice", want: true, why: "bare GDPR-style policy name" },
  { label: "I consent to the processing of my personal data for recruitment purposes", want: true, why: "explicit recruitment-data consent" },
  { label: "I agree to receive marketing emails and to share my data with third parties", want: false, why: "broader scope - never auto-checked" },
];

let pass = 0;
let fail = 0;
const run = (name: string, cases: Case[], fn: (s: string) => boolean) => {
  console.log(`\n${name}`);
  for (const c of cases) {
    const got = fn(c.label.toLowerCase());
    const ok = got === c.want;
    ok ? pass++ : fail++;
    const shown = c.label.length > 62 ? c.label.slice(0, 62) + "…" : c.label;
    console.log(`  ${ok ? "PASS" : "FAIL"}  ${String(got).padEnd(5)} ${JSON.stringify(shown)}`);
    if (!ok) console.log(`        expected ${c.want} - ${c.why}`);
  }
};

run("isLocationLabel", LOCATION, isLocationLabel);
// isStandardRecruitmentConsent is called with the ORIGINAL-case label in
// apply.ts, so it is exercised that way here too.
run("isStandardRecruitmentConsent", CONSENT, (s) => isStandardRecruitmentConsent(s));

console.log(`\n${"-".repeat(70)}`);
console.log(fail ? `${pass} passed, ${fail} FAILED` : `${pass} passed, 0 failed - label predicates still mean what they claim`);
process.exit(fail ? 1 : 0);
