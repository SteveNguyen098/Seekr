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
import {
  DECLINE_RE,
  genericDegreeOptions,
  isLocationLabel,
  isDegreeLabel,
  isAnswerableCheckboxGroup,
  isDisciplineLabel,
  isSchoolLabel,
  isStandardRecruitmentConsent,
  isTickableAcknowledgement,
  searchSeed,
  unbackedInstitution,
} from "../src/apply.js";

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

  // A trailing required marker must not stop the field being recognised.
  // Measured on Lever: jobs.lever.co/ro labels this "Current location" and
  // matched, while matchgroup and palantir label it with a trailing heavy
  // asterisk and did not - so the same field was answered from the profile
  // on one tenant and sent to the model on the next.
  { label: "Current location ✱", want: true, why: "THE BUG: Lever's U+2731 required marker broke the anchored pattern" },
  { label: "Current location *", want: true, why: "the ASCII marker too" },
  { label: "Preferred location*", want: true, why: "prefix plus marker" },

  // ...but only MARKERS may trail it. These start with the word and are
  // still not asking where the candidate lives - filling them with a home
  // city would answer a different question entirely.
  { label: "Locations of interest", want: false, why: "which offices they want, not where they are" },
  { label: "Location preference for this role", want: false, why: "a preference, not a current address" },
];

// The school NAME field, which is answered from the profile, vs the
// credential questions sitting right beside it in the same education
// section, which must keep going to their own handling.
const SCHOOL: Case[] = [
  { label: "School*", want: true, why: "the Greenhouse education field that was answered with the wrong university" },
  { label: "School", want: true, why: "bare label" },
  { label: "University", want: true, why: "alternate wording" },
  { label: "College/University", want: true, why: "combined wording" },
  { label: "What school did you attend?", want: true, why: "question phrasing" },

  { label: "Degree*", want: false, why: "wants a level, not an institution - has its own fallback handling" },
  { label: "Highest level of education", want: false, why: "a level question that mentions education" },
  { label: "Field of study", want: false, why: "the subject, not the school" },
  { label: "Major", want: false, why: "the subject, not the school" },
  { label: "Graduation date", want: false, why: "a date field in the same section" },
  { label: "Did you graduate?", want: false, why: "yes/no, not an institution name" },

  // The cases above all come back false on the institution words alone, so
  // none of them exercises the credential exclusion. These do: each names
  // an institution AND asks something that is not the institution's name.
  { label: "What degree did you earn at this school?", want: false, why: "names a school but asks for the credential" },
  { label: "Did you graduate from this university?", want: false, why: "names a university but asks yes/no" },
  { label: "Highest level of education completed (school)", want: false, why: "names a school but asks for a level" },
];

// Which required acknowledgement checkboxes may be ticked automatically.
// Enabled deliberately, so every refusal below is load-bearing.
interface AckCase {
  field: { type: string; required: boolean; label: string; ownLabelWasAffirmation: boolean };
  want: boolean;
  why: string;
}

const ACK: AckCase[] = [
  {
    field: { type: "checkbox", required: true, label: "Federal Firearms Licensee Employee Accessor Questionnaire *", ownLabelWasAffirmation: true },
    want: true,
    why: "the Axon box - a required acknowledgement of a questionnaire shown on the same page",
  },
  {
    field: { type: "checkbox", required: true, label: "Prohibited Possessor Questionnaire *", ownLabelWasAffirmation: true },
    want: true,
    why: "Axon's other acknowledgement, same shape",
  },

  // Every one of these is a refusal that has to keep working.
  {
    field: { type: "checkbox", required: true, label: "I agree to receive marketing emails and share my data with third parties", ownLabelWasAffirmation: true },
    want: false,
    why: "broader scope - marketing and third-party sharing are never ticked automatically",
  },
  {
    field: { type: "checkbox", required: true, label: "Consent to retain my data indefinitely", ownLabelWasAffirmation: true },
    want: false,
    why: "indefinite retention is broader scope",
  },
  {
    field: { type: "checkbox", required: true, label: "Voluntary self-identification of disability", ownLabelWasAffirmation: true },
    want: false,
    why: "protected category - never ticked automatically",
  },
  {
    field: { type: "checkbox", required: true, label: "Gender", ownLabelWasAffirmation: true },
    want: false,
    why: "protected category",
  },
  {
    field: { type: "checkbox", required: false, label: "Federal Firearms Licensee Employee Accessor Questionnaire", ownLabelWasAffirmation: true },
    want: false,
    why: "optional - blocks nothing, so ticking it volunteers agreement nobody asked for",
  },
  {
    field: { type: "checkbox", required: true, label: "I consent to the processing of my personal data for recruitment purposes", ownLabelWasAffirmation: false },
    want: false,
    why: "prose consent, not the bare-affirmation shape - goes to the existing consent handling instead",
  },
  {
    field: { type: "radio", required: true, label: "Federal Firearms Licensee Employee Accessor Questionnaire *", ownLabelWasAffirmation: true },
    want: false,
    why: "checkboxes only",
  },
];

