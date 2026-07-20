# Seekr Auto-Apply POC — Build Summary

## What this is, in plain English

This is a small command-line tool that proves out Seekr's core idea: **give it
a company's job listings page and your resume, and it will find the single
best-matching open role and fill out that job's application form for you.**
It stops right before hitting "Submit" so a human always makes the final
call.

Think of it as a very literal-minded assistant: it reads the job board like
a person would, reads your resume, decides which job you're the best fit
for, and then types your information into the application. It fills in what
it's confident about, using your resume plus a few optional personal-context
files you control; it makes a few narrow, clearly-scoped judgment calls on
your behalf (declining to disclose your race, auto-agreeing to standard
recruitment-data consent); and for everything else it either gives its best
answer and flags it for your review, or leaves it blank rather than guess
recklessly. It never clicks the final submit button itself.

It runs from a terminal command right now, not a polished app — that's
intentional for this stage. The goal was to prove the mechanics work
end-to-end before investing in a UI.

## The end-to-end flow

1. You give it a career page URL, a resume file, and a `criteria.json`
   profile describing the kind of role you want (target titles, years of
   experience, salary floor, employment type, acceptable locations, minimum
   match score).
2. It opens the career page in a real (invisible, "headless" by default)
   browser and reads every job posting listed there.
3. It throws out anything whose title doesn't match your keywords, and
   anything whose description asks for more years of experience, less
   salary, the wrong employment type, or a location you didn't accept.
4. For what's left, it asks Claude to actually read your resume against
   each job description and score the fit, the same way a recruiter would
   skim both and judge. If the best score doesn't clear your minimum bar,
   it stops here and tells you so, rather than filling out a weak match.
5. If the resume file is a `.docx` built with the bracket+italic
   convention, it generates a tailored copy of it for this specific job —
   rewriting the marked sections, verifying the result renders to the same
   page count as the original, and saving it under a
   `[First]_[Last]_Resume_[Company]_[Role].docx` name — before the form
   ever opens.
