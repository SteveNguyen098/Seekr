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
     there is one; otherwise a live web search for the current market rate
     for that specific role (high confidence, since it's real current
     data); otherwise Claude's own best estimate, marked low-confidence
     since that one's a genuine guess rather than sourced data.
   - "Do you consent to receiving text message/SMS updates about your
     application?" always gets declined ("No, I do not consent..."),
     regardless of the exact phrasing - a standing instruction, not an
     AI judgment call.
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

## Resume tailoring

Right after the best-match job is picked (step 3) and before the form opens,
if `--resume` points at a `.docx` built with the bracket+italic convention
below, the tool generates a tailored copy of it for that specific job and
uploads *that* file instead of the static template - closing the loop
end-to-end while still stopping before submit like everything else.

- **Detection rule**: a section is only treated as tailorable if it has
  *both* square brackets (`[ ]`) *and* italic formatting on the bracketed
  text. Either signal alone is too common in a normal resume (dates and job
  titles are often italic; a bracket can show up on its own) to be a
  reliable marker - the combination is. Word frequently splits text across
  several runs (the `[` character often lands in its own run, separate from
  the text after it), so detection works at the paragraph level and merges
  runs back together before checking.
- **Context per bracket**: primary signal is the section header (e.g.
  "PROFESSIONAL SUMMARY", "CORE SKILLS") plus the immediate surrounding
  paragraph; the bracket's own current content is real material to tailor,
  not a placeholder to invent from scratch. The full resume text and
  `qa_context.txt` are always included too, as supporting/fallback
  context, explicitly labeled lower priority than the local signal.
- **No fabrication, but not silent pass-through either**: replacement text
  can only draw on skills, tools, and claims that already appear -
  verbatim or near-verbatim - somewhere in the resume or `qa_context.txt`.
  If the job description asks for a specific tool (e.g. "Salesforce") but
  neither of those actually confirms it, the output keeps the generic
  category it does support (e.g. "CRM Platform Experience") rather than
  naming a product that was never confirmed - if you *do* have real
  experience with something like that, add it to `qa_context.txt` and it
  becomes fair game to name specifically. This rule is about not inventing
  facts, not about refusing to tailor at all: a list-shaped section (like
  the two skills lines) must always be reordered to put the most
  JD-relevant existing items first, even when nothing new can safely be
  added - leaving it byte-for-byte identical across every job is a bug, not
  a safe default, and was caught and fixed during testing (see Known
  limitations).
- **A reference to independent/personal project work is deliberately
  sticky**: if the source content mentions it, the tailored version keeps
  a reference to it too, regardless of how closely the job description's
  own language happens to overlap with the rest of the resume. It's only
  ever dropped as a last resort if keeping it would clearly overflow the
  page - not as a routine trim.
- **Scope is locked to exactly the detected bracket+italic sections** -
  Professional Experience, Education, Projects, and everything else in the
  document are never touched, regardless of what the job description asks
  for. This isn't a policy layered on top; it's a direct consequence of
  how `applyReplacements()` works - it only ever splices the exact
  `[runXmlStart, runXmlEnd)` span of a detected placeholder, nothing else
  in the document is ever in scope to change.
- **Formatting**: the bracket/italic marking is a detection signal only,
  never preserved in the output - replacement text inherits the same
  run's font/size with the italic tags stripped, so it reads as normal
  body text.
- **Length is verified by actually rendering the file**, not estimated:
  each candidate is converted to a real PDF via Microsoft Word (COM
  automation - font metrics, margins, and line spacing all affect true
  page breaks, so nothing short of real rendering can confirm this), and
  its page count is read back. If a candidate doesn't match the original
  template's page count, it regenerates with explicit feedback ("too
  long, write noticeably shorter" / "too short, write more detail") for
  up to 4 attempts, keeping whichever attempt came closest even if none
  converge exactly - and says so honestly in the log if that happens.
- **File naming**: `[First]_[Last]_Resume_[Company]_[Role].docx`, saved
  into the same `--out` directory as the screenshot. Company and role are
  extracted from the job posting via a small Claude call (scraped titles
  are often messy, e.g. a location run directly onto the title with no
  separator).

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

