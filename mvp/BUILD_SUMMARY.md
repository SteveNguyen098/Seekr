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
- `detectLocationPreference(descriptionText)` is a *soft* signal,
  deliberately separate from `passesHardRequirements` and never called
  from inside it: a job description stating a regional/timezone
  preference ("prioritizing candidates in the Central Standard time
  zone") that doesn't match the candidate's own location shouldn't
  silently skip the posting the way a real hard requirement does - the
  candidate's own instruction was to see the flag and decide for
  themselves, not have the tool decide for them. Matches non-Eastern US
  timezone names/abbreviations and "West Coast" (`NON_EASTERN_TZ_RE`) -
  Eastern/ET/East Coast are deliberately excluded from the pattern since
  that's the candidate's own zone and should never trigger it. Returns
  the matched phrase(s) plus a ~180-character context window around the
  first hit (not just the bare keyword) so the actual wording - including
  any "...or Eastern" escape hatch that would make it a non-issue - is
  visible before a decision gets made. `src/index.ts` calls this once
  the best-match job is picked and prints it as a clearly-marked `!
  LOCATION/TIMEZONE SOFT-FLAG` line immediately before "Tailoring resume
  to this role..." - after ranking (so it's evaluating the one job that's
  actually about to get a resume generated for it, not every candidate),
  but strictly before any resume generation happens, and the run
  continues regardless of the flag.

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
It's grown a lot through live testing against many different companies'
forms — most of what follows exists because a specific real form broke an
earlier, simpler version.

**Opening the form.** `openApplicationForm(page, jobUrl)` navigates to the
job, clicks "Apply" if needed, then polls every frame on the page (not
just the main one) until a plausible number of form fields exist —
necessary because some companies embed the real application as a
cross-origin iframe on their own branded domain (one live test site does
this: the actual Greenhouse form loads inside an iframe pointing at
`job-boards.greenhouse.io/embed/job_app`). `findFormContext(page)` then
figures out whether the real form lives in the main page or one of its
frames, by counting fields in each and picking whichever has the most.
Every downstream function operates on that resolved `Page | Frame`.

**Discovering fields.** `discoverFields(ctx)` queries `input, textarea,
select, [role="combobox"]` — not just the three form-control tags, because
a combobox's clickable trigger isn't always a real `<input>`. Confirmed
live on a Rippling-hosted test site: gender, Hispanic/Latino,
veteran status, and disability status all render as a bare `<div
role="combobox">` with no underlying `<input>` anywhere in their markup,
completely invisible to a query that only looked for form-control tags —
not mislabeled, not skipped with a reason, just absent from the field list
entirely.

For each matched element it figures out: its human-readable label
(`aria-labelledby` resolved to the referenced element's own text first,
then `aria-label`, then an associated `<label>`, then a wrapping `<label>`,
then placeholder text last — this precedence follows real ARIA semantics,
and getting it right mattered: two more fields on that same Rippling form
*were* being discovered — their trigger was a real `<input>` — but exposed
only a generic "Search"/"Select..." placeholder directly on the control,
with the actual question text ("Please identify your race", "Pronouns")
only reachable by resolving `aria-labelledby`. Skipping that resolution
meant the sensitive-field safety net, which matches against the discovered
label text, never saw the word "race" at all — the field looked like an
ordinary open question, so Claude answered it with a specific, invented
race rather than declining. That's a materially worse failure than a
missed field: a fabricated demographic answer, not just an empty one.
Confirmed fixed — the same live form now correctly declines all five
demographic questions); whether it's *required* (the real
`required`/`aria-required` attribute first, falling back to a visible
asterisk in the label's own text, and finally to a CSS-only asterisk that
isn't in the text at all — see the Ashby-specific bug below for why that
third signal exists); whether it's a *combobox*
(detected via `role="combobox"` or similar ARIA attributes — these need
fundamentally different handling than a plain HTML `<select>`, see below);
and whether it's *multi-select* (a native `<select multiple>` — combobox
multi-select can only be detected once the widget is opened, so that
happens later).

