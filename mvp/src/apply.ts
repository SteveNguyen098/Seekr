import type { Page, Frame } from "playwright";
import Anthropic from "@anthropic-ai/sdk";
import path from "node:path";
import { MODEL } from "./match.js";
import type { Resume } from "./resume.js";
import type { PersonalContext } from "./context.js";

/** A page or, when the real form lives in an embedded iframe, that frame. */
type FormContext = Page | Frame;

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Some companies embed a Greenhouse/Lever application form as an iframe on
 * their own branded domain (e.g. Samsara's careers page loads
 * job-boards.greenhouse.io/embed/job_app in a cross-origin iframe). Normal
 * browser JS - including a page.waitForFunction callback - can't see into a
 * cross-origin iframe's DOM at all, but Playwright's own automation
 * protocol can reach into any frame directly via frame.$$eval(). Count
 * fields in every frame so callers can find wherever the real form is.
 */
async function countFields(ctx: FormContext): Promise<number> {
  return ctx.$$eval("input:not([type=hidden]), textarea, select", (els) => els.length).catch(() => 0);
}

function allContexts(page: Page): FormContext[] {
  return [page, ...page.frames()];
}

export interface DiscoveredField {
  selector: string;
  tag: "INPUT" | "TEXTAREA" | "SELECT";
  type: string;
  label: string;
  required: boolean;
  options: string[];
  isCombobox: boolean;
  idOrName: string;
  /**
   * True for a native <select multiple>. Comboboxes can also turn out to
   * be multi-select, but that's only knowable once opened (via
   * aria-multiselectable on the listbox), so it's determined later during
   * option harvesting, not here.
   */
  multiSelect: boolean;
}

export interface FillReport {
  filled: { label: string; value: string; generated?: boolean; lowConfidence?: boolean }[];
  skipped: { label: string; reason: string; required?: boolean }[];
  screenshotPath: string;
}

const SENSITIVE_RE =
  /gender|race\b|ethnicit|veteran|disability|sexual orientation|pronoun|voluntary self|hispanic|latino/i;
const CONSENT_RE = /consent|gdpr|privacy policy|data protection|terms of service|recaptcha/i;
// "How/where did you hear about THIS OPPORTUNITY/role" gets a different
// answer than "how did you hear about US/the company" - check the more
// specific pattern first. Must cover both "how" and "where" phrasing, same
// as the general fallback below, or forms using "where" fall through to
// the wrong bucket. Must also cover both "did you hear/find/learn" AND
// "have you heard/found/learned" phrasing - a real Samsara field ("Where
// have you learned about Samsara? Select all that apply.") used the latter
// and silently missed both regexes entirely, so it fell through to Claude's
// general answering path instead of this deterministic one - the actual
// root cause behind that field's flaky answers, not LLM non-determinism.
const HOW_HEARD_VERB_RE = "(hear|heard|find|found|learn|learned|learnt)";
const HOW_HEARD_OPPORTUNITY_RE = new RegExp(`(how|where) (did|have) you ${HOW_HEARD_VERB_RE}.*(this )?(opportunity|role|position|job)`, "i");
const HOW_HEARD_RE = new RegExp(`how (did|have) you ${HOW_HEARD_VERB_RE}|where (did|have) you ${HOW_HEARD_VERB_RE}`, "i");
const AI_POLICY_RE = /\bAI\b.*(policy|tool|assist|usage|disclos)/i;
// OFCCP-mandated EEOC self-ID forms use inconsistent phrasing across
// sites/forms: the standard veteran form says "don't wish to answer" while
// the standard disability form (CC-305) says "don't want to answer" -
// needs both "wish" and "want", each in "don't/doesn't/do not/does not" form.
const DECLINE_RE =
  /decline|prefer not|choose not|(does\s*not|doesn't|don't|do\s*not)\s*(wish|want)|not disclosed|n\/a\b/i;
const HOW_HEARD_OPPORTUNITY_CANDIDATES = ["LinkedIn", "LinkedIn Job Posting", "LinkedIn Jobs", "Social Media", "Professional Network", "Other"];
const HOW_HEARD_CANDIDATES = ["Company careers page", "Company website", "Careers page", "Website", "Online research", "Search engine", "Other"];
const AI_POLICY_CANDIDATES = ["No"];

// Recruitment-data consent checkboxes get auto-checked ONLY when their
// scope is the standard "process my data to consider my application"
// kind - never when the text also covers marketing, third-party sharing,
// or indefinite/unrelated retention, which stay a human decision.
const CONSENT_BROADER_SCOPE_RE =
  /marketing|third[- ]part(y|ies)|share\b.*(partner|affiliate|vendor)|indefinite(ly)?|unrelated purpose|advertis/i;
const CONSENT_AGREE_CANDIDATES = ["Yes", "I agree", "I consent", "Accept", "Agree", "Acknowledge", "Confirm"];
function isStandardRecruitmentConsent(label: string): boolean {
  if (CONSENT_BROADER_SCOPE_RE.test(label)) return false;
  // "Privacy Notice Acknowledgement" style fields are inherently the same
  // category (a required data-processing acknowledgement) even without
  // mentioning "personal data" or "recruitment" by name - short-circuit
  // past the stricter check below, which they'd otherwise fail.
  if (/privacy notice.*acknowledg|acknowledg.*privacy notice/i.test(label)) return true;
  // Same category again, but for a label that's just the bare policy name
  // with no "consent"/"acknowledge"/"process" wording at all (e.g. a real
  // OneTrust field labeled exactly "Data Protection Notice"). Confirmed
  // live that this renders with exactly one real option, "Acknowledge/
  // Confirm" - mechanically identical to the case above, just GDPR-style
  // phrasing instead. Still gated by the broader-scope exclusion above, so
  // "Data Protection and Marketing Notice" is correctly excluded before
  // reaching this line.
  // Required-field labels carry a trailing " *" (see the asterisk fallback
  // in discoverFields()), so the end anchor must tolerate trailing
  // whitespace/asterisks, not just whitespace.
  if (/^(the\s+)?(data protection|privacy|gdpr)\s+(notice|policy)(\s+acknowledg\w*)?[\s*]*$/i.test(label.trim())) return true;
  if (!/consent|process(ing)? of (your |my )?(personal )?data|data processing/i.test(label)) return false;
  return /(process|collect|store|use)(ing|ed)?\b[^.]*(personal (data|information))|personal (data|information)[^.]*(process|collect|store|use)|recruit(ment|ing)?/i.test(
    label
  );
}