Resume tailoring additionally requires **Microsoft Word installed on the
machine running the tool** (Windows only, via COM automation - see
`scripts/docx-to-pdf.ps1`) for the page-count verification step. If Word
isn't available, resume tailoring is skipped with a clear warning and the
static `--resume` file is uploaded as-is - nothing else in the pipeline is
affected.

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
- `ats.rippling.com/patientnow` (Rippling ATS - a third platform, structurally
  different from Greenhouse/Lever in ways that mattered, see Known
  limitations)

Each successful run matched a real posting, filled the fields it could
confidently infer, and stopped before submit, with the on-screen form
matching the printed report exactly.

Resume tailoring specifically has been verified live against OneTrust and
Samsara: both converged on the original 1-page layout on the first attempt,
uploaded the tailored file (confirmed via the report's "Attach" line) in
place of the static template, and the generated content was checked
against the source resume line-by-line to confirm nothing was fabricated
(see the no-fabrication note under "Resume tailoring" above - one real
instance of this was caught and fixed during testing).

## Known limitations (POC scope)

- Career page scraping has fast paths for Greenhouse and Lever, and a
  generic link-heuristic fallback for everything else (Workday, Ashby,
  etc. haven't been tested live yet).
- **Field label detection follows real ARIA precedence**
  (`aria-labelledby` → `aria-label` → associated `<label>` → placeholder),
  and field *discovery* isn't limited to real `<input>`/`<select>`/
  `<textarea>` tags - a `[role="combobox"]` element is picked up regardless
  of what tag it's built on. Both were genuine gaps surfaced testing a
  third ATS platform (Rippling), not something anticipated in advance:
  several demographic questions (gender, Hispanic/Latino, veteran,
  disability) render as a bare `<div role="combobox">` with no underlying
  `<input>` at all, invisible to a query that only looked for form-control
  tags - and two fields that *were* discoverable (race, pronouns) exposed
  only a generic "Search"/"Select..." placeholder directly on the control,
  with their real question text only reachable by resolving
  `aria-labelledby`. The second gap was the more serious one: without it,
  the sensitive-field safety net never saw the real label text ("Please
  identify your race") and treated the field as an ordinary open question -
  Claude answered it with a specific, fabricated race rather than
  declining. Confirmed fixed with both bugs closed: all five demographic
  questions now correctly decline on that same live form.
- **Discovering a field isn't the same as it actually getting answered** -
  a second gap on the same round of testing: the code that decides which
  discovered fields get sent to Claude only recognized `SELECT`/`INPUT`/
  `TEXTAREA` tags, so the newly-discoverable `<div role="combobox">` fields
  (state-residency, sponsorship) were found but then silently dropped -
  present in neither the filled nor skipped report, no signal at all that
  they existed. Fixed by also checking `isCombobox` regardless of tag.
- **A generic instruction word standing in for a real label is worse than
  no label at all - it looks trustworthy but isn't.** Confirmed live and a
  genuine near-miss: two Rippling fields (state-residency, sponsorship)
  both exposed `aria-label="Select"` directly on the control, with no
  `aria-labelledby` pointing anywhere else. That's technically a non-empty
  label, so the detection cascade stopped right there - Claude then saw
  two *identical*, contentless "Select" fields with nothing to tell them
  apart, and answered one of them wrong (said "Yes" to needing visa
  sponsorship, backwards from the correct answer). Caught by checking the
  actual screenshot rather than trusting a "field was answered" report at
  face value. Fixed by treating "Select"/"Search"/"Choose" as equivalent
  to no label at all, so the same DOM-proximity fallback used for
  completely unlabeled fields gets a chance to find the real question text
  instead - confirmed both fields now resolve their real labels and answer
  correctly.
- **Live salary research.** Open-ended "what are your salary
  requirements?" questions now get a real web search for current market
  data (via the Anthropic SDK's hosted web-search tool) rather than relying
  only on Claude's trained knowledge, which can be stale - a standing
  instruction, only triggered when such a question actually exists on the
  form (the separate yes/no "do you accept the listed range" shape doesn't
  need it). Runs as its own small call, not part of the main batched
  answer call, since that one forces a specific structured-output tool
  choice that isn't compatible with the back-and-forth a search-enabled
  call needs - the research findings get folded into the main prompt as
  grounding instead.
- **Checkboxes/radios that are visually hidden behind a custom-styled
  replacement** (common in modern component libraries - the real `<input>`
  has zero size/opacity and a sibling element carries the actual visible,
  clickable UI) fall back to clicking whatever the input's
  `aria-labelledby` resolves to, since Playwright correctly refuses to
  click something that isn't actually visible. Confirmed live on the same
  Rippling form: a plain `.check()` timed out on every radio/checkbox
  until this fallback was added.
- **A file upload can succeed even when the native `<input>` reports zero
  files afterward.** Confirmed live: one widget keeps the same upload
  input in the DOM but resets its own `.files` the instant it consumes the
  selection into its own state - visually the upload clearly succeeded (a
  filename chip replaced the dropzone), but the file input itself looked
  empty. Before concluding a real failure, the tool now checks whether a
  distinctive prefix of the uploaded filename shows up anywhere on the
  page.
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
  their inputs (`aria-labelledby`, `aria-label`, `<label for>`, wrapping
  `<label>`, or placeholder text). Fields with none of these are always
  left blank rather than guessed at - on more complex forms this can leave
  a couple dozen fields unlabeled and skipped. Confirmed live on
  PatientNow's Rippling-hosted form: three fields (salary requirements,
  start date, referral source) genuinely expose no label through any of
  these signals at all - a real remaining gap, not something the
  `aria-labelledby` fix above resolved, since there's simply nothing to
  resolve for these particular fields.
- The phone number field on that same Rippling form is reported as failed
  ("entered ... but it did not persist") even though it actually does get
  filled correctly - the widget silently reformats whatever's typed into
  it, and the verification check compares exact strings. A cousin of the
  file-upload false-negative above, not yet given the same treatment.
- **Resume tailoring requires Word (Windows only)** for the page-count
  verification. It degrades gracefully without it - a warning is logged
  and the static resume file is uploaded instead - but there's currently
  no LibreOffice or cross-platform fallback path.
- **Resume tailoring only detects the bracket+italic convention exactly as
  specified** - a template that marks placeholders a different way (bold
  instead of italic, curly braces instead of square brackets, highlighting)
  won't be picked up. This is by design (the dual signal is what keeps
  false positives out), but it does mean the source template has to follow
  the convention for anything to be detected at all.
- **The page-count retry loop caps at 4 attempts.** If tailored content
  can't converge on the original page count within that many tries, the
  closest attempt is still saved and used, but the log flags it clearly as
  non-convergent so it gets extra scrutiny before submitting - it isn't
  silently passed off as a perfect match.
- Company/role extraction for the tailored resume's filename is itself an
  LLM call against the job description - on a very unusually formatted
  posting it could occasionally mislabel the company or role in the
  filename (the resume's *content* is unaffected either way, since that's
  driven by the actual job description text, not the extracted filename
  labels).
- **A real bug was caught in QA testing across two different job
  descriptions**: the Technical Skills line came back byte-for-byte
  identical to the source template both times, while Core Competencies
  correctly changed each time. Root cause was prompt conservatism, not a
  code bug (confirmed by inspecting Claude's raw responses directly -
  Claude was answering that section every time, just choosing not to
  change it). The original no-fabrication instruction was strong enough
  that Claude treated "any list containing named tools" as too risky to
  touch at all, rather than distinguishing "reordering real items" (always
  safe) from "adding new items" (needs grounding). Fixed by explicitly
  requiring list-shaped sections to always reorder by relevance even when
  nothing new can safely be added - verified fixed by re-running the same
  two job descriptions and confirming the two skills lines now produce
  genuinely different orderings per job, with the independent-project
  sentence preserved in both and no new fabricated tools in either.