**Discovery isn't the same as dispatch — a bug in the fix for the bug
above.** Broadening `discoverFields()`'s query to catch `[role="combobox"]`
regardless of tag (above) wasn't enough on its own: the code in
`fillApplication()` that decides which discovered fields actually get sent
to Claude checked `field.tag === "SELECT" || field.tag === "INPUT" ||
field.tag === "TEXTAREA"` — a `DIV`-tagged combobox matches none of those,
so two more fields (state-residency, sponsorship) were being discovered
correctly and then silently dropped one step later, present in neither the
filled nor skipped report. Fixed by also checking `field.isCombobox` in
that condition, independent of tag.

**A generic instruction word is a false "found a label" signal — worse
than an honest empty one.** A `DOM`-proximity fallback was added to
`discoverFields()`'s label cascade as the very last resort (below
placeholder), for fields with genuinely zero programmatic label of any
kind — confirmed live on Rippling's per-job "custom questions" (salary
requirements, start date, referral source), which sit in a plain sibling
`<p>` with no `aria-labelledby`/`aria-label`/`label[for]`/wrapping
`<label>`/placeholder at all. It walks up from the control checking
`previousElementSibling` text at each level; confirmed live that this
needs to go up to 8 levels for some fields (the state-residency question's
wrapper nests 6 levels deep before a sibling with real text appears) — a
depth that would look excessive without that evidence.

That fallback only fires when `label` is still empty, which surfaced a
second, more serious bug: two fields (state-residency, sponsorship) both
had `aria-label="Select"` set *directly* on the control, no
`aria-labelledby` at all. That's a non-empty string, so the cascade
stopped there, confident it had found a real label — Claude then saw two
*identical*, contentless "Select" fields with no way to tell them apart,
and answered one of them wrong: "Yes" to needing visa sponsorship, the
opposite of correct. This was caught by checking the actual screenshot
rather than trusting "the field got an answer" as proof the answer was
right — a live reminder that "non-empty" and "correct" aren't the same
thing to verify. Fixed by treating `"Select"`/`"Search"`/`"Choose"`
(optionally with trailing dots) as equivalent to an empty label, so the
DOM-proximity fallback gets a chance to find the real question text
instead of a generic placeholder word. Confirmed fixed: both fields now
resolve their real question and answer correctly.