/** Opens the job page and clicks through to the application form if needed. */
export async function openApplicationForm(page: Page, jobUrl: string): Promise<void> {
  // Some ATS embeds run on a company's own branded domain (e.g. Samsara's
  // careers page) with persistent background network activity - analytics,
  // chat widgets, etc. - that never lets "networkidle" resolve. Fall back
  // to a plain "load" wait rather than crashing the whole run.
  await page.goto(jobUrl, { waitUntil: "networkidle", timeout: 30000 }).catch(() =>
    page.goto(jobUrl, { waitUntil: "load", timeout: 30000 })
  );
  const applyBtn = await page.$("a:has-text('Apply'), button:has-text('Apply')");
  if (applyBtn) {
    await applyBtn.click();
  }
  // Wait for the actual application form to mount rather than a fixed
  // delay. Native Greenhouse/Lever pages render almost immediately, but
  // some ATS embeds on a company's own branded domain (e.g. Samsara's
  // careers page) inject their form - often inside a cross-origin iframe -
  // well after "Apply" is clicked. A page.waitForFunction callback only
  // sees the main frame's DOM, so poll every frame from the Node side
  // instead, and give up gracefully after 15s rather than crash.
  const deadline = Date.now() + 15000;
  while (Date.now() < deadline) {
    const max = Math.max(...(await Promise.all(allContexts(page).map(countFields))));
    if (max >= 3) break;
    await delay(300);
  }
  // Brief settle buffer in case the last field or two is still mounting.
  await delay(500);
}

/** Finds whichever context (main page or an iframe) actually holds the form. */
export async function findFormContext(page: Page): Promise<FormContext> {
  const contexts = allContexts(page);
  const counts = await Promise.all(contexts.map(countFields));
  let best = 0;
  for (let i = 1; i < contexts.length; i++) {
    if (counts[i] > counts[best]) best = i;
  }
  return contexts[best];
}

export async function discoverFields(ctx: FormContext): Promise<DiscoveredField[]> {
  return ctx.$$eval("input, textarea, select", (els) =>
    els
      .map((el, i) => {
        const tag = el.tagName as "INPUT" | "TEXTAREA" | "SELECT";
        const type = (el as HTMLInputElement).type || tag.toLowerCase();
        if (["hidden", "submit", "button"].includes(type)) return null;

        let label = el.getAttribute("aria-label") || "";
        if (!label && el.id) {
          const labelEl = document.querySelector(`label[for="${el.id}"]`);
          label = labelEl?.textContent?.trim() || "";
        }
        if (!label) {
          const closestLabel = el.closest("label");
          label = closestLabel?.textContent?.trim() || "";
        }
        if (!label) label = el.getAttribute("placeholder") || "";

        // Primary signal: the real HTML/ARIA required attribute. Fallback:
        // a visible asterisk in the label text, for forms that mark a
        // field required only visually without the programmatic attribute
        // to match (a real, if sloppy, pattern some ATS forms use).
        const requiredAttr = el.hasAttribute("required") || el.getAttribute("aria-required") === "true";
        const required = requiredAttr || /\*/.test(label);
        const options =
          tag === "SELECT"
            ? Array.from((el as HTMLSelectElement).options).map((o) => o.textContent?.trim() || "")
            : [];
        const multiSelect = tag === "SELECT" && (el as HTMLSelectElement).multiple;

        // Build a resilient selector: prefer id. Otherwise, DO NOT use
        // `tag:nth-of-type(i+1)` - that CSS pseudo-class counts siblings
        // within each element's own parent, not a page-wide position, so a
        // flat loop index does not correspond to what it actually selects
        // (on forms where every field sits in its own wrapper div, most
        // inputs are "the 1st input of their parent" and the selector
        // becomes ambiguous or points at the wrong element entirely).
        // Instead, tag the live element with a unique marker attribute and
        // select on that - guaranteed unique regardless of DOM shape.
        let selector: string;
        if (el.id) {
          selector = `#${CSS.escape(el.id)}`;
        } else {
          el.setAttribute("data-seekr-field", String(i));
          selector = `[data-seekr-field="${i}"]`;
        }

        // Custom widgets (react-select, intl-tel-input, etc.) expose a plain
        // <input> as a search/typeahead box, but the real selection lives in
        // separate JS state - a raw .fill() looks like it worked, then gets
        // silently reverted on the widget's next render. These need real
        // click-to-open-and-select interaction (see selectComboboxOption).
        const isCombobox =
          el.getAttribute("role") === "combobox" ||
          el.getAttribute("aria-autocomplete") === "list" ||
          el.getAttribute("aria-haspopup") === "true";

        const idOrName = `${el.id} ${el.getAttribute("name") || ""}`.trim();

        return { selector, tag, type, label: label.trim(), required, options, isCombobox, idOrName, multiSelect };
      })
      .filter((f): f is NonNullable<typeof f> => f !== null && f.type !== "search")
  );
}

/**
 * Reads the options for a currently-open combobox, scoped to the specific
 * listbox it controls (via aria-controls/aria-owns, which react-select and
 * similar widgets set once opened) rather than a bare page-wide
 * `[role="option"]` query. Some ATS pages keep other widgets' listboxes
 * mounted in the DOM even when not visibly open - e.g. a phone/country-code
 * picker with ~250 options - and an unscoped query silently mixes those
 * into every other dropdown's results, drowning out the handful of options
 * that actually belong to the field being answered.
 */