6. It opens the best-scoring job's application page and fills in what it
   can respond to confidently — see "How the application gets filled"
   below for exactly what that covers and what it deliberately leaves for
   you. The tailored resume from step 5 (or the original file, if step 5
   didn't apply) gets uploaded for the resume field.
7. It saves a screenshot of the filled-out form and **stops.** Nothing gets
   submitted automatically. In `--headed` mode, the actual browser window
   stays open too, so you can review and submit by hand.

## How each piece actually works (technical detail)

All code lives in [mvp/src](src). It's a small Node.js/TypeScript project —
no framework, no database, no UI yet. Six modules, each doing one job,
strung together by a CLI script.

### 1. Reading the resume — [`src/resume.ts`](src/resume.ts)

`loadResume(filePath)` opens a `.docx` file (via the `mammoth` library,
which strips Word formatting down to plain text) or a `.txt` file, then
uses a few regular expressions to pull out an email address, a phone
number, and a name (assumed to be the first line of the resume) alongside
the full text. Everything downstream — matching and form-filling — works
off of this one `Resume` object.

### 2. Your personal context — [`src/context.ts`](src/context.ts)

`loadPersonalContext(mvpDir)` reads three **optional, gitignored** files
you can drop into `mvp/` — they never leave your machine and are never
committed:

- **`user_profile.txt`** — plain `Key: Value` lines (`Address`, `City`,
  `County`, `State`, `Zip`, `Country`, `Phone Country Code`, `Phone
  Number`), parsed into a structured `UserProfile` object.
- **`qa_context.txt`** — free text, your own canned answers to common
  screening questions (why you're leaving your role, salary expectations,
  relocation, availability). Passed to Claude verbatim as grounding.
- **`work_auth_context.txt`** — free text, your citizenship/sponsorship
  status. Same treatment.

Missing files degrade gracefully to empty values rather than failing the
run — none of the three are required.

### 3. Reading the job board — [`src/scrape.ts`](src/scrape.ts)

`listJobs(page, careerUrl)` drives a real browser (via Playwright) to the
career page, waits for the page to finish loading its JavaScript (most
modern job boards, including Greenhouse's, render their listings client-side
rather than in the raw HTML — a plain HTTP fetch would see almost nothing),
and then reads out every job title, link, and location.

It has three modes:
- A **Greenhouse-specific fast path** that reads the exact HTML structure
  Greenhouse boards use, so it comes back clean (e.g. it strips off the
  "New" badge Greenhouse glues onto the end of fresh postings' titles).
- A **Lever-specific fast path**, same idea, for `jobs.lever.co/*` boards.
- A **generic fallback** for any other site: it grabs every link on the
  page and keeps ones whose URL looks like a job posting and whose link
  text looks like a plausible job title. This path is still untested
  against a real non-Greenhouse, non-Lever site.

`getJobDescription(page, jobUrl)` does the same kind of browser visit for
one specific job posting and returns its full text, used later for both
filtering and matching.

### 4. Deciding which job is the best fit — two stages, cheap-then-smart

**Stage A — free, instant filtering: [`src/filter.ts`](src/filter.ts)**
- `filterByTitle(jobs, criteria)` keeps only postings whose title contains
  one of your keywords.
- `filterByLocation(jobs, criteria)` drops postings clearly tied to a
  specific non-accepted place (e.g. "Nashville, Tennessee"), while leaving
  generic/ambiguous labels ("United States") alone rather than guessing.
- `passesHardRequirements(descriptionText, criteria)` scans a job's full
  description text for years-of-experience phrasing, a listed salary below
  your floor, and contract/temp language with no stated conversion path.
  All regex-based, not AI — free and instant, so no API call is wasted on
  jobs that were never going to work.

**Stage B — AI ranking: [`src/match.ts`](src/match.ts)**
Only the postings that survive Stage A get sent to Claude. `rankJobs(...)`
sends your full resume plus every surviving job description in a single
request, and asks Claude (via a structured "tool call" so the response
comes back as clean, parseable data) to score each one 0–100 with a short
reason. The highest score wins — and in `src/index.ts`, if that score is
below your configured `minMatchScore`, the run stops there instead of
filling out a posting Claude itself flagged as a weak fit.

### 5. Filling out the application — [`src/apply.ts`](src/apply.ts)

This is the most involved piece, because real application forms are messy.
It's grown a lot through live testing against seven different companies'
forms — most of what follows exists because a specific real form broke an
earlier, simpler version.

**Opening the form.** `openApplicationForm(page, jobUrl)` navigates to the
job, clicks "Apply" if needed, then polls every frame on the page (not
just the main one) until a plausible number of form fields exist —
necessary because some companies embed the real application as a
cross-origin iframe on their own branded domain (Samsara does this: the
actual Greenhouse form loads inside an iframe pointing at
`job-boards.greenhouse.io/embed/job_app`). `findFormContext(page)` then
figures out whether the real form lives in the main page or one of its
frames, by counting fields in each and picking whichever has the most.
Every downstream function operates on that resolved `Page | Frame`.

**Discovering fields.** `discoverFields(ctx)` reads every input, dropdown,
and text box and figures out, for each one: its human-readable label
(checking `aria-label`, an associated `<label>`, a wrapping `<label>`, then
placeholder text, in that order); whether it's *required* (the real
`required`/`aria-required` attribute first, falling back to a visible
asterisk in the label only when that's absent); whether it's a *combobox*
(a custom-built dropdown widget like React-Select, detected via
`role="combobox"` or similar ARIA attributes — these need fundamentally
different handling than a plain HTML `<select>`, see below); and whether
it's *multi-select* (a native `<select multiple>` — combobox multi-select
can only be detected once the widget is opened, so that happens later).

**The combobox problem, and how it's solved.** Typing a value into a
combobox with `.fill()` looks like it works — no error is thrown — but the
value gets silently discarded the moment the widget re-renders, because
the visible `<input>` is just a search box, not where the real selection is
stored. The only reliable way to answer one is to actually open it and
click a real rendered option. Two more subtleties came from live testing:
- **Scoping.** A naive `[role="option"]` query grabs every currently
  open option on the *entire page*, not just the field being answered.
  Samsara's page keeps a ~250-item phone/country-code picker's listbox
  mounted in the DOM at all times, and an unscoped query mixed all 250 of
  those into every other dropdown's results — burying the 4-6 real
  options for something like "highest level of education" so badly that
  matching failed outright. `getListboxOptions()` fixes this by reading
  which listbox the combobox actually controls (via `aria-controls`,
  which react-select-style widgets set once opened) and scoping the query
  to just that container. It also uses a quoted attribute selector
  (`[id="..."]`) rather than the `#id` shorthand, because some real-world
  field ids contain literal `[]` characters (a multi-select naming
  convention) that break `#id`-style CSS selector syntax outright.
- **Guessing blind.** Before a fix, Claude had to guess a plausible-sounding
  answer for combobox fields without ever seeing the real options, which
  produced fabricated values like "1-2 years" against real buckets of
  "0-1 years"/"2-3 years"/"+4 years" — no amount of fuzzy string matching
  can rescue a value that doesn't correspond to anything real.
  `harvestComboboxOptions()` now opens the field once, just to read its
  real options (without selecting anything), before Claude ever sees the
  field — so it's choosing from an exact, real list, the same way it
  already does for a native `<select>`.

`selectComboboxOption(ctx, selector, candidates)` opens a combobox and
clicks whichever rendered option matches one of the given candidates,
checking both string-containment directions (Claude's guess is often a
fuller phrasing of a terser real option, e.g. "Bachelor's Degree" vs. the
real "Bachelor's"). If nothing matches on the immediately-visible
options (a static picklist), it retries by typing each candidate in turn,
for search-driven autocompletes (e.g. a city lookup) that only populate
once something is typed.

`selectMultipleComboboxOptions(ctx, selector, values)` is the equivalent
for multi-select widgets: it clicks a match for *every* value given, in
sequence, without closing the dropdown between clicks — multi-select
widgets stay open across selections instead of closing after the first
pick like a single-select does.

**Deciding what to do with each field**, in order:
1. **Resume file upload** — matched by "resume"/"cv" appearing in the
   field's id, name, or label (not hardcoded to one ATS's convention),
   excluding anything that also says "cover" so a cover-letter slot isn't
   grabbed instead. Verified after upload two ways: first that the
   browser actually registered a file (`input.files.length > 0`), then
   — since some widgets remove the file input from the DOM the instant a
   file is accepted, replacing it with a "file selected" UI — the
   *element disappearing* right after a successful upload call is treated
   as a positive signal, not a failure; only a still-present input
   reporting zero files counts as a real failure.
