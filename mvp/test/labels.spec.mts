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
import { genericDegreeOptions, isLocationLabel, isStandardRecruitmentConsent, unbackedInstitution } from "../src/apply.js";

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

  // THE BUG: a required Zynga combobox left blank on a live posting. The
  // label is a TITLE, so it never spends words on "personal data" or
  // "recruitment" - which is exactly what the wording test at the end of
  // isStandardRecruitmentConsent demands before it will say yes.
  { label: "Zynga Application/Data Privacy Consent *", want: true, why: "THE BUG: title-shaped consent, left blank on a live Zynga posting" },
  { label: "Data Privacy Consent", want: true, why: "same shape, no company prefix" },
  { label: "Privacy Agreement", want: true, why: "agreement rather than consent" },

  // The title rule must not become a way around the scope exclusion...
  { label: "Data Privacy Consent for marketing purposes", want: false, why: "title shape, but marketing scope still wins" },
  { label: "Privacy Consent - share with third parties", want: false, why: "title shape, but third-party sharing still wins" },
  // ...nor a way to short-circuit a full paragraph. Anything long enough to
  // state its own scope must be judged on that scope, not on two of its
  // words. This one reads as consent but never limits itself to recruitment.
  {
    label:
      "I hereby give my privacy consent and confirm that the statements made by me in this application are true and complete to the best of my knowledge and belief.",
    want: false,
    why: "too long to be a title - must fall through to the wording test",
  },
];

// A dropdown's real option list, and what the generic-degree fallback is
// allowed to pick from it.
interface DegreeCase {
  label: string;
  value: string;
  options: string[];
  want: string | null;
  why: string;
}

const GREENHOUSE_DEGREES = ["Bachelor's Degree", "Master's Degree", "Doctorate", "Associate's Degree", "High School", "Other"];
// A list offering only SPECIFIC degrees and no generic level.
const SPECIFIC_ONLY = ["Bachelor of Arts", "Bachelor of Science", "Bachelor of Fine Arts"];

const DEGREE: DegreeCase[] = [
  {
    label: "Degree*",
    value: "Bachelor of Business Administration",
    options: GREENHOUSE_DEGREES,
    want: "Bachelor's Degree",
    why: "THE BUG: a resume's B.B.A. expanded truthfully, then matched nothing - required field left empty on a live SpaceX posting",
  },
  { label: "Degree*", value: "B.B.A.", options: GREENHOUSE_DEGREES, want: "Bachelor's Degree", why: "abbreviated form of the same credential" },
  { label: "Degree*", value: "Master of Science", options: GREENHOUSE_DEGREES, want: "Master's Degree", why: "master level" },
  { label: "Degree*", value: "MBA", options: GREENHOUSE_DEGREES, want: "Master's Degree", why: "an MBA is a master's - must not fall to bachelor" },
  { label: "Degree*", value: "Ph.D.", options: GREENHOUSE_DEGREES, want: "Doctorate", why: "doctorate" },
  { label: "Degree*", value: "Doctor of Education", options: GREENHOUSE_DEGREES, want: "Doctorate", why: "'Doctor of' without the word doctorate" },
  { label: "Degree*", value: "Associate of Arts", options: GREENHOUSE_DEGREES, want: "Associate's Degree", why: "associate level" },
  { label: "Highest level of education", value: "High School Diploma", options: GREENHOUSE_DEGREES, want: "High School", why: "secondary" },

  // The line this must never cross. Being vaguer than the truth is fine;
  // being specifically wrong about someone's education is not.
  {
    label: "Degree*",
    value: "Bachelor of Business Administration",
    options: SPECIFIC_ONLY,
    want: null,
    why: "MUST NOT answer a B.B.A. with 'Bachelor of Arts' just because it is on the list",
  },
  { label: "Degree*", value: "Master of Science", options: SPECIFIC_ONLY, want: null, why: "no generic option - leave the field for the user" },

  // Scoped to education fields by label, so a prose answer that happens to
  // mention a degree can't be swapped for a dropdown level.
  {
    label: "Why are you interested in this role?",
    value: "I have a Bachelor of Science",
    options: GREENHOUSE_DEGREES,
    want: null,
    why: "free-text question, not an education field",
  },
  { label: "What is your current job title?", value: "Bachelor", options: GREENHOUSE_DEGREES, want: null, why: "non-education label" },
  { label: "Degree*", value: "Some college, no degree", options: GREENHOUSE_DEGREES, want: null, why: "level can't be read - existing skip stands" },
];