async function getListboxOptions(ctx: FormContext, selector: string) {
  const listboxId = await ctx
    .$eval(selector, (el) => el.getAttribute("aria-controls") || el.getAttribute("aria-owns"))
    .catch(() => null);
  // Use an attribute-equality selector rather than the `#id` shorthand:
  // some widgets generate ids containing CSS-special characters (e.g.
  // "react-select-question_67645493[]-listbox" for a multi-select field -
  // the "[]" is a real, apparently common naming convention marking it as
  // an array field), which `#id` parses as invalid selector syntax and
  // throws on. A quoted attribute value sidesteps escaping entirely.
  const scopedSelector = listboxId ? `[id="${listboxId}"] [role="option"]` : '[role="option"]';
  return ctx.$$(scopedSelector).catch(() => []);
}

function optionTextMatches(text: string, candidate: string | RegExp): boolean {
  if (typeof candidate !== "string") return candidate.test(text);
  const t = text.toLowerCase();
  const c = candidate.toLowerCase();
  // Claude's guess is often a fuller phrasing of a terser real option
  // (e.g. "Bachelor's Degree" vs. the real "Bachelor's"), so check both
  // containment directions, not just one.
  return t === c || t.includes(c) || c.includes(t);
}

/** Finds the first currently-rendered option matching any candidate, without clicking it. */
async function findMatchingOption(ctx: FormContext, selector: string, candidates: (string | RegExp)[]) {
  const options = await getListboxOptions(ctx, selector);
  for (const candidate of candidates) {
    for (const opt of options) {
      const text = (await opt.textContent().catch(() => ""))?.trim() ?? "";
      if (text && optionTextMatches(text, candidate)) return { handle: opt, text };
    }
  }
  return null;
}

/**
 * Opens a custom combobox/react-select-style widget and clicks whichever
 * rendered option matches one of the given candidates (checked in order).
 * Typing a plain .fill() value into these gets silently discarded (see
 * fillTextVerified), so this is the only reliable way to answer them.
 * Returns the option's actual text if a match was clicked, or null (and
 * closes the dropdown again) if nothing matched.
 */
async function selectComboboxOption(
  ctx: FormContext,
  selector: string,
  candidates: (string | RegExp)[]
): Promise<string | null> {
  const opened = await ctx.click(selector).then(() => true).catch(() => false);
  if (!opened) return null;
  await delay(400);

  const tryMatch = async (): Promise<string | null> => {
    const match = await findMatchingOption(ctx, selector, candidates);
    if (!match) return null;
    const clicked = await match.handle.click().then(() => true).catch(() => false);
    return clicked ? match.text : null;
  };

  // Static picklists (Yes/No, Country, decline-to-answer, etc.) render
  // every option immediately on open.
  let result = await tryMatch();
  if (result) return result;

  // Search-driven autocompletes (e.g. a city/address lookup) only populate
  // options once something is typed - try typing each candidate in turn.
  for (const candidate of candidates) {
    const seed = typeof candidate === "string" ? candidate : "decline";
    await ctx.fill(selector, seed).catch(() => {});
    await delay(600);
    result = await tryMatch();
    if (result) return result;
  }

  await ctx.press(selector, "Escape").catch(() => {});
  return null;
}

/**
 * Same idea as selectComboboxOption, but for a multi-select widget
 * (aria-multiselectable="true" on its listbox): clicks a match for EVERY
 * value given, in sequence, without closing the dropdown between picks -
 * multi-select widgets stay open across selections rather than closing
 * after the first one like a single-select does. Returns the real option
 * text actually clicked for each value that found a match.
 */
async function selectMultipleComboboxOptions(
  ctx: FormContext,
  selector: string,
  values: string[]
): Promise<string[]> {
  const opened = await ctx.click(selector).then(() => true).catch(() => false);
  if (!opened) return [];
  await delay(400);

  const selected: string[] = [];
  for (const value of values) {
    let match = await findMatchingOption(ctx, selector, [value]);
    if (!match) {
      // Search-driven multi-select: type to reveal matching options, then look again.
      await ctx.fill(selector, value).catch(() => {});
      await delay(500);
      match = await findMatchingOption(ctx, selector, [value]);
    }
    if (match) {
      const clicked = await match.handle.click().then(() => true).catch(() => false);
      if (clicked) {
        selected.push(match.text);
        // Give the widget a moment to re-render (add a chip, mark the
        // option selected) before the next lookup.
        await delay(300);
      }
    }
  }

  await ctx.press(selector, "Escape").catch(() => {});
  return selected;
}

/**
 * Opens a combobox just to read its rendered option list (without
 * selecting anything) so Claude can be given the real, exact choices
 * instead of guessing blind - the same problem fillTextVerified guards
 * against for typed values, but for "pick from a list" fields. Only
 * useful for static picklists that render every option on open; a
 * search-driven autocomplete (e.g. a city lookup) won't show anything
 * until something is typed and will just come back empty here, which is
 * fine - execution falls back to the typing-based match in
 * selectComboboxOption/selectMultipleComboboxOptions regardless. Also
 * reports whether the listbox is multi-select, via aria-multiselectable.
 */
async function harvestComboboxOptions(
  ctx: FormContext,
  selector: string
): Promise<{ options: string[]; multiSelect: boolean }> {
  const opened = await ctx.click(selector).then(() => true).catch(() => false);
  if (!opened) return { options: [], multiSelect: false };
  await delay(400);
  const listboxId = await ctx
    .$eval(selector, (el) => el.getAttribute("aria-controls") || el.getAttribute("aria-owns"))
    .catch(() => null);
  const multiSelect = listboxId
    ? await ctx.$eval(`[id="${listboxId}"]`, (el) => el.getAttribute("aria-multiselectable") === "true").catch(() => false)
    : false;
  const optionHandles = await getListboxOptions(ctx, selector);
  const texts = await Promise.all(optionHandles.map((h) => h.textContent().then((t) => t?.trim() ?? "").catch(() => "")));
  await ctx.press(selector, "Escape").catch(() => {});
  return { options: texts.filter(Boolean), multiSelect };
}

/**
 * Answers a field with a fixed, deterministic (non-Claude) value or
 * candidate list - used for questions whose answer is dictated directly by
 * instruction (how-did-you-hear, AI policy) rather than inferred. Handles
 * all three field shapes (combobox / native select / plain text) the same
 * way callers already do for identity and contact fields.
 */