2. **Standard recruitment-data consent** — a checkbox or dropdown whose
   text is a narrow "consent to processing my data to consider my
   application" (detected via `isStandardRecruitmentConsent()`, which
   also explicitly excludes anything mentioning marketing, third-party
   sharing, or indefinite/unrelated retention) gets auto-agreed. Anything
   broader is left alone. This also covers bare GDPR-style labels with no
   "consent"/"acknowledge" wording at all — a real OneTrust field labeled
   exactly `"Data Protection Notice *"` was initially left for manual
   review because the label alone didn't literally say "consent" or
   "process my data," even though live inspection showed it renders with
   exactly one real option, `Acknowledge/Confirm` — mechanically identical
   to the case already trusted for Samsara's `"Processing of Personal
   Data*"` field, just EU-style phrasing. `isStandardRecruitmentConsent()`
   now short-circuits to true for bare `"Data Protection Notice/Policy"`,
   `"Privacy Notice/Policy"`, and `"GDPR Notice"` labels the same way it
   already did for `"Privacy Notice Acknowledgement"`, still gated by the
   same broader-scope exclusion that runs first (so `"Data Protection and
   Marketing Notice"` is still correctly left alone). One subtlety worth
   noting: the regex has to tolerate a trailing `" *"` on the label, since
   required-field labels carry that character (see the asterisk fallback
   in `discoverFields()`) — an end-anchored regex that only allowed
   trailing whitespace missed the real field entirely on the first attempt
   at this fix.
3. **Everything else checkbox/radio-shaped** — always left for you.
   Reliably identifying which specific *radio* in a group corresponds to
   "decline to answer" (as opposed to its sibling options) isn't built
   yet, so EEOC questions rendered as radio groups (rather than a
   dropdown) still fall into this bucket.
4. **Voluntary EEOC/demographic fields** (gender, race, veteran/disability
   status) — always get an active "decline to answer" style selection
   when the form offers one (native select or combobox), matched via a
   regex covering the several real-world phrasings these take ("decline",
   "prefer not", "I don't wish to answer", "I don't want to answer" — the
   OFCCP-standard veteran and disability forms use different verbs for
   the same intent). Never guessed at beyond that, never left at a blank
   default if a decline option exists, never written to any file.