// Mirrors the education section of the real template from the failing run.
// Inline rather than loading the user's actual .docx: the guard must be
// testable without a personal file present, and the one line that matters
// is reproduced faithfully here.
const RESUME = `
Steven Nguyen - Business Analyst
EXPERIENCE
  Some Company - built dashboards and reporting
EDUCATION
  Georgia State University    Graduation: December 2023
  B.B.A., Computer/Management Information Systems
  GPA: 3.54/4.0; Dean's List; Honors College; Cum Laude
`;

interface InstitutionCase {
  label: string;
  value: string;
  want: boolean;
  why: string;
}

const INSTITUTION: InstitutionCase[] = [
  {
    label: "School*",
    value: "Arizona State University",
    want: true,
    why: "THE BUG: answered on a live SpaceX posting while the resume said Georgia State",
  },
  { label: "School*", value: "Georgia State University", want: false, why: "the truth, verbatim in the resume" },
  { label: "School*", value: "Georgia State Univ.", want: false, why: "reworded, but every distinguishing word is still present" },
  { label: "School*", value: "georgia state university", want: false, why: "case-insensitive" },
  { label: "University", value: "Stanford University", want: true, why: "a school the resume never mentions" },
  { label: "Most recent employer", value: "Initech", want: true, why: "employer fields get the same treatment" },

  // Must not fire outside institution fields - this is what keeps it from
  // becoming a general-purpose answer filter.
  { label: "Why are you interested in this role?", value: "Arizona is a long way from here", want: false, why: "prose answer, not an institution field" },
  { label: "Preferred First Name", value: "Arizona", want: false, why: "not an institution field" },

  // Nothing identifying in the value - not evidence either way.
  // Deliberately NOT "University": that word appears inside "Georgia State
  // University", so it exits at the verbatim check and never reaches the
  // branch this is meant to cover. It stayed green under its own mutation
  // until the checker caught it.
  { label: "School*", value: "Institute", want: false, why: "no distinguishing word left after the generic ones" },
  { label: "School*", value: "", want: false, why: "empty is handled by the normal empty-answer path" },
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

// Mirrors findMatchingOption(): first candidate pattern, first option it
// matches. Asserting on the option actually picked, not just on whether a
// pattern was returned - "did it match something" would stay green even if
// it matched the wrong degree.
console.log("\ngenericDegreeOptions");
for (const c of DEGREE) {
  let got: string | null = null;
  outer: for (const pattern of genericDegreeOptions(c.label, c.value)) {
    for (const option of c.options) {
      if (pattern.test(option)) {
        got = option;
        break outer;
      }
    }
  }
  const ok = got === c.want;
  ok ? pass++ : fail++;
  console.log(`  ${ok ? "PASS" : "FAIL"}  ${JSON.stringify(c.value).padEnd(38)} -> ${String(got)}`);
  if (!ok) console.log(`        expected ${String(c.want)} - ${c.why}`);
}

console.log("\nunbackedInstitution");
for (const c of INSTITUTION) {
  const got = unbackedInstitution(c.label, c.value, RESUME);
  const ok = got === c.want;
  ok ? pass++ : fail++;
  console.log(`  ${ok ? "PASS" : "FAIL"}  rejected=${String(got).padEnd(5)} ${JSON.stringify(c.value)}`);
  if (!ok) console.log(`        expected ${c.want} - ${c.why}`);
}

console.log(`\n${"-".repeat(70)}`);
console.log(fail ? `${pass} passed, ${fail} FAILED` : `${pass} passed, 0 failed - label predicates still mean what they claim`);
process.exit(fail ? 1 : 0);