async function answerDirectly(
  formCtx: FormContext,
  field: DiscoveredField,
  candidates: string[],
  filled: FillReport["filled"],
  skipped: FillReport["skipped"],
  failureReason: string,
  filledSelectors?: FilledTextRecord[]
): Promise<void> {
  if (field.isCombobox) {
    const picked = await selectComboboxOption(formCtx, field.selector, candidates);
    if (picked) filled.push({ label: field.label, value: picked, generated: true });
    else skipped.push({ label: field.label, reason: failureReason, required: field.required });
    return;
  }
  if (field.tag === "SELECT") {
    const match = field.options.find((o) => candidates.some((c) => o.toLowerCase().includes(c.toLowerCase())));
    if (match) {
      const ok = await formCtx.selectOption(field.selector, { label: match }).then(() => true).catch(() => false);
      if (ok) filled.push({ label: field.label, value: match, generated: true });
      else skipped.push({ label: field.label, reason: failureReason, required: field.required });
    } else {
      skipped.push({ label: field.label, reason: failureReason, required: field.required });
    }
    return;
  }
  await fillTextVerified(formCtx, field.selector, field.label, candidates[0], filled, skipped, field.required, true, false, filledSelectors);
}

interface AnswerableField {
  selector: string;
  label: string;
  tag: string;
  options: string[];
  isCombobox: boolean;
  required: boolean;
  multiSelect: boolean;
}

export interface ClaudeAnswer {
  value: string;
  values: string[];
  confidence: "high" | "low";
}

const ANSWER_TOOL: Anthropic.Tool = {
  name: "answer_fields",
  description: "Provide answers for a list of job application form fields based on the resume, job description, and the candidate's own guidance.",
  input_schema: {
    type: "object",
    properties: {
      answers: {
        type: "array",
        items: {
          type: "object",
          properties: {
            selector: { type: "string" },
            value: {
              type: "string",
              description:
                "The value to enter, for ordinary (single-answer) fields. Whenever an \"options\" list is provided (for a select OR a combobox field), value must exactly match one of those options - do not paraphrase or invent a value not on the list. For a combobox field with no options listed, give a short target phrase to search for among that dropdown's options once opened (e.g. \"Yes\", \"United States\") - not a full sentence. For a field marked [MULTI-SELECT], leave this as an empty string and use \"values\" instead. May only be an empty string for fields marked [optional] below - fields marked [REQUIRED] must always get a real best-effort answer (in \"value\" or \"values\", whichever applies).",
            },
            values: {
              type: "array",
              items: { type: "string" },
              description:
                "Used ONLY for fields marked [MULTI-SELECT]: the list of options to select, each exactly matching one of the provided options (\"select all that apply\" style). Leave as an empty array for every other field - use \"value\" for those instead.",
            },
            confidence: {
              type: "string",
              enum: ["high", "low"],
              description:
                "\"high\" when the answer is clearly grounded in the resume, job description, or the candidate's own context files. \"low\" when you had to guess or extrapolate because nothing directly supports the answer - still give your best answer, just mark it low.",
            },
          },
          required: ["selector", "value", "values", "confidence"],
        },
      },
    },
    required: ["answers"],
  },
};

function buildContextBlocks(context: PersonalContext): string {
  return [
    context.qaContext && `Candidate's own guidance for common screening questions - use these verbatim or lightly adapted, never contradict them:\n${context.qaContext}`,
    context.workAuthContext && `Work authorization ground truth:\n${context.workAuthContext}`,
    Object.keys(context.profile).length > 0 && `Contact/location details:\n${Object.entries(context.profile).map(([k, v]) => `${k}: ${v}`).join("\n")}`,
  ].filter(Boolean).join("\n\n");
}

async function answerWithClaude(
  anthropic: Anthropic,
  resume: Resume,
  jobDescription: string,
  context: PersonalContext,
  fields: AnswerableField[],
  isRetry = false
): Promise<Map<string, ClaudeAnswer>> {
  if (fields.length === 0) return new Map();

  const fieldsBlock = fields
    .map(
      (f) =>
        `- selector: ${f.selector} | label: "${f.label}" | ${f.required ? "[REQUIRED]" : "[optional]"}${f.multiSelect ? " | [MULTI-SELECT] (use \"values\", a list of every matching option)" : ""}${f.isCombobox && f.options.length === 0 ? " | TYPE: combobox (return a short target phrase)" : ""}${f.options.length ? ` | options: [${f.options.join(", ")}]` : ""}`
    )
    .join("\n");

  const contextBlocks = buildContextBlocks(context);

  const retryHasMultiSelect = isRetry && fields.some((f) => f.multiSelect);
  const retryNotice = isRetry
    ? `IMPORTANT: you left these required fields unanswered on a previous attempt, which is not allowed. Every field below is [REQUIRED] and must receive a real, non-empty best-effort answer (in "value", or in "values" if marked [MULTI-SELECT]) - never leave it empty, no matter how uncertain. If you're not confident, still give your best guess and set confidence to "low" rather than leaving it blank.${
        retryHasMultiSelect
          ? ` At least one field below is marked [MULTI-SELECT] - for those, the "values" array specifically is what was left empty last time, and it must contain at least one entry now. Do not put anything in "value" for these; do not leave "values" as []. If you're unsure which of the listed options apply, pick the single most defensible one and put just that one in the array - a partial answer is far better than an empty one.`
          : ""
      }\n\n`
    : "";

  const message = await anthropic.messages.create({
    model: MODEL,
    max_tokens: 2048,
    tools: [ANSWER_TOOL],
    tool_choice: { type: "tool", name: "answer_fields" },
    messages: [
      {
        role: "user",
        content: `${retryNotice}Resume:\n${resume.text}\n\nJob description:\n${jobDescription.slice(0, 4000)}\n\n${contextBlocks}\n\nFill in these application form fields. Guidance:\n- Salary/compensation questions come in two shapes, answered differently:\n  - "Do you accept/agree to the salary or range listed in this posting?" (yes/no framing tied to a range already stated in the job description): answer "Yes" with HIGH confidence whenever the job description lists a salary or range. Submitting this application already implies the range has been seen and is acceptable - this is not a guess.\n  - "What is your desired/expected salary?" (asking the candidate to state a number): if the job description lists a range, say you're fine with that listed range (high confidence). If no range is listed, give your best-estimate typical range for this specific role and location based on your own knowledge, as "$X-$Y", and mark confidence "low" since it's an estimate. If you're not confident even estimating, default to "$65,000-$80,000 depending on scope and responsibilities" and mark confidence "low".\n- "Why are you interested in this role/company" or similar company-specific questions: write a grounded, specific 2-4 sentence answer using concrete details from the job description (including any "About [Company]" section) and the resume's relevant experience. Avoid generic, templated-sounding language - it should be clearly specific to this exact company and role, not something that could be pasted into any application.\n- Everything else: concise and truthful, based only on the resume and the context above.\n- Fields marked [REQUIRED] must always get a real, non-empty best-effort value - never decline by returning an empty string, even if you have to extrapolate. Set confidence to "low" whenever you had to extrapolate rather than answer from something concrete. Fields marked [optional] may get an empty string if you can't confidently answer at all.\n\n${fieldsBlock}`,
      },
    ],
  });

  const toolUse = message.content.find((b): b is Anthropic.ToolUseBlock => b.type === "tool_use");
  if (!toolUse) return new Map();
  const { answers } = toolUse.input as {
    answers: { selector: string; value: string; values?: string[]; confidence: "high" | "low" }[];
  };
  return new Map(answers.map((a) => [a.selector, { value: a.value, values: a.values ?? [], confidence: a.confidence }]));
}