5. **Fixed, deterministic answers** for a few specific question types,
   routed through `answerDirectly()` rather than an LLM call so there's no
   risk of a fabricated answer: "AI policy for interviewers" → "No"; "how
   did you hear about **this opportunity/role**" → "LinkedIn"; the more
   generic "how did you hear about **us/the company**" → "online
   research"/"careers page". Both `HOW_HEARD_RE` regexes match "did you
   hear/find/learn" *and* "have you heard/found/learned" phrasing — an
   earlier version only covered "did you," and a real Samsara field
   ("Where **have** you learned about Samsara? Select all that apply.")
   used the latter, so it silently missed this deterministic path
   entirely and fell through to Claude instead. That was the actual root
   cause behind that field intermittently coming back unanswered in live
   runs — not generic LLM non-determinism, though see point 8 below for
   the further fallback that also now covers cases like it.
6. **No discoverable label at all** — left alone. Can't safely answer
   something with zero information about what's being asked.
7. **Known identity and contact fields** (first/last name, email, phone,
   LinkedIn, address, city, state, zip, country, phone country code) —
   filled directly from the resume or `user_profile.txt`, no AI call
   needed. City fields get extra care: a bare city name is often
   ambiguous (there are multiple US cities named Decatur, Springfield,
   etc.), so when both city and state are known, the search tries
   `"City, State"` first and only falls back to the bare name if that
   doesn't match — a bare-name match that happened to land on the wrong
   state was a real, confirmed bug in early testing.
8. **Everything remaining** — custom written questions, salary,
   relocation, work authorization/sponsorship, education, years of
   experience with a specific tool, etc. — goes to Claude in a single
   batched request (`answerWithClaude()`), grounded in your resume, the
   job description, and all three personal-context files. Guidance baked
   into the prompt: salary questions are answered differently depending
   on whether they're a yes/no "do you accept the listed range" (confident
   "Yes" whenever a range is stated) or an open-ended "what's your desired
   salary" (uses `qa_context.txt`'s tiered logic, marked low-confidence
   since it's an estimate); "why are you interested in this company"
   style questions get a specific, non-generic answer grounded in the
   actual job description and resume, not a template. Fields marked
   `[REQUIRED]` in the prompt are instructed to never come back empty —
   Claude must give a real best-effort answer, flagging it
   **low-confidence** when it had to extrapolate. Multi-select fields are
   marked `[MULTI-SELECT]` and answered via a separate `values` array in
   the tool schema instead of the single `value` field everything else
   uses.

