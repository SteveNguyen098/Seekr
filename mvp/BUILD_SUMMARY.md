# Seekr Auto-Apply POC — Build Summary

## What this is, in plain English

This is a small command-line tool that proves out Seekr's core idea: **give it
a company's job listings page and your resume, and it will find the single
best-matching open role and fill out that job's application form for you.**
It stops right before hitting "Submit" so a human always makes the final
call.

Think of it as a very literal-minded assistant: it reads the job board like
a person would, reads your resume, decides which job you're the best fit
for, and then types your information into the application — but it refuses
to guess on anything it's not confident about (sensitive personal
questions, oddly-behaved dropdown menus), and it never clicks the final
submit button itself.

It runs from a terminal command right now, not a polished app — that's
intentional for this stage. The goal was to prove the mechanics work
end-to-end before investing in a UI.

## The end-to-end flow

1. You give it a career page URL, a resume file, some keywords describing
   the kind of role you want, and (optionally) how many years of experience
   you have.
2. It opens the career page in a real (invisible, "headless") browser and
   reads every job posting listed there.
3. It throws out anything whose title doesn't match your keywords, and
   anything whose description asks for more years of experience than you
   have.
4. For what's left, it asks Claude (Anthropic's AI model) to actually read
   your resume against each job description and score the fit, the same
   way a recruiter would skim both and judge.
5. It opens the best-scoring job's application page and fills in what it
   can respond to confidently: your name, email, phone, LinkedIn, your
   resume file itself, and any custom written questions the job asks
   ("why do you want to work here," etc.).
6. It deliberately leaves some things blank for you: consent checkboxes,
   voluntary demographic questions (gender, race, veteran status), and any
   dropdown menu it doesn't trust itself to fill correctly (more on why
   below).
7. It saves a screenshot of the filled-out form and **stops.** Nothing gets
   submitted automatically.

## How each piece actually works (technical detail)

All code lives in [mvp/src](src). It's a small Node.js/TypeScript project —
no framework, no database, no UI yet. Five modules, each doing one job,
strung together by a CLI script.

### 1. Reading the resume — [`src/resume.ts`](src/resume.ts)

`loadResume(filePath)` opens a `.docx` file (via the `mammoth` library,
which strips Word formatting down to plain text) or a `.txt` file, then
uses a few regular expressions to pull out an email address, a phone
number, and a name (assumed to be the first line of the resume) alongside
the full text. Everything downstream — matching and form-filling — works
off of this one `Resume` object.

### 2. Reading the job board — [`src/scrape.ts`](src/scrape.ts)

`listJobs(page, careerUrl)` drives a real browser (via Playwright) to the
career page, waits for the page to finish loading its JavaScript (most
modern job boards, including Greenhouse's, render their listings client-side
rather than in the raw HTML — a plain HTTP fetch would see almost nothing),
and then reads out every job title, link, and location.