const MULTI_SELECT_FALLBACK_TOOL: Anthropic.Tool = {
  name: "answer_fields_single_fallback",
  description: "Provide one single best-fit option for each of these select-all-that-apply fields, after a full multi-value answer wasn't given twice in a row.",
  input_schema: {
    type: "object",
    properties: {
      answers: {
        type: "array",
        items: {
          type: "object",
          properties: {
            selector: { type: "string" },
            value: {
              type: "string",
              description:
                "The single option, exactly matching one of the field's listed options, that best applies. This can never be an empty string - if several options could apply, pick the single most defensible one rather than refusing to choose.",
            },
            confidence: { type: "string", enum: ["high", "low"] },
          },
          required: ["selector", "value", "confidence"],
        },
      },
    },
    required: ["answers"],
  },
};

/**
 * A required [MULTI-SELECT] field asks for an array ("values"), a shape
 * every other field on the form doesn't use. In practice that's the one
 * field type that occasionally still comes back empty even after the
 * ordinary required-field retry in answerWithClaude() - a soft
 * prompt-compliance gap tied to the array shape itself, not the specific
 * question being asked. Rather than accept the gap, make one more attempt
 * with a deliberately simpler single-value schema (the same shape every
 * other field already answers reliably) and treat that one value as a
 * one-item "values" array - a partial answer beats an empty required field.
 */
async function answerMultiSelectFallback(
  anthropic: Anthropic,
  resume: Resume,
  jobDescription: string,
  context: PersonalContext,
  fields: AnswerableField[]
): Promise<Map<string, ClaudeAnswer>> {
  if (fields.length === 0) return new Map();

  const fieldsBlock = fields
    .map((f) => `- selector: ${f.selector} | label: "${f.label}"${f.options.length ? ` | options: [${f.options.join(", ")}]` : ""}`)
    .join("\n");

  const contextBlocks = buildContextBlocks(context);

  const message = await anthropic.messages.create({
    model: MODEL,
    max_tokens: 1024,
    tools: [MULTI_SELECT_FALLBACK_TOOL],
    tool_choice: { type: "tool", name: "answer_fields_single_fallback" },
    messages: [
      {
        role: "user",
        content: `These are required "select all that apply" fields on a job application. You were already asked twice for a full list of matching values and left them empty both times, which isn't allowed - the application can't be submitted with a required field blank. This time, just give the SINGLE most defensible option for each instead of a full list - a partial answer is far better than none, and every field below must get a real, non-empty value.\n\nResume:\n${resume.text}\n\nJob description:\n${jobDescription.slice(0, 4000)}\n\n${contextBlocks}\n\n${fieldsBlock}`,
      },
    ],
  });

  const toolUse = message.content.find((b): b is Anthropic.ToolUseBlock => b.type === "tool_use");
  if (!toolUse) return new Map();
  const { answers } = toolUse.input as { answers: { selector: string; value: string; confidence: "high" | "low" }[] };
  return new Map(
    answers.filter((a) => a.value).map((a) => [a.selector, { value: "", values: [a.value], confidence: a.confidence }])
  );
}

interface FilledTextRecord {
  selector: string;
  label: string;
  value: string;
  required: boolean;
  filledIndex: number;
}

/**
 * Fills a text-like field and re-reads the DOM afterward to confirm the
 * value actually stuck. Some ATS forms (e.g. React-Select-style comboboxes)
 * accept a typed value via .fill() but then discard it on their next
 * render, since the visible input is just a search box, not the value
 * store - so a naive "no exception thrown" check would misreport success.
 *
 * That confirmation only proves the value stuck at that instant, though -
 * on a heavy React form (Samsara's iframe-embedded widget especially),
 * something that happens later in the run (opening/closing several other
 * comboboxes, a form-wide re-render) can silently reset a plain text field
 * that was correctly filled and verified minutes earlier. filledSelectors
 * records every success here so fillApplication() can re-check them all
 * right before the screenshot and catch exactly that.
 */
async function fillTextVerified(
  ctx: FormContext,
  selector: string,
  label: string,
  value: string,
  filled: FillReport["filled"],
  skipped: FillReport["skipped"],
  required: boolean,
  generated = false,
  lowConfidence = false,
  filledSelectors?: FilledTextRecord[]
): Promise<boolean> {
  const ok = await ctx.fill(selector, value).then(() => true).catch(() => false);
  if (!ok) {
    skipped.push({ label, reason: `failed to fill field "${selector}"`, required });
    return false;
  }
  await delay(150);
  const persisted = await ctx.$eval(selector, (el) => (el as HTMLInputElement).value).catch(() => "");
  if (persisted !== value) {
    skipped.push({
      label,
      reason: `entered "${value}" but it did not persist (likely a custom dropdown - select it manually)`,
      required,
    });
    return false;
  }
  filled.push({ label, value, generated, lowConfidence: generated && lowConfidence });
  filledSelectors?.push({ selector, label, value, required, filledIndex: filled.length - 1 });
  return true;
}