**The required-field retry.** The "never come back empty" instruction is a
prompt, not an enforced constraint — Claude doesn't always comply. After
the first batched answer call, any `[REQUIRED]` field that still came back
empty gets one more, firmer-worded request containing just those fields.
When any of those fields are `[MULTI-SELECT]`, the retry's wording gets
more specific still: it calls out that the `values` array itself (not
`value`) is what came back empty, that it must contain at least one entry,
and that picking just the single most defensible option beats leaving it
blank. If a field is *still* empty after that, it's reported with a
distinctly different message ("could not produce an answer even after a
retry") so it doesn't read like an ordinary skip.

**The multi-select fallback.** Even with the above, the array-shaped
`values` answer stayed the one field type that occasionally came back
empty twice in a row in live testing (one real instance of this had an
actual root-cause fix — see point 5 above — but not every possible
multi-select field is a "how did you hear" question). Rather than accept
that as an irreducible gap, `answerMultiSelectFallback()` gives a required
multi-select field still empty after the retry one further attempt
through a deliberately simpler schema: instead of asking for a `values`
array, it asks for a single `value` string — the same shape every other
field on the form already answers reliably — and wraps whatever comes
back into a one-item `values` array. This tests directly on the shape
itself: if Claude reliably answers single-value schemas but not array
ones, a single-value fallback should succeed where two array-shaped
attempts didn't. Answers from this fallback are always forced
low-confidence when merged in, since by construction they're a narrowed
"pick one" answer to what was really a "select all that apply" question —
worth a second look even when it does come back non-empty. If a field is
*still* empty after this third attempt, the skip reason changes once
more, to make clear it went through every available layer: "could not
produce an answer even after a retry and a simplified single-value
fallback." This meaningfully reduces the odds of a multi-select field
needing manual completion, but — being LLM output wrapped in fallbacks,
not a hard guarantee — doesn't provably eliminate it.

Every text field that gets filled goes through `fillTextVerified(...)`,
which re-reads the field from the page a moment after filling it to
confirm the value actually stuck, since React-Select-style comboboxes
would otherwise silently discard a typed value while reporting success.

**That confirmation only proves the value stuck at that instant, though —
not that it survives the rest of the run.** A real live run surfaced a
case of exactly that: Samsara's `"First Name"` field was correctly filled
and verified early on, but by the time the run finished, it appeared
empty — most likely because Samsara's heavy iframe-embedded React form
re-rendered at some point during the many later combobox interactions
elsewhere on the page, silently resetting an already-filled plain text
input in a way the original per-field check couldn't catch (it only ever
looked once, right after filling). `fillTextVerified()` now takes an
optional `filledSelectors` array and records every successful text fill
into it; `reverifyFilledTextFields()` walks that whole list one more time
right before the screenshot, tries one repair fill on anything that no
longer matches, and — if the repair doesn't stick either — downgrades the
field from `filled` to `skipped` with an honest reason (`"was filled
successfully earlier in the run but got reset before the screenshot"`)
rather than letting the report silently overclaim. This is the general
form of a pattern worth remembering for this codebase: on a long-running,
heavily-interactive form, verifying a fill *once* only proves it was
correct *then* — anything that mutates the page afterward can invalidate
an earlier, genuinely-correct check, so an end-of-run re-verification
pass is the more trustworthy guarantee, not just a belt-and-suspenders
extra.

Finally, it takes a full-page screenshot and returns a report of exactly
what got filled (tagged `generated`/`lowConfidence` as appropriate) and
what got skipped (tagged `required`), with a reason for every skip.

### 6. Tailoring the resume — [`src/resumeGenerator.ts`](src/resumeGenerator.ts)

Runs after the best-match job is picked and before the application form
opens. Returns `null` (nothing to do) if the resume isn't a `.docx` or has
no detected placeholders, in which case `index.ts` just uploads the
original file - this step never blocks the rest of the run.

**Detection — `detectPlaceholders()`.** A `.docx` is a zip of XML files;
the real content lives in `word/document.xml`. Word fragments text across
many adjacent `<w:r>` runs (revision tracking, spell-check markers) - a
live inspection of the real template confirmed the literal `[` character
routinely lands in its own run, separate from the placeholder text after
it. So detection works at the paragraph level: `parseParagraphs()` and
`parseRuns()` regex-match `<w:p>...</w:p>` and `<w:r>...</w:r>` blocks
directly against the raw XML string (not a full DOM parse-and-reserialize,
which risks reformatting content outside the edited spans), tracking each
run's exact `[xmlStart, xmlEnd)` offset, its `<w:rPr>` block, and its
unescaped text. Paragraph plain text is the concatenation of its runs'
text; a `\[([^\[\]]*)\]` match against that plain text is only accepted as
a real placeholder if *every* run whose text the match overlaps carries
`<w:i/>` (checked via `isItalicRPr()`, which also respects an explicit
`w:val="false"`). Short, all-caps, single-run paragraphs immediately
before a placeholder (`"PROFESSIONAL SUMMARY"`, `"CORE SKILLS"`) are
tracked separately as the running "section header" context, not treated
as placeholders themselves.

**Choosing the right formatting to inherit.** Live inspection surfaced a
real subtlety: in `"Technical Skills: [SQL, Python, ...]"`, the opening
`[` run was **bold *and* italic**, while the actual skills-list content
run right after it was italic-only. Using the `[` run's formatting as the
template for the replacement text would have made the whole output
incorrectly bold. Fixed by picking the run with the *most* bracket-covered
text (`bestOverlap` in the detection loop) as the formatting template, not
just the first one - that's reliably the real content run, not a
punctuation-only run - then stripping its `<w:i/>`/`<w:iCs/>` tags
(`stripItalic()`) to get the "normal" formatting to write the replacement
in.