**The same false-signal problem, found again on a fourth platform (Ashby)
via a different generic word.** A field labeled "Current Location" on
a live Ashby-hosted test site's application form was reported in the fill
summary as literally "Start typing..." instead of its real question - the tell that
gave this one away, rather than a wrong-but-plausible answer like the
"Select" case above. Root cause: Ashby's `<label for="X">Current
Location</label>` points at an `X` the real `<input>` doesn't actually
have as its `id` at all (`el.id` is empty; label and input are just
siblings in the same wrapper div, never genuinely connected via
`for`/`id` - the same broken native-association pattern also seen on the
work-authorization/sponsorship fields). Every signal ahead of placeholder
in the cascade came up empty, so it settled for the input's own
`placeholder="Start typing..."` - non-empty, so the DOM-proximity
fallback never got a chance to run and find "Current Location" sitting
one level up as the input-container's previous sibling. Fixed by
extending the same generic-instruction-word check to also cover "Start
typing"/"Type here", not just "Select"/"Search"/"Choose". Downstream,
this also meant the field never reached the profile-driven city/state
disambiguation logic in bucket 9 below at all (its label match only
looked for "city") - it fell through to Claude's general answering
instead, which picked a plausible-sounding but wrong city ("Atlanta")
with no real disambiguation signal to ground it in the candidate's actual
location ("Decatur"). Both the label-masking bug and the missing "current
location" alias needed fixing together; confirmed live the field now
correctly resolves and fills "Decatur, Georgia, United States".

**A required asterisk that's painted entirely by CSS is invisible to
both required-detection signals above it.** Also confirmed on that same
"Current Location*" field: even after the label-masking fix, `required`
was still coming back `false` despite a clearly visible red asterisk in
the live screenshot. Its `<label>` element has an empty `textContent` -
no literal `*` character anywhere in it - because the asterisk is
rendered purely via `label::after { content: "*" }` in Ashby's CSS, a
common styling pattern that's completely invisible to both the native
`required`/`aria-required` attribute check and the textContent-based
`/\*/`-in-the-label fallback (confirmed by comparing `getComputedStyle`
output between this field and an optional one: `"*"` vs. `"none"` for the
`::after` pseudo-element's `content` property). Fixed by adding
`getComputedStyle(labelEl, "::before"/"::after").content` as a third
required-detection signal, checked against both places a real associated
`<label>` element is ever found (`label[for]`, or a wrapping `<label>`) -
a standards-based, portable check rather than anything tied to Ashby's
own (hashed, unstable-across-builds) class names.

**Live salary research.** A candidate's own instruction: open-ended
"what are your salary requirements?" questions should use real current
market data, not just Claude's trained knowledge (which can be stale).
`researchSalaryRange()` is a small, separate call using the Anthropic
SDK's hosted `web_search_20260318` tool (confirmed available in
`@anthropic-ai/sdk` 0.110.0), triggered only when `toAnswer` actually
contains a field matching `SALARY_OPEN_ENDED_RE` — the separate yes/no
"do you accept the listed range" shape already has a confident answer
without needing research, so no call is wasted when it isn't useful. This
runs as its own call rather than folding `web_search` into the main
batched `answerWithClaude()` call, because that call forces a specific
tool choice (`answer_fields`) for clean single-turn structured output,
which doesn't compose with the back-and-forth a search-enabled call
needs (Claude would need to call `web_search`, see results, *then* call
`answer_fields` — a different shape of interaction than a single forced
tool call supports). The research findings get folded into the main
prompt as an extra grounding block instead, with guidance to prefer them
over Claude's own trained-knowledge estimate whenever present. Verified
live: a real search returned `$58,000-$85,000` for the tested role,
visibly different from the job posting's own stated `$60,000-$72,000` —
confirming genuine research happened rather than the call just echoing
back the JD's own number.

**Interacting with a visually-hidden native input.** A common accessible
component pattern — confirmed live, again on the Rippling form, for every
radio and checkbox on the page — hides the real `<input>` (zero size or
opacity) behind a custom-styled sibling that's the actual visible,
clickable surface, with `aria-labelledby` pointing at the text a user would
actually click. Playwright's `.check()`/`.click()` correctly refuse to act
on an element that isn't visible, which is exactly right for a genuinely
inert element but wrong here — the input is real and functional, just
invisibly positioned by design. `checkField(ctx, selector)` tries a normal
`.check()` first, and if that fails, clicks whatever the input's
`aria-labelledby` resolves to instead — the same target a real user's
click would land on.

**The combobox problem, and how it's solved.** Typing a value into a
combobox with `.fill()` looks like it works — no error is thrown — but the
value gets silently discarded the moment the widget re-renders, because
the visible `<input>` is just a search box, not where the real selection is
stored. The only reliable way to answer one is to actually open it and
click a real rendered option. Two more subtleties came from live testing:
- **Scoping.** A naive `[role="option"]` query grabs every currently
  open option on the *entire page*, not just the field being answered.
  One live test site's page keeps a ~250-item phone/country-code picker's
  listbox mounted in the DOM at all times, and an unscoped query mixed all 250 of
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

**The invisible-field guard, and why every obvious approach failed.** An
Oracle HCM Cloud application carries a genuine anti-bot honeypot. It was
worth measuring rather than reasoning about, because it defeats every
standard check: Playwright's `isVisible()` → true, the DOM's
`checkVisibility()` → true, computed `display`/`visibility`/`opacity` →
`inline-block`/`visible`/`1`, size → a normal `199x38`, position →
on-screen. It hides via a `height:0; overflow:hidden` **ancestor**, leaving
its own box entirely ordinary. The measured truth table that drove the
design:

| field | `aria-hidden` | `aria-labelledby`→visible | rect | correct action |
|---|---|---|---|---|
| honeypot | **true** | — | 199x38 | **skip** |
| required consent checkbox | — | **yes** | 0x0 | **tick** |
| another platform's SMS radios | — | **yes** | 0x0 | **click** |
| ordinary email input | — | — | 620x38 | **fill** |

`aria-hidden` is the only signal separating row 1 from rows 2–3, so it's
the backbone; a hit-test via `elementFromPoint` is a backstop, and the
`aria-labelledby`→visible exemption must run **before** it or rows 2–3 get
skipped — which would dead-end the form, since that consent checkbox gates
page 1. Two details are load-bearing and each broke a first attempt:
the hit-test must accept only **self-or-descendant** (the honeypot's
topmost element at its own centre is its *ancestor*, so allowing an
ancestor match reports the trap as reachable), and reachability is
evaluated at **fill time**, not discovery time, since it's the only
position-dependent signal and a re-render or page transition invalidates a
stale verdict. Inconclusive verdicts never skip: a real field silently
vanishing from a fill is invisible in a report, whereas a novel trap
slipping past is still caught by the static rules. A `0x0` field with no
visible label partner is filled but surfaced as a flow note (file inputs
exempted — that shape is universal for dropzones and would be pure noise).

**Verifying a toggle, and why click *order* matters.** `checkField()` used
to return true whenever its click resolved without throwing, and was
measured returning `true` while the checkbox stayed unchecked — the same
false-positive class as the file-upload and text-fill checks, and one that
had been quietly affecting every checkbox on every platform. Every strategy
is now judged by re-reading `.checked`. Ordering then turned out to matter
for a non-obvious reason. Clicking a control's associated label is unsafe
when the label contains hyperlinks: a consent label reading "I acknowledge
the Privacy Policy and, as applicable, California Notice" carries both as
`<a>` links, so the click opened a full-screen policy modal, which covered
the form's Next button and stalled the entire run with no error anywhere —
the checkbox *was* ticked, so nothing looked wrong until the per-page
screenshot showed a 17,000px-tall page. The targeted native click on the
input itself now runs first (it cannot hit anything else, and was measured
as the only thing that toggles an Oracle JET checkbox at all — clicking the
covering span or the wrapping label does nothing); the label click runs last
and is skipped entirely when the label contains a link.

**Multi-page flow.** `fillCurrentPage()` handles one step; `fillApplication()`
loops fill → find Next → click → confirm advance → re-discover, capped at 10
pages with a screenshot each. `NEXT_RE` is anchored (an unanchored
`/continue/` would hit Oracle's session-keepalive "Continue Working"), and
submit/abort controls are never clicked. Advance is judged by comparing the
**identity** of the page's form controls, not a text snapshot: a failed Next
injects validation-error text, which changes the text but not the step, and
the original text-based check read that as progress and re-filled the same
page until the cap. A stall now reports the page's own validation text.
`dismissBlockingOverlay()` closes an interloper modal before each Next —
carefully, because Oracle renders the application form *itself* inside an
`oj-dialog`, so "a large dialog is open" is not evidence of an interloper
and an early version would have torn down the form mid-run; an
informational overlay is identified by containing no form controls at all.

**Deciding what to do with each field**, in order:
1. **Resume file upload** — matched by "resume"/"cv" appearing in the
   field's id, name, `data-testid`, or label (not hardcoded to one ATS's
   convention), excluding anything that also says "cover" so a
   cover-letter slot isn't grabbed instead. `data-testid` is a recent
   addition: confirmed live on a Rippling-hosted form that a file input
   can have completely empty `id`/`name`/`aria-label` — nothing at all for
   the id/name-based hint to match — while still carrying
   `data-testid="input-resume"`, a common automation-hook convention.
   Verified after upload three ways, in order: first that the browser
   actually registered a file (`input.files.length > 0`); then — since
   some widgets remove the file input from the DOM the instant a file is
   accepted, replacing it with a "file selected" UI — the *element
   disappearing* right after a successful upload call is treated as a
   positive signal too; finally, for a still-present input reporting zero
   files (confirmed live: a third real pattern, where a widget keeps the
   *same* input in the DOM but resets its own `.files` the instant it
   consumes the selection into its own React state — visually the upload
   had clearly succeeded, a filename chip replaced the dropzone, but the
   native input alone looked empty) — checks whether a distinctive prefix
   of the uploaded filename shows up anywhere on the page before
   concluding it's a real failure.
2. **Standard recruitment-data consent** — a checkbox or dropdown whose
   text is a narrow "consent to processing my data to consider my
   application" (detected via `isStandardRecruitmentConsent()`, which
   also explicitly excludes anything mentioning marketing, third-party
   sharing, or indefinite/unrelated retention) gets auto-agreed. Anything
   broader is left alone. This also covers bare GDPR-style labels with no
   "consent"/"acknowledge" wording at all — a real Greenhouse-hosted field
   labeled exactly `"Data Protection Notice *"` was initially left for manual
   review because the label alone didn't literally say "consent" or
   "process my data," even though live inspection showed it renders with
   exactly one real option, `Acknowledge/Confirm` — mechanically identical
   to the case already trusted for another live test site's `"Processing
   of Personal Data*"` field, just EU-style phrasing. `isStandardRecruitmentConsent()`
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
3. **"Yes/No" choice-button questions** (work authorization, visa
   sponsorship) — answered via Claude, not skipped. Confirmed live on a
   real Ashby-hosted application form that these don't use a real
   `<input type="radio">` pair at all: it's a single hidden `<input
   type="checkbox" tabindex="-1">`, present only for the site's own
   internal form state, with two plain `<button>` elements ("Yes"/"No")
   as its siblings carrying the actual question text's answer options and
   the real click surface. Before this was recognized, both questions
   were indistinguishable from an ordinary checkbox and fell straight
   into bucket 4 below — the same "always skip" treatment as genuinely
   sensitive EEOC fields, even though they're routine and answerable from
   `work_auth_context.txt`. `discoverFields()` now harvests sibling
   `button` text (direct children of the input's parent only, 2-6 of
   them, each ≤ 40 characters — tight enough to avoid accidentally
   sweeping in an unrelated button like "learn more") into the field's
   `options` whenever a checkbox/radio has none of its own; the main field
   loop then routes any checkbox/radio *with* options through the normal
   Claude-answering pipeline instead of the always-skip bucket — but only
   after the same `SENSITIVE_RE` check bucket 4 uses, so a question that
   happened to render this way but matched EEOC wording would still be
   left alone. On dispatch, `clickChoiceButton()` finds the matching
   sibling `<button>` by text (reusing the same bidirectional
   string-containment matching as combobox options) and clicks it — not
   the hidden input directly, which isn't the real interactive element.
   Confirmed live: work authorization correctly answers "Yes" and
   sponsorship correctly answers "No", while Gender/Race/Veteran Status on
   that same form (real grouped radios, not this button-pair shape) remain
   untouched in bucket 4.
4. **Voluntary EEOC/demographic fields rendered as a radio group**
   (gender, race, veteran/disability status) — grouped back into one
   logical question and auto-declined, the same as bucket 5 below does
   for a select/combobox-shaped version of the exact same question. This
   used to be a real gap: reliably identifying which specific *radio* in
   a group corresponds to "decline to answer" (as opposed to its sibling
   options) wasn't built. Confirmed live on Ashby that it's actually
   straightforward once you look at the real structure: every EEOC radio
   group is multiple real `<input type="radio">` elements sharing one
   native `name` attribute (the real HTML grouping mechanism), with the
   *group's* shared question text living in a `<label>` that's a direct
   child of the group's `<fieldset>` (e.g. `<fieldset> <label>Gender
   </label> <input type="radio">... </fieldset>`) — a different, more
   reliable signal than any individual option's own label ("Male"), which
   is all field-by-field discovery ever saw before. Before
   `fillApplication()`'s main per-field loop runs, a grouping pass now
   collects radios by shared `name` into `DiscoveredField.groupName`
   (each carrying the group's resolved `groupQuestion` too — same
   `fieldset > label` lookup first, then the same 8-level DOM-proximity
   walk used elsewhere as a fallback), tests `groupQuestion` — not any
   one option — against `SENSITIVE_RE`, and for a matching group finds
   whichever option's own label matches `DECLINE_RE` and clicks it via
   `checkField()` (a plain `.check()` sufficed live on Ashby - no
   hidden-input fallback needed here, unlike Rippling). Matched members
   are marked handled so the main loop's generic checkbox/radio bucket
   (still very much in place for anything real that this doesn't cover)
   never sees them individually. Never guesses at an actual demographic
   answer — only ever selects a real "decline" option, or leaves the
   whole group alone if one isn't found. Confirmed live: Gender, Race,
   and Veteran Status all now correctly show their own
   "decline"/"prefer not to self-identify" option selected, while the
   two choice-button questions on the very same form (bucket 3) are
   untouched by this path — the two features are mutually exclusive by
   construction (EEOC radios have no sibling `<button>`s for bucket 3 to
   harvest `options` from, and non-EEOC choice-button questions never
   match `SENSITIVE_RE` for this bucket to act on).
5. **Voluntary EEOC/demographic fields rendered as a select or combobox**
   (gender, race, veteran/disability status) — always get an active
   "decline to answer" style selection when the form offers one, matched
   via a regex covering the several real-world phrasings these take
   ("decline", "prefer not", "I don't wish to answer", "I don't want to
   answer" — the OFCCP-standard veteran and disability forms use
   different verbs for the same intent). The same regex now also
   resolves which specific *radio option* is the decline one for bucket 4
   above. Never guessed at beyond that, never left at a blank default if
   a decline option exists, never written to any file.
6. **Everything else checkbox/radio-shaped** — always left for you. This
   is now a narrower catch-all than it used to be (buckets 3 and 4 above
   peeled off the two confirmed-live shapes that actually need answering),
   covering only checkbox/radio fields that don't match either.
7. **Fixed, deterministic answers** for a few specific question types,
   routed through `answerDirectly()` rather than an LLM call so there's no
   risk of a fabricated answer: "AI policy for interviewers" → "No"; "how
   did you hear about **this opportunity/role**" → "LinkedIn"; the more
   generic "how did you hear about **us/the company**" → "online
   research"/"careers page". Both `HOW_HEARD_RE` regexes match "did you
   hear/find/learn" *and* "have you heard/found/learned" phrasing — an
   earlier version only covered "did you," and a real field on one live
   test site ("Where **have** you learned about us? Select all that apply.")
   used the latter, so it silently missed this deterministic path
   entirely and fell through to Claude instead. That was the actual root
   cause behind that field intermittently coming back unanswered in live
   runs — not generic LLM non-determinism, though see point 8 below for
   the further fallback that also now covers cases like it. "Do you
   consent to receiving text message/SMS updates?" always gets declined —
   a standing instruction, not an AI judgment call. These questions
   commonly render as a `Yes`/`No` radio *pair*, each option individually
   labeled with its own full sentence rather than one field with two
   values, so this one doesn't route through `answerDirectly()` like the
   others — it's matched directly in the main field loop, checking whether
   a `radio`-type field's own resolved label mentions text
   messages/SMS *and* matches the same decline-phrasing regex
   (`DECLINE_RE`) used for EEOC fields, then calls `checkField()` (see
   above) on it.
8. **No discoverable label at all** — left alone. Can't safely answer
   something with zero information about what's being asked.
9. **Known identity and contact fields** (first/last name, email, phone,
   LinkedIn, address, city, state, zip, country, phone country code) —
   filled directly from the resume or `user_profile.txt`, no AI call
   needed. City fields get extra care: a bare city name is often
   ambiguous (there are multiple US cities named Decatur, Springfield,
   etc.), so when both city and state are known, the search tries
   `"City, State"` first and only falls back to the bare name if that
   doesn't match — a bare-name match that happened to land on the wrong
   state was a real, confirmed bug in early testing. "Current Location" is
   now treated as an alias for "city" too - a real Ashby field with that
   exact label fell through to Claude's general answering instead of this
   deterministic path, and without the disambiguation logic here, Claude
   guessed "Atlanta" rather than the profile's actual "Decatur" (see the
   label-masking bug in the `discoverFields()` section above for the
   deeper reason this field's *own* label wasn't recognized at all).
10. **Everything remaining** — custom written questions, salary,
   relocation, work authorization/sponsorship when rendered as a
   select/combobox rather than the choice-button shape bucket 3 now
   covers, education, years of experience with a specific tool, etc. —
   goes to Claude in a single
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
case of exactly that: the iframe-embedded test site's `"First Name"` field
was correctly filled and verified early on, but by the time the run
finished, it appeared empty — most likely because that site's heavy
iframe-embedded React form re-rendered at some point during the many later
combobox interactions
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
Salesforce - a real fabrication caught during testing on an actual live
job description, not a hypothetical. The strengthened prompt fixed it on the
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

**Deterministic terminology normalization — `normalizeCrmTerminology()`.**
The no-fabrication rule constrains *what facts* can appear, but says
nothing about *exact wording* - and the LLM doesn't always phrase the same
underlying fact identically twice. A real run emitted `"CRM Platforms"` in
Technical Skills while Core Competencies (and every other run) used the
candidate's own canonical phrase, `"CRM Platform Experience"` - not a
fabrication, just wording drift that made otherwise-identical resumes look
inconsistent side by side. Rather than trying to hold this with prompt
wording alone (which is exactly the kind of thing that regresses silently
across runs), `generateReplacements()` now runs every skills-section
replacement through a deterministic regex normalization pass after the
LLM call returns, before that text is spliced into the document - so the
canonical wording is guaranteed regardless of phrasing choice.
`isSkillsSection()` scopes this to the Technical Skills/Core Competencies
placeholders only (matched against `sectionHeader`/`paragraphText`) -
forcing the exact noun phrase into prose elsewhere (the Professional
Summary) would read unnaturally.

The regex itself needed a second pass: `/\bCRM\b(?:[\s-]+(?:Platform|
Platforms|...))*/gi` looked reasonable but failed on exactly the
motivating case. Regex alternation takes the *first* alternative that
matches at a position, not the longest, and `Platform` is a prefix of
`Platforms` - so against `"CRM Platforms"`, the group matched only
`"CRM Platform"`, leaving the trailing `"s"` outside the replaced span
entirely. The replace call then swapped in the canonical phrase and left
that stray `"s"` glued on immediately after, producing `"CRM Platform
Experiences"` - a *different*, new inconsistency, caught by a live test
run before it shipped (not a hypothetical). Fixed by listing every plural
form before its singular prefix (`Platforms` before `Platform`, `Tools`
before `Tool`, `Systems` before `System`, `Applications` before
`Application`) so the longer alternative gets first crack at matching.
Verified via a dedicated unit test importing the real exported function
(not a hand-copied mirror, which is how the first version of this test
missed the bug) against 12 cases including the exact original failure
string, an already-canonical no-op case, and an unrelated word
(`"CRMagic"`) that must NOT be touched - all pass. Also confirmed the
normalization runs *before* each attempt's page-count check inside the
generation loop (not as a post-hoc step after convergence is already
verified), so a length change from normalization can never silently
invalidate an already-confirmed page count.