export async function fillApplication(
  page: Page,
  anthropic: Anthropic,
  resume: Resume,
  resumeFilePath: string,
  jobDescription: string,
  outDir: string,
  context: PersonalContext
): Promise<FillReport> {
  const formCtx = await findFormContext(page);
  const fields = await discoverFields(formCtx);
  const filled: FillReport["filled"] = [];
  const skipped: FillReport["skipped"] = [];
  const toAnswer: AnswerableField[] = [];
  const profile = context.profile;
  const filledSelectors: FilledTextRecord[] = [];

  for (const field of fields) {
    const labelLower = field.label.toLowerCase();

    // Fills a known, deterministic (non-AI-generated) value regardless of
    // whether the field is a plain input or a custom combobox.
    const setField = async (value: string) => {
      if (field.isCombobox) {
        const picked = await selectComboboxOption(formCtx, field.selector, [value]);
        if (picked) filled.push({ label: field.label, value: picked });
        else skipped.push({ label: field.label, reason: `could not find a matching option for "${value}" in this dropdown`, required: field.required });
      } else {
        await fillTextVerified(formCtx, field.selector, field.label, value, filled, skipped, field.required, false, false, filledSelectors);
      }
    };

    if (field.type === "file") {
      // Different ATSs expose the resume upload differently: Greenhouse
      // gives it id="resume" but no real label; Lever labels it "Resume/CV"
      // but uses a generated id. Check both, and always exclude anything
      // that looks like a separate cover-letter slot.
      const hint = `${field.idOrName} ${field.label}`.toLowerCase();
      const isResumeField = /resume|\bcv\b/.test(hint) && !/cover/.test(hint);
      if (isResumeField) {
        const ok = await formCtx
          .setInputFiles(field.selector, resumeFilePath)
          .then(() => true)
          .catch(() => false);
        if (!ok) {
          skipped.push({ label: field.label || "Resume upload", reason: "failed to upload resume file - attach it manually", required: field.required });
        } else {
          // setInputFiles() only proves the browser accepted the file - it
          // doesn't prove the site's UI reflects it. Some widgets go the
          // opposite way of a typical text field: the instant a file is
          // selected, they swap the input out of the DOM entirely and
          // replace it with a "file selected" state, so the *original*
          // selector disappearing right after a successful setInputFiles()
          // is itself a positive signal, not a failure - only a still-present
          // input reporting zero files means the selection didn't register.
          const filesLength = await formCtx
            .$eval(field.selector, (el) => (el as HTMLInputElement).files?.length ?? 0)
            .catch(() => null);
          if (filesLength === 0) {
            skipped.push({ label: field.label || "Resume upload", reason: "failed to upload resume file - attach it manually", required: field.required });
          } else {
            await delay(3000);
            filled.push({ label: field.label || "Resume upload", value: path.basename(resumeFilePath) });
          }
        }
      } else {
        skipped.push({ label: field.label || "file upload", reason: "not the resume field; left empty", required: field.required });
      }
      continue;
    }

    if (field.type === "checkbox" && isStandardRecruitmentConsent(field.label)) {
      // Narrow-scope "I consent to you processing my data to consider my
      // application" checkboxes are required to submit and consistent
      // with the whole point of running this tool - auto-check them. Any
      // broader scope (marketing, third-party sharing, indefinite
      // retention) is excluded by isStandardRecruitmentConsent and falls
      // through to the manual-review branch below instead.
      const ok = await formCtx.check(field.selector).then(() => true).catch(() => false);
      if (ok) filled.push({ label: field.label, value: "Agreed" });
      else skipped.push({ label: field.label, reason: "standard recruitment-data consent - could not check it, please check manually", required: field.required });
      continue;
    }

    if (field.type === "checkbox" || field.type === "radio") {
      // Broader-scope consent/legal checkboxes are always left for the
      // user. Some EEOC questions are rendered as a radio group rather
      // than a dropdown - reliably identifying the specific "decline"
      // radio (vs. its sibling options) needs matching against each
      // radio's own associated label text, which isn't covered yet; still
      // left for manual review here rather than guessed at.
      skipped.push({ label: field.label || field.selector, reason: "checkbox/consent field left for user to decide", required: field.required });
      continue;
    }

    if ((field.tag === "SELECT" || field.isCombobox) && isStandardRecruitmentConsent(field.label)) {
      // Same standard-recruitment-consent rule as above, for sites that
      // render this as a dropdown ("Yes"/"I agree") rather than a literal
      // checkbox (e.g. Samsara's "Processing of Personal Data*").
      await answerDirectly(
        formCtx,
        field,
        CONSENT_AGREE_CANDIDATES,
        filled,
        skipped,
        "standard recruitment-data consent - could not find a matching option, please select manually",
        filledSelectors
      );
      continue;
    }

    if (SENSITIVE_RE.test(labelLower)) {
      // Voluntary EEOC/demographic questions: always select a neutral
      // "decline to answer" style option rather than guessing at or
      // leaving blank a protected-category question. Never persisted
      // anywhere beyond this run's in-memory report.
      if (field.tag === "SELECT") {
        const match = field.options.find((o) => DECLINE_RE.test(o));
        if (match) {
          const ok = await formCtx.selectOption(field.selector, { label: match }).then(() => true).catch(() => false);
          if (ok) filled.push({ label: field.label, value: match });
          else skipped.push({ label: field.label, reason: "voluntary demographic/EEO field - could not select decline option, left for you to complete", required: field.required });
        } else {
          skipped.push({ label: field.label, reason: "voluntary demographic/EEO field - no decline option found, left for you to complete", required: field.required });
        }
      } else if (field.isCombobox) {
        const picked = await selectComboboxOption(formCtx, field.selector, [DECLINE_RE]);
        if (picked) filled.push({ label: field.label, value: picked });
        else skipped.push({ label: field.label, reason: "voluntary demographic/EEO field - no decline option found, left for you to complete", required: field.required });
      } else {
        skipped.push({ label: field.label, reason: "voluntary demographic/EEO field, left for you to complete", required: field.required });
      }
      continue;
    }
    if (CONSENT_RE.test(labelLower)) {
      skipped.push({ label: field.label || field.selector, reason: "consent/legal field, left for you to complete", required: field.required });
      continue;
    }
    if (!field.label) {
      skipped.push({ label: field.selector, reason: "no discoverable label; left for manual review", required: field.required });
      continue;
    }

    if (HOW_HEARD_OPPORTUNITY_RE.test(labelLower)) {
      // "How did you hear about THIS OPPORTUNITY/role" - answered
      // differently from the more generic "how did you hear about
      // us/the company" below, per instruction.
      await answerDirectly(
        formCtx,
        field,
        HOW_HEARD_OPPORTUNITY_CANDIDATES,
        filled,
        skipped,
        "no matching option found for how-did-you-hear-about-this-opportunity source",
        filledSelectors
      );
      continue;
    }
    if (HOW_HEARD_RE.test(labelLower)) {
      // Hardcoded rather than routed through Claude: the instruction is to
      // answer honestly about how Seekr found the role, not to have an LLM
      // invent a personal discovery story.
      await answerDirectly(formCtx, field, HOW_HEARD_CANDIDATES, filled, skipped, "no matching option found for how-did-you-hear source", filledSelectors);
      continue;
    }
    if (AI_POLICY_RE.test(labelLower)) {
      await answerDirectly(formCtx, field, AI_POLICY_CANDIDATES, filled, skipped, "no matching option found for AI policy question", filledSelectors);
      continue;
    }

    if (labelLower === "first name") {
      const value = resume.name.split(/\s+/)[0] || "";
      if (value) {
        await setField(value);
        continue;
      }
    }
    if (labelLower === "last name") {
      const parts = resume.name.split(/\s+/);
      const value = parts.length > 1 ? parts[parts.length - 1] : "";
      if (value) {
        await setField(value);
        continue;
      }
    }
    if (labelLower === "email" && resume.email) {
      await setField(resume.email);
      continue;
    }
    if (labelLower === "phone" && (profile.phoneNumber || resume.phone)) {
      await setField(profile.phoneNumber || resume.phone);
      continue;
    }
    if (labelLower.includes("linkedin")) {
      const li = resume.text.match(/linkedin\.com\/in\/[\w-]+/i)?.[0];
      if (li) {
        await setField(`https://${li}`);
        continue;
      }
    }
    // Contact/location fields sourced from user_profile.txt, not the LLM.
    if ((labelLower === "address" || labelLower.includes("street address")) && profile.address) {
      await setField(profile.address);
      continue;
    }
    if (labelLower.includes("city") && profile.city) {
      // Bare city names are frequently ambiguous (there are multiple US
      // "Decatur"s, "Springfield"s, etc.) - a search-driven autocomplete
      // will happily return a same-named city in the wrong state, which is
      // worse than leaving it blank since it looks correct at a glance.
      // Try the disambiguated "City, State" search first; only fall back
      // to the bare city name (still ambiguous, but better than nothing)
      // if that doesn't match anything.
      if (field.isCombobox && profile.state) {
        const specific = `${profile.city}, ${profile.state}`;
        const picked = await selectComboboxOption(formCtx, field.selector, [specific, profile.city]);
        if (picked) filled.push({ label: field.label, value: picked });
        else skipped.push({ label: field.label, reason: `could not find a matching option for "${specific}" in this dropdown`, required: field.required });
      } else {
        await setField(profile.city);
      }
      continue;
    }
    if ((labelLower === "state" || labelLower.includes("state/province") || labelLower.includes("state or province")) && profile.state) {
      await setField(profile.state);
      continue;
    }
    if ((labelLower.includes("zip") || labelLower.includes("postal")) && profile.zip) {
      await setField(profile.zip);
      continue;
    }
    if (labelLower === "country" && profile.country) {
      await setField(profile.country);
      continue;
    }
    if (labelLower.includes("phone country code") && profile.phoneCountryCode) {
      await setField(profile.phoneCountryCode);
      continue;
    }

    // Everything else (custom written questions, salary, relocation,
    // work-auth/sponsorship, etc.) goes to Claude, including comboboxes -
    // those are no longer unconditionally skipped now that there's real
    // grounding to answer them from.
    if (field.tag === "SELECT" || field.tag === "INPUT" || field.tag === "TEXTAREA") {
      // Give Claude the real, exact options for a combobox rather than
      // having it guess a plausible-sounding value blind - a guess like
      // "1-2 years" against real buckets of "0-1 years"/"2-3 years"/"+4
      // years" will never match no matter how forgiving the string
      // comparison is, because it doesn't correspond to anything real.
      let options = field.options;
      let multiSelect = field.multiSelect;
      if (field.isCombobox && options.length === 0) {
        const harvested = await harvestComboboxOptions(formCtx, field.selector);
        options = harvested.options;
        multiSelect = harvested.multiSelect;
      }
      toAnswer.push({ selector: field.selector, label: field.label, tag: field.tag, options, isCombobox: field.isCombobox, required: field.required, multiSelect });
    }
  }

  if (toAnswer.length > 0) {
    const answers = await answerWithClaude(anthropic, resume, jobDescription, context, toAnswer);
    const hasAnswer = (f: AnswerableField, a: ClaudeAnswer | undefined) =>
      !!a && (f.multiSelect ? a.values.length > 0 : !!a.value);

    // The prompt tells Claude required fields must never come back empty,
    // but that's an instruction, not an enforced constraint - it doesn't
    // always comply. Give it one more, firmer-worded shot at just the
    // required fields it left blank before accepting the gap.
    const stillEmptyRequired = toAnswer.filter((f) => f.required && !hasAnswer(f, answers.get(f.selector)));
    let retried = false;
    if (stillEmptyRequired.length > 0) {
      const retryAnswers = await answerWithClaude(anthropic, resume, jobDescription, context, stillEmptyRequired, true);
      for (const [selector, answer] of retryAnswers) {
        const field = stillEmptyRequired.find((f) => f.selector === selector);
        if (field && hasAnswer(field, answer)) answers.set(selector, answer);
      }
      retried = true;
    }

    // The array-shaped "values" answer is the one shape that still
    // occasionally comes back empty even after the ordinary retry above.
    // Give required multi-select fields one further attempt through a
    // simpler single-value schema before accepting the gap.
    const stillEmptyMultiSelect = stillEmptyRequired.filter((f) => f.multiSelect && !hasAnswer(f, answers.get(f.selector)));
    let multiSelectFallbackAttempted = false;
    if (stillEmptyMultiSelect.length > 0) {
      const fallbackAnswers = await answerMultiSelectFallback(anthropic, resume, jobDescription, context, stillEmptyMultiSelect);
      for (const [selector, answer] of fallbackAnswers) {
        // A fallback answer is inherently a narrowed, best-effort pick from
        // a "select all that apply" field down to just one option - always
        // worth flagging for review regardless of Claude's own confidence.
        answers.set(selector, { ...answer, confidence: "low" });
      }
      multiSelectFallbackAttempted = true;
    }

    for (const field of toAnswer) {
      const answer = answers.get(field.selector);
      const required = field.required;
      if (!hasAnswer(field, answer)) {
        // For required fields that made it through a retry (and, for
        // multi-select, a further single-value fallback) and are still
        // empty, this is a genuine anomaly worth calling out differently
        // from an ordinary "couldn't answer" skip.
        const wentThroughFallback = multiSelectFallbackAttempted && stillEmptyMultiSelect.some((f) => f.selector === field.selector);
        const reason =
          required && wentThroughFallback
            ? "Claude could not produce an answer even after a retry and a simplified single-value fallback - please answer manually"
            : required && retried && stillEmptyRequired.some((f) => f.selector === field.selector)
            ? "Claude could not produce an answer even after a retry - please answer manually"
            : "Claude could not confidently answer from the resume/context";
        skipped.push({ label: field.label, reason, required });
        continue;
      }
      const { value, values, confidence } = answer!;
      const lowConfidence = confidence === "low";

      if (field.multiSelect) {
        if (field.isCombobox) {
          const picked = await selectMultipleComboboxOptions(formCtx, field.selector, values);
          if (picked.length > 0) filled.push({ label: field.label, value: picked.join(", "), generated: true, lowConfidence });
          else skipped.push({ label: field.label, reason: `could not find matching options for [${values.join(", ")}] in this dropdown`, required });
        } else if (field.tag === "SELECT") {
          const ok = await formCtx
            .selectOption(field.selector, values.map((v) => ({ label: v })))
            .then(() => true)
            .catch(() => false);
          if (ok) filled.push({ label: field.label, value: values.join(", "), generated: true, lowConfidence });
          else skipped.push({ label: field.label, reason: `could not select options [${values.join(", ")}]`, required });
        }
        continue;
      }

      if (field.isCombobox) {
        const picked = await selectComboboxOption(formCtx, field.selector, [value]);
        if (picked) filled.push({ label: field.label, value: picked, generated: true, lowConfidence });
        else skipped.push({ label: field.label, reason: `could not find a matching option for "${value}" in this dropdown`, required });
        continue;
      }
      if (field.tag === "SELECT") {
        const ok = await formCtx
          .selectOption(field.selector, { label: value })
          .then(() => true)
          .catch(() => false);
        if (!ok) {
          skipped.push({ label: field.label, reason: `could not select option "${value}"`, required });
          continue;
        }
        filled.push({ label: field.label, value, generated: true, lowConfidence });
      } else {
        await fillTextVerified(formCtx, field.selector, field.label, value, filled, skipped, required, true, lowConfidence, filledSelectors);
      }
    }
  }

  const finalFilled = await reverifyFilledTextFields(formCtx, filledSelectors, filled, skipped);

  const screenshotPath = path.join(outDir, "application-preview.png");
  await page.screenshot({ path: screenshotPath, fullPage: true });

  return { filled: finalFilled, skipped, screenshotPath };
}