**Generation — `generateReplacements()`.** One batched Claude tool-use
call covers every detected placeholder in the document. The prompt is
explicit that the bracket's *current* content is real material to
tailor/reorder/re-emphasize, not a blank to invent from scratch, and
carries a **strict no-fabrication rule**: only skills/tools/claims already
present - verbatim or near-verbatim - in the full resume, `qa_context.txt`,
or the section's own current content may appear in the output. This rule
exists because an earlier version of the prompt let Claude "upgrade" the
resume's generic `"CRM Platform Experience"` into the specific
`"Salesforce"` just because the target job description asked for
Salesforce - a real fabrication caught during testing on the actual
Samsara JD, not a hypothetical. The strengthened prompt fixed it on the
very next run (verified by diffing the before/after generated text
against the source resume).

That fix, however, over-corrected: the very next round of QA testing
(across two different real job descriptions) found the Technical Skills
line coming back byte-for-byte identical to the source template both
times, while Core Competencies correctly changed each time. A debug
harness that logged Claude's raw tool-use response directly (not just the
final applied text) confirmed this was *not* an indexing/pass-through
bug - Claude answered that placeholder every time, it just kept choosing
not to change it. Root cause: the strict no-fabrication wording made
"any list of named tools" read as risky enough that the safest move
looked like touching nothing at all, rather than distinguishing
*reordering real items* (always safe, zero fabrication risk) from
*adding new items* (needs grounding). `looksLikeList()` now detects
comma-heavy, non-prose content and attaches an explicit `[LIST: reorder
by relevance...]` note to that placeholder, paired with a prompt-level
rule that byte-for-byte-identical output is only acceptable when the
current order genuinely is already the best fit - not as a default safe
answer. Verified fixed by re-running the same two job descriptions: the
two skills lines now produce genuinely different orderings per job
(confirmed via a full mammoth-text diff of the untouched Professional
Experience/Projects/Education sections showing them still byte-for-byte
identical to the source, and the independent-project sentence preserved
in both runs).

