# Seekr auto-apply POC

Minimal proof of concept for Seekr's core loop: given a career page URL and a
resume, find one matching job and fill out its application form.

## What it does

1. Scrapes a career page (Playwright) for job postings.
2. Filters postings by keyword match against target titles, and by hard
   requirements (years of experience, salary floor, employment type,
   location) found in the full job description - see `criteria.json`.
3. Sends the surviving candidates to the Claude API to rank them against the
   resume and pick the single best match. Below a configurable minimum
   score, it refuses to fill anything rather than force a weak match.
4. Opens that job's application form and fills in what it can confidently
   answer, then **stops before submitting**. Sources, in order of trust:
   - **Resume**: name, work history, skills.
   - **`user_profile.txt`** (optional, gitignored): address, city, state,
     zip, country, phone/phone country code.
   - **`work_auth_context.txt`** (optional, gitignored): citizenship/
     sponsorship ground truth, used to answer those questions directly -
     including ones rendered as custom dropdowns, via real click-to-open,
     find-the-matching-option, click interaction (typing alone gets
     silently discarded by these widgets - see `selectComboboxOption` in
     `src/apply.ts`).
   - **`qa_context.txt`** (optional, gitignored): your own canned answers
     for common screening questions (why leaving your role, salary
     expectations, relocation, start date, etc.) - used verbatim/adapted,
     never contradicted.
   - **Claude, grounded in the job description + company info**: for
     open-ended questions not covered above (e.g. "why this company"),
     generating a specific, non-generic answer rather than a template.
5. EEOC/demographic questions (gender, race, veteran/disability status)
   always get an active "Decline to answer" style selection when the form
   offers one - never guessed at, never left at a blank default, never
   written to any file (session-only).
6. **Narrow-scope consent is auto-agreed**, whether it's rendered as a
   checkbox or a dropdown. A field asking you to consent to standard
   "process my data to consider my application" recruitment processing
   gets automatically checked/selected - this is required to submit and
   consistent with the point of running the tool. Anything broader
   (marketing use, third-party sharing, indefinite retention for unrelated
   purposes) is always left for you instead. This also covers bare
   GDPR-style labels with no "consent"/"acknowledge" wording at all (e.g.
   a real OneTrust field labeled exactly "Data Protection Notice") - its
   only real option was `Acknowledge/Confirm`, mechanically identical to
   the "process my personal data" case, just EU-style phrasing.
7. A handful of specific questions get fixed, deterministic answers rather
   than an LLM guess, so there's no risk of a fabricated personal story:
   - "AI policy for interviewers/applicants" style questions → "No".
   - "How did you hear about **this opportunity/role**" → "LinkedIn" (or
     the closest available equivalent). The more generic "how did you hear
     about **us/the company**" → "online research"/"careers page" instead.
     Both patterns match "did you hear/find/learn" *and* "have you
     heard/found/learned" phrasing - a real Samsara field ("Where **have**
     you learned about Samsara?") used the latter and was missed by an
     earlier version of this regex, which is why it looked like flaky AI
     behavior when it was actually a routing gap.
   - Salary/compensation questions come in two shapes, answered
     differently: a yes/no "do you accept the range listed in this
     posting?" gets a confident "Yes" whenever the job description states
     a range (submitting the application already implies you've seen and
     are fine with it). An open-ended "what's your desired salary?"
     follows `qa_context.txt`'s tiered logic instead: the listed range if
     there is one, otherwise Claude's best estimate for the role/location,
     otherwise a flat default - and that one *is* marked low-confidence,
     since it's a genuine estimate rather than a stated fact.