/**
 * fillTextVerified() only confirms a value stuck at the instant it was set
 * - not that it survives the rest of the run. On a heavy React form
 * (Samsara's iframe-embedded widget especially), something that happens
 * later - opening/closing several other comboboxes, a form-wide
 * re-render - can silently reset a plain text field that was correctly
 * filled and verified minutes earlier, so the field can look empty by the
 * time a human actually looks at the page even though the report says
 * "filled." Re-check every tracked text field right before the
 * screenshot, try one repair fill if it no longer matches, and be honest
 * in the final report - downgrade to skipped rather than silently
 * over-claiming a field is still filled in.
 */
async function reverifyFilledTextFields(
  ctx: FormContext,
  filledSelectors: FilledTextRecord[],
  filled: FillReport["filled"],
  skipped: FillReport["skipped"]
): Promise<FillReport["filled"]> {
  const toRemove = new Set<number>();
  for (const rec of filledSelectors) {
    const current = await ctx.$eval(rec.selector, (el) => (el as HTMLInputElement).value).catch(() => undefined);
    if (current === rec.value) continue;

    const refilled = await ctx.fill(rec.selector, rec.value).then(() => true).catch(() => false);
    const persisted =
      refilled && (await ctx.$eval(rec.selector, (el) => (el as HTMLInputElement).value).catch(() => "")) === rec.value;
    if (persisted) continue;

    toRemove.add(rec.filledIndex);
    skipped.push({
      label: rec.label,
      reason: `was filled successfully earlier in the run but got reset before the screenshot (likely a later page interaction elsewhere) - please re-enter "${rec.value}" manually`,
      required: rec.required,
    });
  }
  return toRemove.size > 0 ? filled.filter((_, i) => !toRemove.has(i)) : filled;
}