A second, related fix targets the same "leave it alone by default"
failure mode for one specific sentence: the source Professional Summary's
mention of independent/personal project work
(`INDEPENDENT_PROJECT_RE`, a generic pattern - not hardcoded to any one
candidate's exact wording) was preserved in one test run and cut in
another, with no code path making that outcome deterministic either way.
Any placeholder whose original content matches that pattern now gets an
explicit `[MUST PRESERVE: ...]` note, and the page-count retry's overflow
feedback specifically instructs trimming other sections first rather than
cutting that reference as a default response to overflow.

**Splicing — `applyReplacements()`.** Placeholders are processed in
*reverse* document order (sorted by `runXmlStart` descending) so each
splice's offset stays valid for the ones still to come - no full-document
reserialization, no re-parsing after each edit. Each replacement becomes
exactly one new `<w:r>` (the chosen template `rPr` plus the generated,
XML-escaped text); if the bracket's boundary fell mid-run rather than
exactly on a run boundary, the leftover "before"/"after" text on either
side is preserved as its own untouched-formatting run rather than being
dropped.

**Length verification — real rendering, not estimation.** `docxToPdf()`
shells out to [`scripts/docx-to-pdf.ps1`](scripts/docx-to-pdf.ps1), which
drives Microsoft Word via COM automation (`New-Object -ComObject
Word.Application`, `Documents.Open`, `SaveAs2(path, 17)` for PDF) - the
only way to know the *actual* rendered page count, since font metrics,
margins, and line spacing all affect real page breaks in ways no
character or word count can predict. `getPdfPageCount()` then reads the
resulting PDF's page count via `pdf-lib`. The orchestrator computes the
original template's page count once via this same pipeline, then loops
up to `MAX_ATTEMPTS` (4): generate → splice → render → compare. On a
mismatch, the next attempt's prompt gets explicit feedback ("too long,
write noticeably shorter" or "too short, write more detail"), and the
attempt closest to the original page count is kept regardless of whether
any attempt converged exactly - `converged: false` in the result signals
this honestly rather than silently shipping a wrong-length file. Verified
live against real OneTrust and Samsara job descriptions: both converged
on the original 1-page layout on the first attempt.

**Naming.** `extractCompanyAndRole()` makes a small Claude tool-use call
against the job description (scraped titles are often messy - location
text run directly onto the role with no separator, e.g. `"Partner
Operations AnalystRemote - US"`) to get a clean company/role pair, then
`sanitizeFilenamePart()` strips characters illegal in Windows filenames
and turns spaces into underscores. The final name is
`[First]_[Last]_Resume_[Company]_[Role].docx`, with the name segment
pulled from the parsed resume rather than hardcoded, saved into the same
`--out` directory as the screenshot.

### 7. Tying it together — [`src/index.ts`](src/index.ts)

The CLI entrypoint. Parses command-line flags (`--career-url`, `--resume`,
`--criteria`, and per-field overrides for everything `criteria.json`
covers, plus `--out` and `--headed`), loads the resume and personal
context, runs the steps above in order, and prints a readable log:
what it scraped, what it filtered out and why, how it scored each
candidate, and a three-way breakdown of what it filled — ground-truth
(resume/profile), AI-generated (review it), and low-confidence (review it
*especially* carefully) — plus a required-vs-optional breakdown of
everything it left blank. It never calls anything resembling a "submit"
action; there's no code path that could do that even by accident.

## What's actually working (verified with live runs)

Tested end-to-end, more than once each, against real live public job
boards using your actual resume:

| Company | ATS | Notable for |
|---|---|---|
| Attentive | Greenhouse | First working end-to-end run |
| Gusto | Greenhouse | Regression check |
| Checkr | Greenhouse | Regression check |
| Palantir | Lever | Found and fixed a real selector-fragility bug; hit a CAPTCHA (expected, not solved) |
| OneTrust | Greenhouse | Genuinely Atlanta-based match; personal-context fields first proven live |
| Samsara | Greenhouse (iframe-embedded on their own domain) | The hardest form by far — iframe detection, combobox scoping/harvesting, multi-select, and the retry mechanism were all proven or fixed here |
| Iterable | Greenhouse | Regression check; also the source of a real how-did-you-hear regex gap |

Confirmed working across these runs:
- Scraping a real career page and finding every open posting.
- Filtering down to relevant, affordable, correctly-timed, correctly-located
  postings, and correctly excluding ones that don't qualify.
- Claude consistently ranking the most sensible candidate highest, with
  believable reasoning about seniority, domain, and location mismatches —
  and correctly refusing to fill out a posting when nothing clears the
  minimum score.
- Opening the real application form (including through a cross-origin
  iframe) and correctly filling identity, contact, and personal-context
  fields.
- Correctly answering work authorization, sponsorship, relocation, salary
  acceptance, education level, and years-of-experience-with-a-specific-tool
  questions — including ones rendered as custom dropdowns — grounded in
  real, harvested options rather than a blind guess.
- Correctly declining to answer EEOC/demographic questions with an active
  "decline to answer" selection, and correctly auto-agreeing to
  narrow-scope (but not broad-scope) consent.
- Correctly filling a genuine multi-select ("select all that apply") field.
- Producing a screenshot that matches the written report exactly, every
  time this was checked.
- Stopping before submission every time.
- Detecting bracket+italic placeholders in a real `.docx` template,
  tailoring them to a specific live job description with no fabricated
  skills/tools, verifying the result renders to the same page count as the
  original via real Word rendering, and uploading the tailored file in
  place of the static resume - confirmed on both OneTrust and Samsara.

## What's rough or untested

- **The generic fallback scraper (non-Greenhouse, non-Lever) is still
  untested against a real site.**
- **Multi-select fields were the least reliable field type** — confirmed
  happening intermittently across repeated live runs against the exact
  same field on the exact same form (two consecutive Samsara runs,
  identical resume/JD/criteria, one succeeded and one didn't). One real
  instance of this traced back to an actual root cause rather than pure
  non-determinism (the how-heard regex gap described above) and is now
  fixed outright. The residual risk for genuinely novel multi-select
  fields — not "how did you hear," just some other select-all-that-apply
  question — now has a further single-value-schema fallback layered onto
  the existing retry (see "The multi-select fallback" above), which
  should meaningfully reduce, though not provably eliminate, how often
  this class of field still needs manual completion.
- **Bot detection can be a hard blocker.** Palantir's Lever-hosted form
  presented a CAPTCHA challenge partway through the run. The tool can't
  and won't attempt to solve it.
- **Cover letters aren't handled at all** — no generation, no upload.
- **No automated test suite.** Verification so far has been live manual
  runs and reading the screenshot/console output, not unit/integration
  tests.
- **Resume parsing only handles `.docx` and `.txt`** — no `.pdf` support.
- **The years-of-experience, salary, and employment-type filters are all
  regex-based**, not full natural-language understanding. They'll miss
  requirements phrased unusually.
- **EEOC questions rendered as a radio group** (rather than a dropdown)
  aren't answered — same safe default of leaving them for manual review,
  just via a different, not-yet-built code path.
- **Headed (visible-browser) mode can't be run or tested by the coding
  agent** — the sandboxed shell it runs commands in has no attached
  desktop, so it's structurally unable to open a GUI window. Works fine
  run directly by a person in their own terminal.
- **Resume tailoring requires Microsoft Word on Windows** (COM automation
  for the page-count check) — no LibreOffice or cross-platform fallback
  exists yet. Degrades gracefully (warning + falls back to the static
  file) rather than crashing the run, but it is a real external
  dependency, same category as needing Playwright's browser binaries.
  Only tested against a template with exactly the documented bracket+italic
  convention - a differently-marked template (bold instead of italic,
  `{{}}` instead of `[]`) won't be detected at all.
- **The page-count convergence retry caps at 4 attempts** and isn't
  guaranteed to succeed - both live test runs converged on attempt 1, so
  the non-convergent path (closest-attempt-kept, clearly flagged) hasn't
  actually been exercised live yet, only reasoned through and left as an
  honest fallback.

## Known limitations (by design, not oversights)

- **Never fills broad-scope consent, voluntary demographic questions, or
  anything it can't find a real matching option for.** These are always
  left for a human, even where it could technically produce a guess.
- **Never clicks submit.** Not a setting — there's no code path that
  could do it even by accident.
- **Never attempts to solve or bypass CAPTCHAs/bot-detection.** A hard
  stop requiring a human, by design.
- **No live web search.** Salary-range research and company-specific
  answers rely on Claude's own trained knowledge plus whatever the job
  description itself says, not a real-time search. A deliberate scope
  call for the POC; wiring up Anthropic's hosted web-search tool would be
  the natural next step if this needs to be more current/accurate.
- **Runs headless by default**, specifically so it's runnable from
  anywhere including this coding session — `--headed` is there for when a
  human wants to watch and submit live from their own terminal.
- **Resume tailoring only ever rewrites, reorders, or re-emphasizes real
  resume content - it never introduces a skill, tool, or claim that isn't
  already grounded there**, even when the job description explicitly asks
  for something more specific than what the resume actually supports (a
  generic "CRM Platform Experience" stays generic rather than becoming
  "Salesforce" just because the job wants Salesforce). A deliberate
  guardrail, not a gap - the alternative is a resume that oversells the
  candidate.

## Quick file map

| File | Responsibility |
|---|---|
| [`src/resume.ts`](src/resume.ts) | Parse resume file → text + contact fields |
| [`src/context.ts`](src/context.ts) | Load optional personal-context files (profile, Q&A, work auth) |
| [`src/scrape.ts`](src/scrape.ts) | Read a career page → list of job postings |
| [`src/filter.ts`](src/filter.ts) | Cheap keyword/salary/location/experience/employment-type filtering |
| [`src/match.ts`](src/match.ts) | Claude-based ranking of resume vs. job postings |
| [`src/apply.ts`](src/apply.ts) | Discover and fill application form fields (by far the largest module) |
| [`src/resumeGenerator.ts`](src/resumeGenerator.ts) | Detect + tailor bracket+italic `.docx` placeholders, verify page count via Word, save the tailored file |
| [`scripts/docx-to-pdf.ps1`](scripts/docx-to-pdf.ps1) | PowerShell/Word-COM helper: renders a `.docx` to PDF for the page-count check |
| [`src/index.ts`](src/index.ts) | CLI entrypoint, wires everything together |
| [`criteria.json`](criteria.json) | Reusable screening-rules profile (titles, salary floor, locations, etc.) |
| [`user_profile.txt` / `qa_context.txt` / `work_auth_context.txt`](.) | Gitignored personal context (not committed - create your own) |
| [`README.md`](README.md) | Setup and run instructions |
