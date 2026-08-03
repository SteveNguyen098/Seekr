# Seekr auto-apply POC

Minimal proof of concept for Seekr's core loop: given a career page URL and a
resume, find one matching job and fill out its application form.

## What it does

1. Scrapes a career page (Playwright) for job postings.
2. Filters postings by keyword match against target titles, and by hard
   requirements (years of experience, salary floor, employment type,
   location) found in the full job description - see `criteria.json`. A
   stated regional/timezone preference that doesn't match the candidate's
   own location (e.g. "prioritizing candidates in the Central Standard
   time zone") is deliberately **not** a hard-requirement skip - it's a
   soft-fit signal, printed as a flag (with the exact matched phrase and
   surrounding context) right before the resume is generated, so there's
   a chance to review and abort manually if it matters. See
   `detectLocationPreference()` in `src/filter.ts`.
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
   a real Greenhouse-hosted field labeled exactly "Data Protection Notice") - its
   only real option was `Acknowledge/Confirm`, mechanically identical to
   the "process my personal data" case, just EU-style phrasing. Also covers
   consent to *store* the answers just given to an EEOC/demographic survey
   on the same form (e.g. "By checking this box, I consent to \[company]
   collecting, storing, and processing my responses to the demographic data
   surveys above") - narrow by construction, since those answers are always
   "prefer not to say" by the time this runs and the consent is scoped to
   this one application, not a blanket data-sharing agreement.
7. A handful of specific questions get fixed, deterministic answers rather
   than an LLM guess, so there's no risk of a fabricated personal story:
   - "AI policy for interviewers/applicants" style questions → "No".
   - "How did you hear about **this opportunity/role**" → "LinkedIn" (or
     the closest available equivalent). The more generic "how did you hear
     about **us/the company**" → "online research"/"careers page" instead.
     Both patterns match "did you hear/find/learn" *and* "have you
     heard/found/learned" phrasing - a real field on one live test site
     ("Where **have** you learned about us?") used the latter and was
     missed by an earlier version of this regex, which is why it looked
     like flaky AI behavior when it was actually a routing gap.
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
   and still end up looking empty by the end - on a heavy form (an
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
- **Terminology stays consistent across runs, deterministically.** The
  LLM doesn't always phrase the same underlying fact the same way twice -
  a real run once wrote "CRM Platforms" in Technical Skills while Core
  Competencies (and every other run) used "CRM Platform Experience,"
  making otherwise-identical resumes look inconsistent side by side.
  Rather than relying on the prompt alone to hold the line, every skills-
  section replacement now passes through a deterministic normalization
  pass (`normalizeCrmTerminology()`) that collapses any CRM-related
  phrasing to the one canonical wording, regardless of what the LLM
  emitted. Scoped to the two skills sections only - forcing that exact
  noun phrase into the prose Professional Summary would read awkwardly
  there.
- **Surfaces the most specific genuinely-true match, not generic
  framing.** When a job description specifically emphasizes systems
  administration, IT infrastructure, or hands-on technical systems
  management, and the candidate's resume actually contains that kind of
  experience (a System Administrator role - device/endpoint management,
  Intune, Google Admin, network infrastructure), the Professional Summary
  now explicitly names it instead of defaulting to vaguer "systems-minded"
  language. This is still bound by the same no-fabrication rule above -
  it only surfaces something that's genuinely already in the resume, for
  the job descriptions where it's genuinely the most relevant thing to
  lead with. Confirmed live: a job description emphasizing HR-systems
  administration produced a Summary opening with "hands-on experience
  administering technical systems (including device/endpoint management
  via Intune and Google Admin)" - naming the real, specific experience
  rather than the generic phrasing a less specific version of this prompt
  had been producing.
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
  --career-url "https://job-boards.greenhouse.io/<company>" \
  --resume "./path/to/resume.docx" \
  --criteria "./criteria.json"
```

- `--url`: a link that could be *either* a single job posting or a career
  page - `classifyUrl()` inspects the live page and routes it to whichever
  of `--job-url`/`--career-url` below actually applies, so the caller
  doesn't have to know which kind of link they have. Prints its verdict and
  why (e.g. "a single job posting (has an apply action and a full
  description)"); an unrecognized link runs nothing rather than guessing.
  This is what the desktop app always uses.
- `--job-url`: skip scraping/filtering/ranking and apply directly to one
  already-known posting.
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

## Desktop app (optional UI)

`../desktop` is a minimal Electron shell around this same CLI - a UI
wrapper, not a reimplementation. It spawns `src/index.ts` exactly as a
terminal would and streams its output into a window; no scraping,
filtering, tailoring, or form-filling logic lives in `desktop/` or is
duplicated there. Delete that folder and the CLI still works identically.

What it adds on top of the CLI:
- **One field, not several**: paste a link and hit Run. `--url` auto-detection
  (above) means there's no job/board choice to make.
- **The resume template is remembered**, not re-selected every run -
  persisted in Electron's own settings storage, defaulting to
  `Seekr Resume Template.docx` next to the repo. A template is meant to be
  chosen once and reused, so it's configuration, not a per-run input.
- **Results render in the window** - the matched job, filled/skipped
  fields (tagged AI-generated / low-confidence / required), flow notes, and
  links to open each page's screenshot - read from an optional
  `--json-out <path>` flag on the CLI that writes a machine-readable copy of
  the same report already being printed. Console output is unchanged and
  nothing behaves differently when the flag is absent.
- **The verification-code pause works with no code changes**: the CLI
  blocks on stdin waiting for Enter, so the shell watches for that prompt,
  shows a Continue button, and writes a newline when clicked - precisely
  what pressing Enter in a terminal does.

Launch: double-click the `Seekr` shortcut (or `desktop/Seekr.vbs` directly)
for normal use, no terminal. `desktop/dev.bat` runs `electronmon` for
hot-reload while iterating on the UI.

**Playwright still opens its own separate browser window** - it is not
embedded inside the app window. Embedding it is a larger piece of future
work, not this wrapper.

## Verified against (live, as of this writing)

Tested against real, live job postings on four ATS platforms (company
names withheld - these are real employers' live sites, not test fixtures):

- **Greenhouse** (`job-boards.greenhouse.io/<company>`) - 7 boards, including
  two embedded on the hiring company's own branded domain (one via a
  cross-origin iframe, one directly on the job page itself) - see Known
  limitations for what those surfaced. One of these was the first run,
  through either the CLI or the desktop app, to reach a real 21-field
  application and fill it correctly end-to-end: identity/contact fields,
  the stated compensation range, work authorization and demographic
  questions, consent, and the résumé upload itself.
- **Lever** (`jobs.lever.co/<company>`) - 1 board.
- **Rippling ATS** (`ats.rippling.com/<company>`) - 1 board; a third
  platform, structurally different from Greenhouse/Lever in ways that
  mattered, see Known limitations.
- **Ashby** (`jobs.ashbyhq.com/<company>`) - 1 board; a fourth platform -
  its own EEOC radio groups and Yes/No screening-question button pairs
  each surfaced their own distinct shape, see Known limitations.
- **Oracle HCM Cloud** (Oracle Recruiting / "Candidate Experience") - 1
  posting; a fifth platform and the hardest so far. It's the first with a
  genuine anti-bot honeypot, the first multi-page application, and the
  first requiring an emailed verification code. **Confirmed live reaching
  page 6** of a real application - résumé tailored and upload attempted,
  cookie/consent/honeypot handling all correct, verification pause/resume
  working end-to-end - but **still incomplete**: several required
  questions aren't discovered at all, and the multi-page loop wastes real
  work re-processing already-filled fields. See the Oracle-specific
  bullets under Known limitations for the exact, honest breakdown.

Each successful run matched a real posting, filled the fields it could
confidently infer, and stopped before submit, with the on-screen form
matching the printed report exactly.

Resume tailoring specifically has been verified live against two of the
Greenhouse-hosted boards above (including the iframe-embedded one): both
converged on the original 1-page layout on the first attempt, uploaded the
tailored file (confirmed via the report's "Attach" line) in place of the
static template, and the generated content was checked against the source
resume line-by-line to confirm nothing was fabricated (see the
no-fabrication note under "Resume tailoring" above - one real instance of
this was caught and fixed during testing).

## Known limitations (POC scope)

- Career page scraping has fast paths for Greenhouse and Lever, and a
  generic link-heuristic fallback for everything else (Workday hasn't been
  tested live yet). Confirmed live that the fallback doesn't work on
  Ashby's listing pages specifically - a real Ashby-hosted listing page
  returns 0 postings from `listJobs()` even though the site clearly has
  openings - so applying to a specific known Ashby job currently means
  pointing directly at that job's own URL rather than the company's
  listing page. Not investigated further since it wasn't blocking (the
  specific job URL was already known); the fix, if needed later, is
  presumably an Ashby-specific listing-page selector alongside the
  existing Greenhouse/Lever ones.
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
- **A stated salary has to actually reach the prompt to be used.** The job
  description is truncated to a fixed prefix before being sent to Claude
  (descriptions run long and most of the tail is boilerplate) - but a plain
  slice can cut off the one detail a question depends on. Confirmed live: a
  posting stated "Compensation $58,000-$65,000 USD" 157 characters past the
  cutoff, so Claude never saw it and answered from trained knowledge
  instead - while the code was simultaneously and correctly skipping live
  salary research on the grounds that the posting already stated a figure.
  Those two behaviors only make sense together if the figure actually
  reaches the prompt. `jdForPrompt()` keeps the same prefix length but
  appends a short excerpt around any salary figure found beyond it, rather
  than widening the cutoff for every job.
- **A link doesn't need to be pre-classified as a job posting or a career
  page.** `classifyUrl()` inspects the live page - many posting-shaped
  links (matched both by URL vocabulary like `/jobs/`, `/careers/` and by
  opaque id shape, since some platforms use `/<company>/<uuid>` with no
  such word anywhere in the path) means a board; an apply action plus a
  substantial description means a posting. Structure wins over URL
  patterns, which are unreliable on their own - plenty of boards live at
  `/careers/jobs` and plenty of single postings at `/careers/<slug>`. An
  unrecognized link is reported plainly and nothing is run, rather than
  guessing. This is what `--url` (and the desktop app, which always uses
  it) is built on.
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
- **EEOC-style demographic questions (gender, race, veteran status)
  rendered as a radio button group are now auto-declined, not just left
  blank.** This used to be a real gap: reliably identifying which specific
  radio corresponds to "decline to answer" (vs. its sibling options) needed
  matching against each radio's own associated label text, which wasn't
  built. Confirmed live on Ashby that this is actually straightforward:
  every EEOC radio group shares one native `name` attribute across its
  options (the real HTML grouping mechanism), and the group's shared
  question text ("Gender") lives in a `<label>` that's a *direct child* of
  the group's `<fieldset>` - a different, more reliable signal than each
  individual option's own label ("Male"), which is all `discoverFields()`
  saw before. `fillApplication()` now groups radios by that shared `name`
  before its main field loop runs, tests the group's *question* (not any
  one option) against the same `SENSITIVE_RE` used for combobox/select
  EEOC fields, and - only for a group that matches - finds and clicks
  whichever option's own label matches the same decline-phrasing regex
  already used elsewhere (`DECLINE_RE`: "decline", "prefer not", "I don't
  wish/want to answer", etc.). This never guesses at an actual demographic
  answer, the same as the combobox/select version of this feature always
  has - it only ever selects a real "decline" option, or leaves the whole
  group alone if one genuinely isn't found. Confirmed live: Gender, Race,
  and Veteran Status all now correctly show their own "decline"/"prefer
  not to self-identify" option selected.
- **Routine Yes/No screening questions (work authorization, visa
  sponsorship) are answered, not skipped**, even when they visually look
  like the same kind of radio/checkbox control the EEOC bullet above still
  leaves alone. Confirmed live on Ashby that these don't actually use a
  real `<input type="radio">` pair at all -
  it's a single hidden `<input type="checkbox" tabindex="-1">` present only
  for the site's own internal form state, with the real clickable UI being
  two plain `<button>` elements ("Yes"/"No") sitting alongside it as
  siblings. Without recognizing this shape, both questions fell into the
  same generic "always skip checkbox/radio" bucket as genuinely sensitive
  EEOC fields, even though they're routine and answerable from
  `work_auth_context.txt`. Fixed by harvesting the sibling buttons' text
  into the field's options during discovery, routing any such field
  through the normal Claude-answering pipeline (still gated by the same
  sensitive-field check first, so a question that happened to match EEOC
  wording would still be left alone even in this shape), and clicking the
  matching button instead of trying to check/fill the hidden input
  directly. Confirmed live: work authorization correctly answers "Yes" and
  sponsorship correctly answers "No", while Gender/Race/Veteran Status on
  that same form are independently handled by the EEOC auto-decline logic
  above rather than this path (the two features are mutually exclusive by
  construction: EEOC radios have no sibling `<button>`s to harvest into
  `options`, and non-EEOC choice-button questions never match
  `SENSITIVE_RE`).
- **City/location autocompletes are disambiguated with "City, State"**
  when both are known (there are multiple US cities named Decatur,
  Springfield, etc., and a bare city name can silently match the wrong
  one) - but this only helps when `user_profile.txt` has a state on file,
  and only for a field whose label actually contains "city" or "current
  location" (an alias added after a live Ashby field labeled exactly
  "Current Location" was found not to match the original "city"-only
  check and fell through to an unrelated Claude guess instead - see the
  label-masking bullet below for why that guess wasn't even a well-
  grounded one).
- **A non-empty but useless placeholder can mask a real label sitting
  right next to it, the same way "Select"/"Search" did.** Confirmed live
  on Ashby: "Current Location"'s `<label for="X">` points at an `X` its
  real `<input>` doesn't actually have as its `id` - the label and input
  are just siblings in the same wrapper, never actually connected via
  `for`/`id` at all (the same broken-association pattern also seen on the
  work-authorization field above). Every signal ahead of placeholder in
  the label cascade came up empty, so it settled for the input's own
  `placeholder="Start typing..."` - a non-empty string, so the
  DOM-proximity fallback never got a chance to run and find the real
  "Current Location" text one level up. Unlike the earlier "Select"/
  "Search" fix, this wasn't caught by wrong-but-plausible-looking output -
  it was caught by checking the *report itself*, where the field's own
  displayed label read "Start typing..." instead of a real question,
  which was the tell. Fixed by extending the same generic-instruction-word
  check to also cover "Start typing"/"Type here", resetting them to empty
  so the proximity fallback runs, the same as it already did for "Select"/
  "Search"/"Choose".
- **A CSS-only required asterisk is invisible to both the real
  `required`/`aria-required` attribute check and the textContent-based
  asterisk fallback.** Confirmed live: "Current Location*"'s visible red
  asterisk is painted entirely via `label::after { content: "*" }` - not
  part of the label's actual text at all - so the field was being reported
  as optional even though the form genuinely blocks submission without it.
  `getComputedStyle(labelEl, "::before"/"::after").content` is a
  standards-based, portable check (not tied to any one site's class
  names) added as a third signal, checked against both places a real
  associated `<label>` element is ever found (`label[for]`, or a wrapping
  `<label>`) independent of which cascade step actually supplied the
  field's label text.
- **Company-embedded application forms are supported, including
  cross-origin iframes** (e.g. one live test site embeds Greenhouse's form
  via `job-boards.greenhouse.io/embed/job_app` inside an iframe on its own
  branded domain). `findFormContext()` scans the main page and every frame
  for whichever one actually holds the form fields and operates on that.
- **Bot detection can block the flow entirely.** One Lever-hosted test
  site's form presented a CAPTCHA challenge partway through filling. The tool makes no
  attempt to solve or bypass these (and never should) - it's a hard stop
  that requires a human. Not every ATS/company site will be automatable
  for this reason.
- **Only a CAPTCHA a human can actually see is treated as that hard stop -
  not merely the presence of one.** The multi-page loop's own CAPTCHA check
  originally fired on any frame whose URL contained "captcha," which
  includes Google's *invisible* reCAPTCHA - a background frame present on
  essentially every Greenhouse-embedded form, scoring the session passively
  with nothing rendered to solve. Because the check runs before filling, a
  real run aborted with zero fields filled on a form that had 31 perfectly
  fillable ones. Detection now requires an element of meaningful size
  (≥100×40 - an invisible reCAPTCHA's anchor iframe is `0x0` or a small
  badge, a real checkbox widget is ~300×75) that isn't hidden/transparent,
  or text that genuinely asks the user to prove they're human (not just any
  page mentioning the word "reCAPTCHA," as every Greenhouse privacy footer
  does). The underlying promise is unchanged - it still never attempts to
  solve or bypass anything, and an escalation to a real challenge mid-flow
  renders a visible widget, which the size check still catches. Verified
  both directions: the Greenhouse form above no longer stops, and Google's
  own reCAPTCHA demo page - a genuine visible challenge - still does.
- **A hidden "Apply" button used to abort the entire run.** Opening the
  application form picked whichever element matched `a/button:has-text
  ('Apply')` first, regardless of visibility - and career sites routinely
  carry hidden duplicates (a collapsed mobile menu, off-screen nav).
  Clicking one blocked for Playwright's full 30-second actionability
  timeout and then threw an exception nothing caught, crashing the process
  before a single field was touched. It now picks the first *visible*,
  enabled candidate with a short timeout, and treats the click as
  best-effort rather than required - plenty of forms sit directly on the
  job page with nothing to click at all, which field discovery below is
  the real test of, not a successful Apply click.
- **Anti-bot honeypot fields are detected and left empty.** A real Oracle
  HCM Cloud application carries one, and it defeats every standard
  visibility check: Playwright's `isVisible()`, the DOM's
  `checkVisibility()`, computed `display`/`visibility`/`opacity`,
  zero-size, and off-screen position all report it as an ordinary visible
  199x38 input. It hides via a `height:0; overflow:hidden` **ancestor**, so
  its own box is perfectly normal. The signal that actually separates it
  from legitimately-hidden-but-real controls is `aria-hidden="true"`,
  backed by a name/id match and a fill-time hit-test. That hit-test must
  be **self-or-descendant**: the topmost element at the honeypot's own
  centre is its *ancestor*, so accepting an ancestor match reports the trap
  as perfectly reachable - which is exactly how the first version of this
  guard silently passed it.
  Controls whose `aria-labelledby` resolves to a *visible* partner are
  exempted before that hit-test runs, and the ordering is load-bearing: a
  required consent checkbox and a whole platform's radio/checkbox controls
  are `0x0` by design, and reversing the order skips them and dead-ends the
  form. Inconclusive verdicts never skip - a real field vanishing from a
  fill is invisible in a report, so the guard fails open and flags a
  `0x0`-with-no-visible-partner field as a note instead.
  Two follow-on fixes, both from a run that reached a real 21-field
  application: (1) **file inputs are now exempt from the reachability check
  entirely**, not merely from the note above - a Greenhouse résumé-attach
  input renders `1x1` under a styled dropzone, so the hit-test correctly
  said "blocked" and silently dropped the résumé upload, the single most
  important field on the form; `setInputFiles()` writes to the element
  directly and was never a reachability question to begin with. (2) `aria-
  hidden` and "named like a honeypot" are now reported as the distinct
  signals they are, instead of both saying "anti-bot honeypot" - the former
  overwhelmingly turns out to be a widget's own internal plumbing (a
  react-select-style combobox renders a hidden duplicate input purely to
  carry required-field validation, so one visible dropdown yields two
  discovered fields), and calling that a security trap was both alarming
  and wrong. Both are still correctly skipped; only the report changed.
- **Multi-page applications are supported** - the filler loops
  fill -> find Next/Continue -> click -> confirm the step actually
  advanced -> re-discover, capping at 10 pages with a screenshot per page.
  Submit is never clicked; the loop simply exits when only a submit
  control remains. "Advanced" is judged by comparing the *identity* of the
  form controls on the page, not a snapshot of its text: a failed Next
  injects validation-error text, which changes the text but not the step,
  and an earlier text-based check read that as progress and re-filled the
  same page until the page cap.
- **A verification code pauses the run rather than failing it.** Oracle
  HCM Cloud (and platforms like it) email a one-time code instead of
  requiring an account. In `--headed` mode the run pauses so you can type
  the code in the browser and press Enter to continue, with a timeout so
  an unattended run can't hang; headless runs exit cleanly, since nobody's
  there to enter it.
  **A real run exposed a serious bug in this before it ever worked right:
  the pause was filling the page before checking whether it needed to
  pause at all.** The six "enter verification code digit N of six" boxes
  were discovered as ordinary required fields, and since Claude obviously
  can't know a code emailed to a human, the "required fields must never
  come back empty" rule forced an answer anyway - it typed `0` into all
  six, confirmed live via the printed report and the saved screenshot. By
  the time the pause appeared asking for the real code, every box was
  already full, so the code had nowhere to go, Verify failed, and the run
  ended having quietly sabotaged the exact step it stopped to wait for.
  Fixed three ways: the verification check now runs *before* filling, so
  the boxes stay untouched; any field matching a code-input pattern is
  also skipped by its own label regardless of the page-level check, as a
  second line of defense in case the wording check ever misses a variant;
  and the advance button on that screen reads "VERIFY," not
  "Next"/"Continue," which the button vocabulary didn't originally
  include (verified safe: "Verify and Submit" is still correctly refused,
  "Send New Code" still isn't clicked).
- **Confirmed live: a run now gets deep into a real, multi-page Oracle
  HCM Cloud application - six pages, not one.** Tailored résumé generated
  and its upload attempted, cookies/consent/honeypot all handled
  correctly, and the verification pause → resume → advance sequence
  working end-to-end for the first time. This surfaced three genuine gaps,
  none of them a wrong answer - just fields the tool never got the chance
  to see or handle efficiently, because no page this deep had ever been
  reached before:
  - **Yes/No questions rendered as plain `<button>` pairs with no backing
    form-control element at all** (work authorization, visa sponsorship,
    and several "minimum requirement" questions, all required) are
    invisible to `discoverFields()`, which only queries
    `input, textarea, select, [role=combobox]`. They don't show up as
    skipped-with-a-reason - they don't show up at all, since there's
    nothing there to discover. Not yet fixed.
  - **Oracle keeps every completed page's fields sitting in the DOM as
    later pages load**, so per-page re-discovery finds and re-attempts
    all of them again on every subsequent page - hugely inflating runtime
    and producing a wall of duplicate "failed to fill" entries for fields
    that were, in fact, already filled correctly earlier in the run. Not
    yet fixed; needs tracking already-filled selectors across the whole
    run, not just within one page.
  - **EEOC questions rendered as a dropdown** (Gender, Veteran Status)
    didn't find a decline option on this platform, unlike the identical
    question shape already proven working elsewhere - root cause not yet
    diagnosed, since it needs the real harvested option list from a live
    page, which requires a human to get past the verification screen
    first.
  - A "Work and Education History" question presented as a two-column
    repeating timeline (Work / Education entered in parallel) is a UI
    pattern not seen anywhere else in this project and hasn't been
    analyzed yet.
- **A click that toggles a control must be verified, not assumed.** The
  same false-positive class as the file-upload and text-fill checks:
  `checkField()` used to return success whenever its click resolved
  without throwing, and was measured returning `true` while the checkbox
  stayed unchecked. Every strategy is now judged by re-reading `.checked`.
  Strategy *order* matters too, and for a non-obvious reason: clicking a
  control's associated label is unsafe when that label contains
  hyperlinks. A real consent label ("I acknowledge the Privacy Policy
  and, as applicable, California Notice" - both links) swallowed the click
  and opened a full-screen policy modal, which then covered the form's
  Next button and stalled the whole run with no visible error. The
  targeted click on the input itself now runs first; the label click runs
  last and is skipped entirely when the label contains a link.
- **A persistent browser profile keeps verification from repeating.** A
  throwaway browser context each run means every employer sees a brand-new
  anonymous browser, so an emailed verification has to be redone every
  time. `--profile <dir>` (default `./.browser-profile`, gitignored) keeps
  cookies and local storage between runs so a verification you complete
  once is remembered. This is an ordinary browser profile on your own
  machine, not a way around the check - the first verification is still
  done by hand. `--no-profile true` restores the old behaviour.
- Cover letter upload is not generated/attached.
- Resume parsing supports `.docx` and `.txt` only (no `.pdf` yet).
- Field discovery relies on labels being programmatically associated with
  their inputs (`aria-labelledby`, `aria-label`, `<label for>`, wrapping
  `<label>`, or placeholder text). Fields with none of these are always
  left blank rather than guessed at - on more complex forms this can leave
  a couple dozen fields unlabeled and skipped. Confirmed live on a
  Rippling-hosted test form: three fields (salary requirements,
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