**Surfacing the most specific genuinely-true match — Professional
Summary.** The no-fabrication rule's "don't invent facts" framing had a
side effect: it made the prompt lean toward safe, generic phrasing even
when a *more specific, equally true* fact was sitting right there in the
resume and would be a stronger match. Confirmed live: a job description
emphasizing HR-systems administration produced a generic "systems-minded"
Summary opening rather than naming the candidate's actual System
Administrator experience (device/endpoint management via Intune and
Google Admin, network infrastructure - a real past role, not adjacent
inference). Added an explicit prompt instruction: when the job
description specifically emphasizes systems administration/IT
infrastructure/technical systems management and that experience actually
appears in the resume, name it explicitly rather than defaulting to
vaguer framing - still fully bound by the no-fabrication rule above, this
is about *which true thing* to lead with, not license to add anything new.
Verified live on the same JD after the change: the regenerated Summary
opens with "hands-on experience administering technical systems
(including device/endpoint management via Intune and Google Admin)" -
the specific, real experience, not the generic placeholder phrasing.

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
live against two different real job descriptions (including the
iframe-embedded test site's): both converged
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
boards using your actual resume. Company names are withheld below (these
are real employers' live sites) - each row is a distinct test site,
identified by its ATS and what made it a useful test case:

| ATS | Notable for |
|---|---|
| Greenhouse | First working end-to-end run |
| Greenhouse | Regression check |
| Greenhouse | Regression check |
| Lever | Found and fixed a real selector-fragility bug; hit a CAPTCHA (expected, not solved) |
| Greenhouse | Genuinely Atlanta-based match; personal-context fields first proven live |
| Greenhouse (iframe-embedded on the company's own domain) | The hardest form by far — iframe detection, combobox scoping/harvesting, multi-select, and the retry mechanism were all proven or fixed here |
| Greenhouse | Regression check; also the source of a real how-did-you-hear regex gap |
| Rippling ATS | First third-party platform tested (not Greenhouse/Lever) — surfaced and fixed a real fabricated-demographic-data bug, plus discovery/interaction gaps for `div`-based comboboxes, visually-hidden inputs, and a file-upload false negative |
| Ashby | Fourth ATS platform — surfaced its own distinct DOM shapes for EEOC radio groups (`fieldset` + direct-child `label`, now auto-declined) and Yes/No screening questions (hidden checkbox + sibling `button` pair), plus a broken `label for=` association that masked a required field's real label *and* its CSS-only asterisk |
| Oracle HCM Cloud | Fifth ATS platform and the hardest so far — **partially working**. First platform with a real anti-bot honeypot, first multi-page application, first requiring an emailed verification code, and the source of a false-positive in `checkField()` that had been silently affecting every checkbox on every platform. Gets through cookie rejection, honeypot/AI-widget skipping, email, the required consent checkbox, and the verification pause; does not yet continue past the verification step |

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
  place of the static resume - confirmed on two different live test sites,
  including the iframe-embedded one.

## What's rough or untested

- **The generic fallback scraper (non-Greenhouse, non-Lever) is still
  untested against a real site.**
- **Multi-select fields were the least reliable field type** — confirmed
  happening intermittently across repeated live runs against the exact
  same field on the exact same form (two consecutive runs against the
  iframe-embedded test site, identical resume/JD/criteria, one succeeded
  and one didn't). One real
  instance of this traced back to an actual root cause rather than pure
  non-determinism (the how-heard regex gap described above) and is now
  fixed outright. The residual risk for genuinely novel multi-select
  fields — not "how did you hear," just some other select-all-that-apply
  question — now has a further single-value-schema fallback layered onto
  the existing retry (see "The multi-select fallback" above), which
  should meaningfully reduce, though not provably eliminate, how often
  this class of field still needs manual completion.
- **Bot detection can be a hard blocker.** One Lever-hosted test site's
  form presented a CAPTCHA challenge partway through the run. The tool can't
  and won't attempt to solve it.
- **The multi-page loop has not been driven past a verification step.**
  On Oracle HCM Cloud it reaches the emailed-code screen, pauses correctly
  in `--headed` mode, and resumes when the code is entered — but the run
  then ends rather than continuing through the remaining pages, most
  likely because the following step's control isn't matched by the
  Next/Continue vocabulary. Everything past verification is genuinely
  unexplored: no page beyond it has ever been reached, so the pagination
  logic is still only proven across a single real transition.
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
| [`src/filter.ts`](src/filter.ts) | Cheap keyword/salary/location/experience/employment-type filtering, plus the timezone/region soft-flag |
| [`src/match.ts`](src/match.ts) | Claude-based ranking of resume vs. job postings |
| [`src/apply.ts`](src/apply.ts) | Discover and fill application form fields (by far the largest module) |
| [`src/resumeGenerator.ts`](src/resumeGenerator.ts) | Detect + tailor bracket+italic `.docx` placeholders, verify page count via Word, save the tailored file |
| [`scripts/docx-to-pdf.ps1`](scripts/docx-to-pdf.ps1) | PowerShell/Word-COM helper: renders a `.docx` to PDF for the page-count check |
| [`src/index.ts`](src/index.ts) | CLI entrypoint, wires everything together |
| [`criteria.json`](criteria.json) | Reusable screening-rules profile (titles, salary floor, locations, etc.) |
| [`user_profile.txt` / `qa_context.txt` / `work_auth_context.txt`](.) | Gitignored personal context (not committed - create your own) |
| [`README.md`](README.md) | Setup and run instructions |