// The credential LEVEL field, answered from the profile. Mutually
// exclusive with SCHOOL above - the exclusivity itself is asserted below,
// since both live in the same education section.
const DEGREE_LABEL: Case[] = [
  { label: "Degree*", want: true, why: "THE BUG: required field left empty on a live SpaceX posting" },
  { label: "Degrees", want: true, why: "plural" },
  { label: "Highest level of education", want: true, why: "level phrasing" },
  { label: "Education level", want: true, why: "level phrasing" },
  { label: "What degree did you earn at this school?", want: true, why: "names a school but asks for the credential" },

  { label: "School*", want: false, why: "the institution, handled by isSchoolLabel" },
  { label: "University", want: false, why: "the institution" },

  // These three come back false on the level words alone, so none of them
  // exercises the exclusion guard...
  { label: "Field of study", want: false, why: "the subject" },
  { label: "Major", want: false, why: "the subject" },
  { label: "Graduation date", want: false, why: "a date" },
  // ...these do: each names a degree AND asks for something that is not
  // the level. Without the guard they would be answered "Bachelor of
  // Business Administration", burying the real question.
  { label: "Degree field of study", want: false, why: "names a degree but asks the subject" },
  { label: "Graduation date for this degree", want: false, why: "names a degree but asks a date" },
  { label: "What was your major degree subject?", want: false, why: "names a degree but asks the subject" },
];

// What gets TYPED into a search-driven dropdown when the candidate is a
// pattern rather than a literal. This used to be the string "decline" for
// every RegExp - correct for the EEOC decline option it was written
// against, silently wrong for every pattern added since. Measured live:
// the Degree dropdown shows 10 options untouched and ZERO with "decline"
// typed into it, so a degree plainly on the list came back "no matching
// option" whenever the menu was a beat slow and the retry ran.
const DECLINE_RE_COPY =
  /decline|prefer not|choose not|(does\s*not|doesn't|don't|do\s*not)\s*(wish|want|consent|agree)|not disclosed|n\/a\b/i;