8. Every field the tool couldn't confidently fill is listed in a
   **required vs. optional** breakdown. Required detection checks the real
   HTML `required`/`aria-required` attribute first, and falls back to a
   visible asterisk in the label only when that attribute is absent.
   Fields marked required are never allowed to come back with an empty
   AI-generated answer - Claude must always give its best-effort value (and
   gets one firmer-worded retry if it doesn't), but flags it
   **low-confidence** when it had to extrapolate rather than answer from
   something concrete. Low-confidence answers are called out in their own
   review section, separate from ordinary AI-generated answers and
   ground-truth (resume/profile) fills - same idea as reviewing a generated
   cover letter before it goes out. Required **multi-select** fields get a
   further fallback beyond that retry: if the list-shaped `values` answer
   is still empty afterward, one more request asks for just a single
   best-fit option through a simpler schema instead of a full list -
   trading completeness for a guaranteed non-empty answer, always marked
   low-confidence since it's a narrowed pick.
9. Right before the screenshot, every plain text field it filled gets
   **re-checked one more time** against the live page and, if needed,
   repaired. A field can be correctly filled and verified early in a run
   and still end up looking empty by the end - on a heavy form (Samsara's
   iframe-embedded widget in particular), something that happens later
   (opening/closing several other dropdowns, a form-wide re-render) can
   silently reset an already-filled input. This final pass catches that:
   it tries one repair fill, and if the value still doesn't stick, the
   field is honestly moved to "skipped" instead of the report overclaiming
   it's still filled in.
10. Leaves a screenshot (and, in `--headed` mode, the live browser) so you
    can review and submit manually.

## Personal context files (optional, gitignored)

Drop these in `mvp/` to get the behavior described above. All three are
listed in `.gitignore` and are never meant to leave this machine:

- `user_profile.txt` - plain `Key: Value` lines: `Address`, `City`,
  `County`, `State`, `Zip`, `Country`, `Phone Country Code`, `Phone Number`.
- `qa_context.txt` - free text: your own answers to common screening
  questions, one question (or "question A" / "question B") per paragraph.
- `work_auth_context.txt` - free text: a couple of sentences on
  citizenship/sponsorship status.

None are required - the tool runs fine without them, it just leaves more
fields for manual review.

## Setup

```bash
npm install
npx playwright install chromium
cp .env.example .env   # then add your ANTHROPIC_API_KEY
```

## Run

```bash
npx tsx src/index.ts \
  --career-url "https://job-boards.greenhouse.io/attentive" \
  --resume "./path/to/resume.docx" \
  --criteria "./criteria.json"
```

- `--career-url`: a company's career/job-listings page.
- `--resume`: path to a `.docx` or `.txt` resume.
- `--criteria`: path to a JSON profile with target titles and screening
  rules (see `criteria.json` for a real example). Reusable across runs -
  this is the recommended way to run repeated testing sessions.
- `--titles`: comma-separated keywords matched against job titles. Only
  needed if you're not using `--criteria`, or want to override its titles.
- `--max-years`, `--min-salary-annual`, `--min-salary-hourly`,
  `--require-full-time-or-cth`, `--locations`, `--min-score`: override the
  corresponding field from `--criteria` for a single run.
- `--out` (optional): where to save the application screenshot (default `./out`).
- `--headed` (optional): launch a visible browser window instead of running
  headless, so you can watch it work and submit manually at the end.

## Verified against (live, as of this writing)

- `job-boards.greenhouse.io/attentive` (Greenhouse)
- `job-boards.greenhouse.io/gusto` (Greenhouse)
- `job-boards.greenhouse.io/checkr` (Greenhouse)
- `job-boards.greenhouse.io/onetrust` (Greenhouse)
- `job-boards.greenhouse.io/iterable` (Greenhouse)
- `job-boards.greenhouse.io/samsara` (Greenhouse, embedded via iframe on
  Samsara's own branded domain - see below)
- `jobs.lever.co/palantir` (Lever)

Each successful run matched a real posting, filled the fields it could
confidently infer, and stopped before submit, with the on-screen form
matching the printed report exactly.

## Known limitations (POC scope)

- Career page scraping has fast paths for Greenhouse and Lever, and a
  generic link-heuristic fallback for everything else (Workday, Ashby,
  etc. haven't been tested live yet).
- **Custom combobox/react-select-style dropdowns are answerable**, not
  skipped outright. Since the option list for a combobox doesn't exist
  until it's actually opened, the tool opens it once first to harvest the
  real, exact options and hand them to Claude (same treatment a native
  `<select>` already gets), then opens it again to click whichever option
  matches. Reading options is scoped to the specific listbox the field
  controls (via `aria-controls`) rather than a page-wide query - some ATS
  pages keep an unrelated widget's listbox mounted in the DOM even when
  it's not visibly open (e.g. a ~250-item phone/country-code picker), and
  an unscoped query would silently mix those into every other dropdown's
  results. A combobox with no matching option among what's actually
  rendered is left for manual review rather than guessed at.
- **Multi-select ("select all that apply") fields are supported**,
  detected via `aria-multiselectable` on the listbox or `.multiple` on a
  native `<select>`. Claude can return a list of values for these instead
  of a single one, and execution clicks each match in sequence without
  closing the dropdown in between (multi-select widgets stay open across
  picks, unlike a single-select which closes after one). This was the
  least reliable field type in practice: the array-shaped answer Claude
  has to return for these is unlike every other field, and it would
  sometimes come back empty even after the ordinary required-field retry -
  a soft prompt-compliance gap tied to that shape, not the specific
  question. One concrete instance of this turned out to have a real fix
  (see the how-did-you-hear routing note above), and the remaining gap now
  has its own fallback: a required multi-select still empty after the
  retry gets one more request through a simpler single-value schema before
  it's left for manual review, always flagged low-confidence since it's a
  narrowed pick rather than a full answer. This meaningfully reduces, but
  doesn't provably eliminate, the chance of a multi-select field needing
  manual completion - LLM output isn't a hard guarantee no matter how many
  fallback layers wrap it.
- No live web search. Salary-range research and company-specific answers
  rely on Claude's own trained knowledge plus whatever the job description
  itself says (which usually includes an "About [Company]" section) -
  not a real-time search. This is a deliberate scope call for the POC, not
  a technical ceiling; wiring up Anthropic's hosted web-search tool would
  be the natural next step if accuracy here matters more than it does now.
- EEOC-style questions rendered as a **radio button group** (rather than a
  dropdown) aren't answered yet - reliably identifying which specific radio
  corresponds to "decline to answer" (vs. its sibling options) needs
  matching against each radio's own associated label text, which isn't
  built. Still left for manual review, same as before.
- City/location autocompletes are disambiguated with "City, State" when
  both are known (there are multiple US cities named Decatur, Springfield,
  etc., and a bare city name can silently match the wrong one) - but this
  only helps when `user_profile.txt` has a state on file.
- **Company-embedded application forms are supported, including
  cross-origin iframes** (e.g. Samsara embeds Greenhouse's form via
  `job-boards.greenhouse.io/embed/job_app` inside an iframe on
  `samsara.com`). `findFormContext()` scans the main page and every frame
  for whichever one actually holds the form fields and operates on that.
- **Bot detection can block the flow entirely.** Palantir's Lever form
  presented a CAPTCHA challenge partway through filling. The tool makes no
  attempt to solve or bypass these (and never should) - it's a hard stop
  that requires a human. Not every ATS/company site will be automatable
  for this reason.
- Cover letter upload is not generated/attached.
- Resume parsing supports `.docx` and `.txt` only (no `.pdf` yet).
- Field discovery relies on labels being programmatically associated with
  their inputs (`aria-label`, `<label for>`, wrapping `<label>`, or
  placeholder text). Fields with no such association are always left
  blank rather than guessed at - on more complex forms this can leave a
  couple dozen fields unlabeled and skipped.