It has two modes:
- A **Greenhouse-specific fast path** that reads the exact HTML structure
  Greenhouse boards use, so it comes back clean (e.g. it strips off the
  "New" badge Greenhouse glues onto the end of fresh postings' titles).
- A **generic fallback** for any other site: it grabs every link on the
  page and keeps ones whose URL looks like a job posting (contains
  `/job/`, `/jobs/`, `/position/`, etc.) and whose link text looks like a
  plausible job title. This is the part most likely to need tuning once
  you point it at a real target company that isn't on Greenhouse.

`getJobDescription(page, jobUrl)` does the same kind of browser visit for
one specific job posting and returns its full text, used later for both
filtering and matching.

### 3. Deciding which job is the best fit — two stages, cheap-then-smart

**Stage A — free, instant filtering: [`src/filter.ts`](src/filter.ts)**
- `filterByTitle(jobs, criteria)` keeps only postings whose title contains
  one of your keywords (plain substring match, case-insensitive).
- `passesHardRequirements(descriptionText, criteria)` scans a job's full
  description text for phrases like "3+ years of experience" and drops the
  posting if it asks for more years than you told the tool you have. This
  is a regex, not AI — free and instant, and it means we don't waste an AI
  call on jobs that were never going to work.

**Stage B — AI ranking: [`src/match.ts`](src/match.ts)**
Only the postings that survive Stage A get sent to Claude. `rankJobs(...)`
sends your full resume plus every surviving job description in a single
request, and asks Claude (via a structured "tool call" so the response
comes back as clean, parseable data rather than free-form prose) to score
each one 0–100 with a short reason. The highest score wins.

This two-stage design was a deliberate choice: cheap keyword/regex
filtering narrows the field first, and the more expensive/nuanced AI
judgment only runs on plausible candidates.

### 4. Filling out the application — [`src/apply.ts`](src/apply.ts)

This is the most involved piece, because real application forms are messy.

`openApplicationForm(page, jobUrl)` navigates to the job and clicks
"Apply" if the form isn't already showing.

`discoverFields(page)` reads every input, dropdown, and text box on the
page and, for each one, tries to figure out its human-readable label by
checking (in order) its `aria-label`, an associated `<label>` element,
a wrapping `<label>`, or its placeholder text. It also flags whether a
field is a "combobox" — a custom-built dropdown widget (common library:
React-Select) rather than a plain HTML dropdown, which matters a lot (see
Known Limitations).

`fillApplication(...)` then walks every discovered field and decides what
to do with it, in this order:
1. **The resume file upload** gets your actual resume file attached.
2. **Checkboxes/radio buttons** (consent, legal agreements) are always
   left alone — never auto-checked.
3. **Combobox-style dropdowns** are always left alone (explained below).
4. **Sensitive fields** (gender, race, veteran/disability status —
   detected via a keyword pattern) are always left alone.
5. **Fields with no discoverable label** are left alone and flagged for
   manual review, since guessing at an unlabeled field is too risky.
6. **Known identity fields** (first name, last name, email, phone,
   LinkedIn) are filled directly from the parsed resume data — no AI call
   needed, since these are unambiguous.
7. **Everything else** (custom written questions, "how did you hear about
   us," work-authorization questions) is batched up and sent to Claude in
   one request — `answerWithClaude(...)` — which reads your resume and the
   job description and either answers each one or returns an empty string
   if it can't confidently do so from what's in your resume.

Every text field that gets filled goes through `fillTextVerified(...)`,
which re-reads the field from the page a moment after filling it to
confirm the value actually stuck (see Known Limitations for why this
matters).

Finally, it takes a full-page screenshot and returns a report of exactly
what got filled and what got skipped, with a reason for every skip.

### 5. Tying it together — [`src/index.ts`](src/index.ts)

The CLI entrypoint. Parses command-line flags (`--career-url`, `--resume`,
`--titles`, `--max-years`, `--out`, `--headed`), runs the steps above in
order, and prints a readable log of what it found, what it filtered out,
how it scored each candidate, and what it did and didn't fill in. It never
calls anything resembling a "submit" action.

## What's actually working (verified with a live run)

I ran this against a real, live public job board —
`job-boards.greenhouse.io/attentive` — using your actual resume, end to
end, more than once while fixing bugs. Confirmed working:

- Scraping a real career page and finding all 47 open postings.
- Filtering down to relevant titles and correctly excluding 3 postings for
  requiring more experience than specified.
- Claude correctly ranking "Program Coordinator" as the best fit over a
  "Senior Product Analyst" and "Strategy & Operations Associate" role, with
  sensible reasoning about seniority and domain mismatch.
- Opening the real application form and correctly filling name, email,
  phone, LinkedIn, and uploading the actual resume file.
- Correctly leaving demographic/EEO questions, a consent checkbox, and
  ambiguous fields untouched.
- Producing a screenshot that matches the written report exactly (i.e. the
  report doesn't lie about what's actually on the page).
- Stopping before submission every time.

## What's rough or untested

- **Only tested against one company, on one ATS (Greenhouse).** The
  generic fallback scraper for non-Greenhouse sites has never been run
  against a real non-Greenhouse site yet.
- **Cover letters aren't handled at all** — no generation, no upload, even
  if the form has a slot for one.
- **No test suite.** Verification so far has been live manual runs and
  reading the screenshot, not automated tests.
- **Resume parsing only handles `.docx` and `.txt`** — no `.pdf` support
  yet.
- **The "years of experience" filter is a simple regex** looking for
  phrases like "3+ years of experience." It will miss requirements phrased
  differently, and can't reason about *which kind* of experience is being
  asked for.
- **Headed (visible-browser) mode couldn't be tested from this session** —
  it works in principle but needs to be run from your own terminal, not
  through the coding agent (see below).

## Known limitations (by design, not oversights)

- **Custom dropdown widgets are always skipped, on purpose.** Many modern
  application forms (this one included) use JavaScript-built dropdowns
  instead of plain HTML `<select>` menus — the "Country" and "willing to
  relocate"-style questions, for example. Early on, automating these
  looked like it worked (no error was thrown) but the typed value was
  silently discarded by the page's own code a moment later, which would
  have made the tool's report lie to you about what was actually filled
  in. Rather than risk that, `discoverFields` detects these widgets and
  `fillApplication` always leaves them for you to pick manually. This is
  the right tradeoff for something whose whole safety model depends on you
  trusting the report before you hit submit — but it does mean some
  *required* fields can be left blank, and the form may not be
  submission-ready as-is.
- **Never fills consent checkboxes or voluntary demographic questions**,
  even if it could technically guess an answer. These are legally and
  personally sensitive by nature and are always left for a human.
- **Never clicks submit.** This isn't a setting, it's not wired up at all
  — there's no code path that could submit an application even by
  accident.
- **Runs headless by default.** A `--headed` flag exists to open a real,
  visible browser window instead, but that can only be run from your own
  terminal — the sandboxed environment the coding agent runs shell commands
  in has no attached desktop/window, so it's structurally unable to open a
  GUI window at all.

## Quick file map

| File | Responsibility |
|---|---|
| [`src/resume.ts`](src/resume.ts) | Parse resume file → text + contact fields |
| [`src/scrape.ts`](src/scrape.ts) | Read a career page → list of job postings |
| [`src/filter.ts`](src/filter.ts) | Cheap keyword + years-of-experience filtering |
| [`src/match.ts`](src/match.ts) | Claude-based ranking of resume vs. job postings |
| [`src/apply.ts`](src/apply.ts) | Discover and fill application form fields |
| [`src/index.ts`](src/index.ts) | CLI entrypoint, wires everything together |
| [`README.md`](README.md) | Setup and run instructions |