const SEEDS: [string | RegExp, string, string][] = [
  ["Bachelor's Degree", "Bachelor's Degree", "a literal candidate is typed as-is"],
  [DECLINE_RE_COPY, "decline", "THE ONE THAT MUST NOT CHANGE: the EEOC decline option still searches for 'decline'"],
  [/^(a\s+)?bachelor(['’]s)?(\s+degree)?\s*\*?$/i, "bachelor", "THE BUG: this used to type 'decline' and filter the list to nothing"],
  [/^undergraduate(\s+degree)?\s*\*?$/i, "undergraduate", "plain word"],
  [/^(a\s+)?master(['’]s)?(\s+degree)?\s*\*?$/i, "master", "the leading one-letter group is skipped"],
  [/^(an\s+)?associate(['’]s)?(\s+degree)?\s*\*?$/i, "associate", "two-letter group skipped too"],
  [/^ged\s*\*?$/i, "ged", "exactly three letters still counts"],
  [/^\s*$/, "", "nothing typeable - the caller must skip rather than type junk"],
  [/\d{4}/, "", "escape sequences are not literal text - \\d must not become 'd'"],
];

// The SUBJECT studied - the third and last education fact to stop being
// generated. A live RIVA Solutions run answered it "Program Management",
// the job's own title, while the resume states the real one plainly.
const DISCIPLINE: Case[] = [
  { label: "Discipline", want: true, why: "the RIVA field that was answered with the job title" },
  { label: "Discipline*", want: true, why: "required marker" },
  { label: "Field of study", want: true, why: "common wording" },
  { label: "Course of study", want: true, why: "common wording" },
  { label: "Area of Study", want: true, why: "common wording" },
  { label: "Concentration", want: true, why: "common wording" },
  { label: "Major", want: true, why: "bare label" },
  { label: "Major/Discipline", want: true, why: "combined wording" },

  { label: "Degree*", want: false, why: "the level, handled by isDegreeLabel" },
  { label: "School*", want: false, why: "the institution, handled by isSchoolLabel" },
  { label: "Graduation date", want: false, why: "a date in the same section" },

  // "Major" is the word that can appear innocently, so it is anchored
  // rather than matched loosely. Answering any of these with a field of
  // study would put nonsense in a free-text box.
  { label: "Describe a major accomplishment", want: false, why: "'major' as an adjective, not a field of study" },
  { label: "What was your major contribution to that project?", want: false, why: "'major' as an adjective again" },
  { label: "Major Achievements", want: false, why: "'major' as an adjective in a heading" },
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

  // The guard only applies to fields asking for a NAME. A question that
  // merely contains one of its trigger words is asking something about the
  // candidate, and its answer is not an institution.
  {
    label: "Are you legally authorized to work for any United States Employer at the time of application?*",
    value: "Yes",
    want: false,
    why: "THE BUG: contains 'Employer', so 'Yes' was checked as an employer name and a required question was left blank",
  },
  { label: "May we contact your current employer?", value: "Yes", want: false, why: "question, answer is yes/no" },
  { label: "Did you attend this school?", value: "Yes", want: false, why: "same shape on the education side" },

  // ...but a question that genuinely asks for a name is still guarded,
  // which is the case the question-mark rule alone would miss.
  { label: "What is the name of your most recent employer?", value: "Initech", want: true, why: "a question that does ask for a name" },
  { label: "Employer name", value: "Initech", want: true, why: "noun phrase asking for a name" },
  { label: "Most recent employer", value: "Initech", want: true, why: "an employer the resume never mentions" },
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
run("isSchoolLabel", SCHOOL, isSchoolLabel);
run("isDegreeLabel", DEGREE_LABEL, isDegreeLabel);
run("isDisciplineLabel", DISCIPLINE, isDisciplineLabel);

// Both live in the same education section, so a label claimed by both
// would be answered by whichever branch the fill loop happens to reach
// first - the kind of thing that only shows up on a real application.
{
  // All three sit in the same education section, so a label claimed by two
  // of them would be answered by whichever branch the fill loop reached
  // first - silently, and only visible on a real application.
  const clash = [...SCHOOL, ...DEGREE_LABEL, ...DISCIPLINE]
    .map((c) => c.label)
    .filter((l) => [isSchoolLabel, isDegreeLabel, isDisciplineLabel].filter((f) => f(l.toLowerCase())).length > 1);
  const ok = clash.length === 0;
  ok ? pass++ : fail++;
  console.log(`\n  ${ok ? "PASS" : "FAIL"}  school, degree and discipline never claim the same label`);
  if (!ok) console.log(`        claimed by more than one: ${clash.join(", ")}`);
}
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

// Which OPTION counts as declining a demographic question. A live LTS
// posting offers ["Man", "Woman", "Not Specified"] - "Not Specified" is the
// same answer as "decline to self-identify", worded as a state rather than
// a refusal, and without it a REQUIRED demographic question was left for
// the candidate, which is the one outcome that path exists to avoid.
console.log("\nDECLINE_RE - which options count as declining");
const DECLINE_OPTIONS: [string, boolean, string][] = [
  ["Not Specified", true, "THE BUG: the LTS gender question's only non-answer"],
  ["Unspecified", true, "same thing, one word"],
  ["Not listed", true, "another common wording"],
  ["Decline To Self Identify", true, "the classic phrasing still works"],
  ["Prefer not to say", true, "and this one"],
  ["I don't wish to answer", true, "and this one"],

  // Real answers must never be mistaken for a decline - picking one of
  // these would assert something about the candidate they never said.
  ["Man", false, "a real answer"],
  ["Woman", false, "a real answer"],
  ["Non-binary", false, "a real answer"],
  ["Hispanic or Latino", false, "a real answer"],
  ["Yes", false, "not a decline"],
  ["No", false, "not a decline - the SMS opt-out is matched separately, by its own pattern"],
];
for (const [option, want, why] of DECLINE_OPTIONS) {
  const got = DECLINE_RE.test(option);
  const ok = got === want;
  ok ? pass++ : fail++;
  console.log(`  ${ok ? "PASS" : "FAIL"}  declines=${String(got).padEnd(5)} ${JSON.stringify(option)}`);
  if (!ok) console.log(`        expected ${want} - ${why}`);
}

console.log("\nsearchSeed");
for (const [candidate, want, why] of SEEDS) {
  const got = searchSeed(candidate);
  const ok = got === want;
  ok ? pass++ : fail++;
  console.log(`  ${ok ? "PASS" : "FAIL"}  ${JSON.stringify(got).padEnd(16)} <- ${String(candidate).slice(0, 46)}`);
  if (!ok) console.log(`        expected ${JSON.stringify(want)} - ${why}`);
}

// Which "select all that apply" checkbox groups may be answered. Every
// clause in the predicate is a refusal, so every clause gets a case - the
// whole 34-form corpus yields exactly one group that clears them all, and
// the sensitive-category rule then refuses that one too.
const box = (label: string, groupQuestion: string, over: Partial<{ type: string; skipAlways: boolean }> = {}) =>
  ({ label, groupQuestion, type: "checkbox", skipAlways: false, ...over }) as never;

const GROUPS: [string, never[], boolean, string][] = [
  [
    "a real select-all question",
    [
      box("Creating or managing purchase orders", "Which of the following have you had hands-on experience with? Select all that apply."),
      box("Inventory management or replenishment", "Which of the following have you had hands-on experience with? Select all that apply."),
    ],
    true,
    "THE GAP: seven REQUIRED boxes like these were unanswerable on a live Lever posting",
  ],
  [
    "a question mark is enough on its own",
    [box("Python", "Which languages do you use?"), box("SQL", "Which languages do you use?")],
    true,
    "phrased as a question rather than an instruction",
  ],
  [
    "the question is just an option repeated back",
    [box("Performance Cookies", "Performance Cookies"), box("Functional Cookies", "Performance Cookies")],
    false,
    "the cookie-banner shape the snapshot corpus surfaced",
  ],
  [
    "an option repeated back that would otherwise pass the shape test",
    [
      box("Do you have a valid driver's licence?", "Do you have a valid driver's licence?"),
      box("Are you willing to relocate?", "Do you have a valid driver's licence?"),
    ],
    false,
    "options that are themselves questions - the walk grabbed the first one, and it clears the shape test, so only the repeated-back clause refuses it",
  ],
  [
    "page chrome rather than a question",
    [
      box("I consent", "Apply for this job*indicates a required fieldAutofill my application"),
      box("I agree", "Apply for this job*indicates a required fieldAutofill my application"),
    ],
    false,
    "the walk climbed into the form header",
  ],
  [
    "a protected category",
    [box("She/Her/Hers", "What are your pronouns? *"), box("He/Him/His", "What are your pronouns? *")],
    false,
    "the one group in the corpus that clears every other clause - and must still be refused",
  ],
  [
    "consent wording",
    [
      box("Yes", "Do you consent to the processing of your personal data?"),
      box("No", "Do you consent to the processing of your personal data?"),
    ],
    false,
    "as restricted as it is one box at a time",
  ],
  [
    "a single box is not a group",
    [box("Acknowledge", "Which of the following apply? Select all that apply.")],
    false,
    "one checkbox is a consent or acknowledgement, which has its own rules",
  ],
  [
    "a group with no resolved question",
    [box("Option A", ""), box("Option B", "")],
    false,
    "nothing to answer against",
  ],
  [
    "a skipped control in the group",
    [
      box("Option A", "Which apply? Select all that apply.", { skipAlways: true }),
      box("Option B", "Which apply? Select all that apply."),
    ],
    false,
    "a group containing something the scanner already refused is not answered wholesale",
  ],
];

console.log("\nisAnswerableCheckboxGroup");
for (const [name, members, want, why] of GROUPS) {
  const got = isAnswerableCheckboxGroup(members);
  const good = got === want;
  good ? pass++ : fail++;
  console.log(`  ${good ? "PASS" : "FAIL"}  answerable=${String(got).padEnd(5)} ${name}`);
  if (!good) console.log(`        expected ${want} - ${why}`);
}

console.log("\nisTickableAcknowledgement");
for (const c of ACK) {
  const got = isTickableAcknowledgement(c.field as never);
  const ok = got === c.want;
  ok ? pass++ : fail++;
  console.log(`  ${ok ? "PASS" : "FAIL"}  tick=${String(got).padEnd(5)} ${JSON.stringify(c.field.label.slice(0, 58))}`);
  if (!ok) console.log(`        expected ${c.want} - ${c.why}`);
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
