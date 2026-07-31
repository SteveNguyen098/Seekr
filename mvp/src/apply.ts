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
  // Usually INPUT/TEXTAREA/SELECT, but custom combobox widgets aren't
  // always built on a real <input> - some (confirmed live on Rippling's
  // ATS) render the clickable trigger as a bare <div role="combobox">,
  // so this has to accept whatever tag the trigger actually is.
  tag: string;
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
  /** The raw `name` attribute - only meaningful for type === "radio",
   * where it's the real native grouping mechanism (every option in one
   * logical question shares the same name). Used to group
   * individually-discovered radio options back into one question. */
  groupName: string;
  /** The *shared* question text for this radio's group (e.g. "Gender"),
   * as opposed to `label`, which for a radio is this one option's own
   * text (e.g. "Male"). Only meaningful for type === "radio". */
  groupQuestion: string;
  /**
   * True when this control should never be filled: an anti-bot honeypot, or
   * a widget that isn't part of the application form at all. Set from the
   * *static* signals only (see discoverFields) - the position-dependent
   * reachability check is deliberately deferred to fill time, since it's
   * the only one a re-render or page transition can invalidate.
   */
  skipAlways: boolean;
  /** Human-readable reason for skipAlways, surfaced in the report. */
  skipReason: string;
  /**
   * True when aria-labelledby resolves to a *visible* element. Marks a
   * legitimately-hidden control (a real input styled behind a visible
   * clickable partner - the pattern checkField() handles). Exempts the
   * field from the fill-time reachability check, which such controls
   * always fail by design.
   */
  hasVisibleLabelPartner: boolean;
}

export interface FillReport {
  filled: { label: string; value: string; generated?: boolean; lowConfidence?: boolean }[];
  skipped: { label: string; reason: string; required?: boolean }[];
  /** First page's screenshot; kept for callers that expect a single path. */
  screenshotPath: string;
  /** One screenshot per page of a multi-page flow. */
  screenshots?: string[];
  /** Flow-level messages: cookie choice, why the run stopped, hard stops. */
  notes?: string[];
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
// needs "wish"/"want"/"consent"/"agree" (the last two cover phrasing like
// "I do not consent to disclose this information", and double as the
// decline option for opt-in-style questions like SMS consent below), each
// in "don't/doesn't/do not/does not" form.
const DECLINE_RE =
  /decline|prefer not|choose not|(does\s*not|doesn't|don't|do\s*not)\s*(wish|want|consent|agree)|not disclosed|n\/a\b/i;
// Matches the radio/checkbox OPTION that opts out of receiving text
// messages/SMS - paired with DECLINE_RE below so the same "no thanks"
// phrasing detection doubles for both EEOC decline options and this.
const TEXT_MESSAGE_RE = /text messag|\bsms\b/i;
// "Where do you plan on working from (for payroll tax purposes)?" and
// similar work-location / payroll-jurisdiction questions ask for the same
// answer as a plain "City"/"Current Location" field - the candidate's own
// location - just phrased around where they'll physically work rather than
// where they currently live. Confirmed live on Ramp's Ashby form: this is
// the same city/state/country autocomplete widget, and without this the
// field fell through to Claude, which guessed "Remote (US)" (not a real
// geographic option) instead of the profile's actual city. The "where"
// arm is bounded to the same clause (stops at a "?") and requires a
// work/live/reside/located/based word so it can't swallow unrelated
// "where did you hear about us"-style questions; the payroll arm requires
// a location/tax word nearby so it can't match a stray "payroll" mention.
const WORK_LOCATION_RE =
  /\bwhere\b[^?]*\b(work|working|located|based|reside|live|living)\b|\bwork location\b|\bpayroll\s+(tax|location|state|jurisdiction|purpose)/i;
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
export function isStandardRecruitmentConsent(label: string): boolean {
  if (CONSENT_BROADER_SCOPE_RE.test(label)) return false;
  // "Privacy Notice Acknowledgement" style fields are inherently the same
  // category (a required data-processing acknowledgement) even without
  // mentioning "personal data" or "recruitment" by name - short-circuit
  // past the stricter check below, which they'd otherwise fail.
  if (/privacy notice.*acknowledg|acknowledg.*privacy notice/i.test(label)) return true;
  // "I acknowledge the Privacy Policy and, as applicable, California Notice"
  // - a real, required Oracle HCM Cloud checkbox that gates the first page
  // of the application. The narrower pattern above only covered "privacy
  // NOTICE" and only in acknowledgement-noun form, so this label fell all
  // the way through to the generic "left for the user" checkbox bucket and
  // was never ticked. Two independent tests rather than one long regex, so
  // it also covers "I agree to the Privacy Policy" / "Accept the Data
  // Protection Statement" phrasings. Still gated by the broader-scope
  // exclusion at the top of this function, so a label that also drags in
  // marketing or third-party sharing is still (correctly) left alone.
  if (
    /\b(acknowledge|acknowledged|acknowledgement|acknowledgment|agree|accept)\b/i.test(label) &&
    /\b(privacy|data protection|gdpr)\s+(policy|notice|statement)\b/i.test(label)
  ) {
    return true;
  }
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
  // Pick the first *visible* Apply control, not merely the first match.
  // page.$() returns whatever comes first in the DOM regardless of
  // visibility, and career sites routinely carry hidden duplicates (a
  // collapsed mobile menu, an off-screen nav, a footer link). Clicking one
  // of those blocks until Playwright's 30s actionability timeout and then
  // throws - which previously propagated all the way out and killed the
  // entire run before a single field was touched.
  //
  // The click is also best-effort now: plenty of pages put the form on the
  // job page itself, so failing to find or click an Apply button is not
  // grounds for aborting. Field discovery below is the real test of whether
  // we got somewhere useful.
  const applyCandidates = await page.$$("a:has-text('Apply'), button:has-text('Apply'), [role=button]:has-text('Apply')");
  for (const candidate of applyCandidates) {
    const usable = await candidate.isVisible().then((v) => v && candidate.isEnabled()).catch(() => false);
    if (!usable) continue;
    const clicked = await candidate.click({ timeout: 5000 }).then(() => true).catch(() => false);
    if (clicked) break;
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
  // input/textarea/select covers the vast majority of real form controls
  // (Greenhouse, Lever). [role="combobox"] catches custom widgets that
  // aren't built on a real <input> at all - confirmed live on Rippling's
  // ATS, where gender/veteran/disability/hispanic-latino all render as a
  // bare <div role="combobox">, invisible to the narrower query alone.
  return ctx.$$eval("input, textarea, select, [role='combobox']", (els) =>
    els
      .map((el, i) => {
        const tag = el.tagName;
        const type = (el as HTMLInputElement).type || tag.toLowerCase();
        if (["hidden", "submit", "button"].includes(type)) return null;

        // Precedence follows real ARIA semantics: aria-labelledby (points
        // at another element that holds the actual question text) outranks
        // aria-label, which outranks an associated <label>, which outranks
        // placeholder text (the weakest signal - often just example input,
        // not a real label). Confirmed live: Rippling's custom widgets
        // expose only a generic "Search"/"Select..." aria-label/placeholder
        // directly on the control, while the real question ("Please
        // identify your race", "Pronouns") only exists on the element
        // aria-labelledby points to - skipping this resolution was why
        // those fields were previously invisible to the sensitive-field
        // safety net and got answered instead of declined.
        let label = "";
        const labelledbyId = el.getAttribute("aria-labelledby");
        if (labelledbyId) {
          label = labelledbyId
            .split(/\s+/)
            .map((id) => document.getElementById(id)?.textContent?.trim() || "")
            .filter(Boolean)
            .join(" ");
        }
        if (!label) label = el.getAttribute("aria-label") || "";
        if (!label && el.id) {
          const labelEl = document.querySelector(`label[for="${el.id}"]`);
          label = labelEl?.textContent?.trim() || "";
        }
        if (!label) {
          const closestLabel = el.closest("label");
          label = closestLabel?.textContent?.trim() || "";
        }
        if (!label) label = el.getAttribute("placeholder") || "";
        // A generic instruction word ("Select", "Select...", "Search",
        // "Choose", "Start typing", "Type here") isn't a real label - it's
        // UI chrome that happens to be set as the aria-label/placeholder,
        // not the actual question. Confirmed live and load-bearing: two
        // Rippling fields both had aria-label="Select" directly on the
        // control (no aria-labelledby at all), so without this check the
        // cascade above stopped right there, thinking it had found a real
        // label - Claude then saw two *identical*, contentless "Select"
        // fields with nothing to tell them apart ("do you live in an
        // accepted state" vs. "do you need visa sponsorship") and answered
        // one of them wrong. Treating this as empty lets the DOM-proximity
        // fallback below run instead, which found the real question text
        // for both. "Start typing"/"Type here" is the same failure mode
        // confirmed live on Ashby: "Current Location"'s <label for="X">
        // points at an `X` the real <input> doesn't actually have as its
        // `id` (broken/non-standard native association - the label and
        // input are just siblings in the same wrapper, not connected via
        // `for`/`id` at all), so every signal ahead of placeholder came up
        // empty and the cascade settled for "Start typing..." - a
        // non-empty but useless string that (unlike a fully empty label)
        // never even reached the proximity fallback that would have found
        // the real "Current Location" text sitting right there as a
        // sibling. Without this fix Claude had to guess the field's
        // purpose from context alone, and picked the wrong city ("Atlanta"
        // instead of the real "Decatur") despite a real, unambiguous
        // profile-driven answer being available - it just never got
        // routed to it.
        if (/^(select|search|choose|start typing|type here)\.{0,3}$/i.test(label.trim())) label = "";
        if (!label) {
          // Last resort: some fields (confirmed live on Rippling's ATS -
          // both per-job "custom questions" like salary requirements, and
          // "standard" fields like state-residency/sponsorship) have their
          // question text sitting in a plain sibling element with zero
          // programmatic connection to the control at all - no
          // aria-labelledby, no aria-label, no label[for], no wrapping
          // <label>, not even a placeholder. The only remaining signal is
          // DOM proximity: walk up from the control and take the first
          // preceding sibling with substantial text. How far up varies by
          // field - confirmed live that the state-residency question's
          // wrapper nests 6 levels deep before a previousElementSibling
          // with real text appears, so this goes deeper than it might seem
          // to need to. Weakest signal of all (position, not semantics),
          // which is exactly why it's checked dead last.
          let node: Element | null = el;
          for (let i = 0; i < 8 && node && !label; i++) {
            const text = node.previousElementSibling?.textContent?.trim() || "";
            if (text.length > 2 && text.length < 300) label = text;
            node = node.parentElement;
          }
        }

        // Primary signal: the real HTML/ARIA required attribute. Fallback 1:
        // a visible asterisk in the label's actual textContent, for forms
        // that mark a field required only visually without the
        // programmatic attribute to match. Fallback 2: an asterisk that
        // isn't in textContent at all, only ever painted via CSS
        // (`label::after { content: "*" }`) - confirmed live on Ashby that
        // "Current Location*" is marked required exactly this way (a real,
        // genuinely-blocking-to-submit field), with nothing for the
        // textContent-based fallback above to find, so it was being
        // reported as optional. getComputedStyle's pseudo-element content
        // is a standards-based, portable check - not tied to any one
        // site's class names - against both places a real associated
        // <label> element is ever found (label[for], or a wrapping
        // <label>), independent of whichever cascade step above actually
        // supplied the label text.
        const requiredAttr = el.hasAttribute("required") || el.getAttribute("aria-required") === "true";
        let cssRequiredAsterisk = false;
        const labelForCheck = el.id ? document.querySelector(`label[for="${el.id}"]`) : null;
        const wrappingLabelForCheck = el.closest("label");
        for (const candidateLabelEl of [labelForCheck, wrappingLabelForCheck]) {
          if (!candidateLabelEl) continue;
          const before = getComputedStyle(candidateLabelEl, "::before").content;
          const after = getComputedStyle(candidateLabelEl, "::after").content;
          if (before.includes("*") || after.includes("*")) {
            cssRequiredAsterisk = true;
            break;
          }
        }
        const required = requiredAttr || /\*/.test(label) || cssRequiredAsterisk;
        let options: string[] =
          tag === "SELECT"
            ? Array.from((el as HTMLSelectElement).options).map((o) => o.textContent?.trim() || "")
            : [];
        if ((type === "checkbox" || type === "radio") && options.length === 0) {
          // Some ATS widgets (confirmed live on Ashby, for "Are you
          // authorized to work..."/sponsorship-style questions) render a
          // Yes/No question as two plain <button> elements carrying the
          // real option text and the actual click surface, with a native
          // checkbox/radio input alongside them (often tabindex="-1")
          // present purely for the site's own internal form state - the
          // buttons, not the input, are what a real user clicks. Without
          // this, these questions were indistinguishable from an ordinary
          // checkbox and fell into the same "always skip" bucket as
          // genuinely sensitive EEOC fields, even though they're routine
          // and answerable. Scoped to a *direct* child button (not any
          // descendant) and a small option count, so this doesn't
          // accidentally vacuum up unrelated buttons (e.g. a "learn more"
          // link) sitting near an ordinary checkbox.
          const siblingButtons = Array.from(el.parentElement?.querySelectorAll(":scope > button") || [])
            .map((b) => b.textContent?.trim() || "")
            .filter((t) => t.length > 0 && t.length <= 40);
          if (siblingButtons.length >= 2 && siblingButtons.length <= 6) options = siblingButtons;
        }
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

        // data-testid is a common automation-hook convention (confirmed
        // live: Rippling's file-upload widgets have empty id/name/
        // aria-label but data-testid="input-resume"/"input-cover_letter" -
        // without this the resume upload had nothing to match against at
        // all and silently never fired).
        const idOrName = `${el.id} ${el.getAttribute("name") || ""} ${el.getAttribute("data-testid") || ""}`.trim();

        // --- Anti-bot / not-part-of-the-form detection (static signals) ---
        //
        // Rule order below is load-bearing and was derived from live
        // measurement across two ATS platforms, not from reasoning:
        //
        //   field                     aria-hidden  labelledby->visible  rect     correct
        //   Oracle honeypot           true         -                    199x38   SKIP
        //   Oracle privacy checkbox   -            yes                  0x0      TICK
        //   Rippling SMS radios       -            yes                  0x0      CLICK
        //   Oracle email input        -            -                    620x38   FILL
        //
        // aria-hidden is the one signal that separates the trap from the two
        // legitimate hidden controls; every geometry/style check reports the
        // honeypot as perfectly visible (it hides via a height:0,
        // overflow:hidden *ancestor*, so its own box is a normal 199x38).
        //
        // ASSUMPTION (not engineered against): a honeypot won't carry an
        // aria-labelledby pointing at a visible label. True of the one real
        // trap measured here - a trap doing that would defeat the exemption
        // below and get filled. Revisit if one ever turns up.
        const ariaHiddenAttr = el.getAttribute("aria-hidden") === "true";
        const honeypotNamed = /honey-?pot/i.test(
          `${el.id} ${el.getAttribute("name") || ""} ${el.getAttribute("aria-label") || ""}`
        );
        // Some job pages mount an unrelated AI-assistant widget (Oracle
        // Digital Assistant ships one in a background dialog) whose textarea
        // is otherwise discovered as a *required* field of the application.
        // Scoped to the component/namespace rather than its copy - measured
        // live: the control is <oj-text-area id="oda-work-summary-text-area">
        // inside an oj-dialog, so the "oda-" product prefix is the stable
        // handle. The visible instruction text ("This summary is generated
        // by AI Assist...") will drift; the component prefix won't.
        const inAiWidget = !!el.closest(
          'ai-assistant-container, ai-assistant-skip-navigation-link, [id^="oda-"], [class*="oda-dialog"]'
        );

        let hasVisibleLabelPartner = false;
        const labelledbyRef = el.getAttribute("aria-labelledby");
        if (labelledbyRef) {
          const target = document.getElementById(labelledbyRef.split(/\s+/)[0]);
          if (target) {
            const tr = target.getBoundingClientRect();
            hasVisibleLabelPartner = tr.width > 0 && tr.height > 0;
          }
        }

        let skipAlways = false;
        let skipReason = "";
        if (ariaHiddenAttr || honeypotNamed) {
          skipAlways = true;
          skipReason = "hidden anti-bot (honeypot) field - deliberately left empty";
        } else if (inAiWidget) {
          skipAlways = true;
          skipReason = "part of the page's AI-assistant widget, not the application form";
        }

        const groupName = type === "radio" ? el.getAttribute("name") || "" : "";
        let groupQuestion = "";
        if (type === "radio") {
          // The group's shared question ("Gender") lives in a <label>
          // that's a *direct* child of the group's <fieldset> - confirmed
          // live on Ashby, where every EEOC radio group (Gender, Race,
          // Veteran Status) follows this exact shape, e.g. <fieldset>
          // <label>Gender</label> <input type="radio">... </fieldset>.
          // This is a real associated label, unlike each individual
          // option's own label ("Male") captured above as `label`.
          const fieldset = el.closest("fieldset");
          const directLabel = fieldset?.querySelector(":scope > label");
          groupQuestion = directLabel?.textContent?.trim() || "";
          if (!groupQuestion) {
            // Fall back to the same DOM-proximity approach used for
            // ordinary unlabeled fields above, walking up from the
            // fieldset (or this radio, if it isn't even inside one)
            // rather than from the individual option - looking for the
            // group's shared question, not this one option's own text.
            let node: Element | null = fieldset || el;
            for (let i = 0; i < 8 && node && !groupQuestion; i++) {
              const text = node.previousElementSibling?.textContent?.trim() || "";
              if (text.length > 2 && text.length < 300) groupQuestion = text;
              node = node.parentElement;
            }
          }
        }

        return { selector, tag, type, label: label.trim(), required, options, isCombobox, idOrName, multiSelect, groupName, groupQuestion, skipAlways, skipReason, hasVisibleLabelPartner };
      })
      .filter((f): f is NonNullable<typeof f> => f !== null && f.type !== "search")
  );
}

/**
 * Fill-time check: could a real user's click actually land on this control?
 *
 * Deliberately evaluated here rather than during discovery - it's the only
 * position-dependent signal, so a re-render, an opened dropdown, or a page
 * transition can invalidate a discovery-time verdict.
 *
 * Returns "blocked" ONLY when there's a definite negative answer. Anything
 * ambiguous returns "inconclusive", and callers must not skip on that: the
 * failure mode we care about is real fields silently vanishing from the
 * fill, which is invisible in a report. A trap slipping past here is the
 * milder failure, since the static aria-hidden/honeypot-name rules catch
 * the traps actually seen in the wild.
 *
 * Two cases are treated as inconclusive on purpose, and are reported
 * separately because they carry different risk:
 *  - "zero-size": a 0x0 box, whose "center" is a meaningless coordinate.
 *    This is the shape of every legitimately-hidden-but-real control
 *    measured so far - but it's also the shape a novel honeypot would take
 *    on a site using neither aria-hidden nor an obvious name, so the caller
 *    surfaces it as a flow note rather than filling it silently.
 *  - "offscreen": still out of view after we tried to scroll it into view
 *    (e.g. inside a collapsed accordion) - it gets attempted, and an honest
 *    fill failure is reported if it truly can't be reached.
 */
type Reachability = "reachable" | "blocked" | "inconclusive-zero-size" | "inconclusive-offscreen";

async function reachability(ctx: FormContext, selector: string): Promise<Reachability> {
  return ctx
    .$eval(selector, (el) => {
      const scrollX0 = window.scrollX;
      const scrollY0 = window.scrollY;
      // "instant" matters: under CSS scroll-behavior:smooth the scroll would
      // be async and the hit-test below would read a stale position.
      el.scrollIntoView({ block: "center", inline: "center", behavior: "instant" as ScrollBehavior });
      const r = el.getBoundingClientRect();
      const verdict = (() => {
        if (r.width <= 0 || r.height <= 0) return "inconclusive-zero-size";
        const cx = r.left + r.width / 2;
        const cy = r.top + r.height / 2;
        if (cx < 0 || cy < 0 || cx > window.innerWidth || cy > window.innerHeight) return "inconclusive-offscreen";
        const hit = document.elementFromPoint(cx, cy);
        if (!hit) return "inconclusive-offscreen";
        // MUST be self-or-descendant, never ancestor. This single predicate
        // is the difference between a working guard and one that silently
        // passes the trap: the measured honeypot's topmost element at its
        // own center is its *ancestor* (it's clipped inside a height:0
        // overflow:hidden wrapper), so accepting an ancestor match reports
        // the trap as perfectly reachable.
        return hit === el || el.contains(hit) ? "reachable" : "blocked";
      })();
      window.scrollTo(scrollX0, scrollY0);
      return verdict;
    })
    .catch(() => "inconclusive-offscreen" as const) as Promise<Reachability>;
}

/**
 * Checks a checkbox/radio, tolerating a common accessible-widget pattern:
 * the real native input is visually hidden (opacity/position tricks) behind
 * a custom-styled replacement, with aria-labelledby pointing at the visible
 * text that's the *actual* clickable surface. Playwright's own .check()
 * correctly refuses to act on an invisible element - confirmed live on a
 * Rippling-hosted form, where every radio/checkbox is built this way and a
 * plain .check() times out. Falls back to clicking whatever aria-labelledby
 * resolves to, which is what a real user would actually click.
 */
export async function checkField(ctx: FormContext, selector: string): Promise<boolean> {
  // Every strategy below is judged by re-reading .checked, never by "the
  // click didn't throw". The previous version returned true whenever the
  // aria-labelledby click resolved, which on a real Oracle HCM consent
  // checkbox reported success while the box stayed unchecked - a false
  // positive in the report AND a silently blocked form, since that box
  // gates the first page. Same failure class as the file-upload and
  // text-fill false positives fixed earlier in this file: proving an action
  // was *dispatched* is not proving it *landed*.
  const isChecked = () =>
    ctx.$eval(selector, (el) => !!(el as HTMLInputElement).checked).catch(() => false);

  if (await isChecked()) return true;

  // 1. The honest path: a real, visible, actionable control.
  await ctx.check(selector, { timeout: 2500 }).catch(() => {});
  if (await isChecked()) return true;

  // 2. Focus the control and fire a native click on the input itself.
  //    Promoted to run this early because it is both the most targeted and
  //    the safest option: it cannot hit anything except the control being
  //    toggled. Measured necessary on Oracle HCM Cloud (Oracle JET), where
  //    clicking the styled span covering the input, or its wrapping label,
  //    does nothing at all - the component only reacts to events on the
  //    input. Still a real DOM click through the element's own event path
  //    (equivalent to the keyboard Space a real user presses, verified to
  //    behave identically), not an assignment to .checked, so the
  //    framework's handlers run and its model stays in sync.
  await ctx
    .$eval(selector, (el) => {
      (el as HTMLElement).focus();
      (el as HTMLElement).click();
    })
    .catch(() => {});
  if (await isChecked()) return true;

  // 3. Click whatever is actually painted on top of the input - for a
  //    visually-hidden input behind a custom-styled replacement, that's
  //    the surface a real user clicks.
  const marked = await ctx
    .$eval(selector, (el) => {
      el.scrollIntoView({ block: "center", inline: "center", behavior: "instant" as ScrollBehavior });
      const r = el.getBoundingClientRect();
      const hit = document.elementFromPoint(r.left + r.width / 2, r.top + r.height / 2);
      if (!hit || hit === el || hit.tagName === "HTML" || hit.tagName === "BODY") return false;
      hit.setAttribute("data-seekr-check-target", "1");
      return true;
    })
    .catch(() => false);
  if (marked) {
    await ctx.click('[data-seekr-check-target="1"]', { timeout: 2500 }).catch(() => {});
    await ctx
      .$$eval('[data-seekr-check-target="1"]', (els) => els.forEach((e) => e.removeAttribute("data-seekr-check-target")))
      .catch(() => {});
    if (await isChecked()) return true;
  }

  // 4. The aria-labelledby target - right for widgets whose visible label
  //    genuinely is the toggle (a live Rippling form's SMS radios work
  //    this way). Deliberately LAST among the real-click strategies, and
  //    skipped entirely when that label contains a hyperlink.
  //
  //    This is not hypothetical caution: a consent label reading "I
  //    acknowledge the Privacy Policy and, as applicable, California
  //    Notice" carries both of those as <a> links. Clicking the label
  //    landed on one and opened a full-screen Terms and Conditions modal,
  //    which then covered the form's Next button - so the checkbox ticked
  //    but the whole flow stalled on page 1 with no obvious cause. A
  //    strategy that can navigate away or open a dialog has to be the
  //    option of last resort, not the first thing tried.
  const labelledbyId = await ctx.$eval(selector, (el) => el.getAttribute("aria-labelledby")).catch(() => null);
  if (labelledbyId) {
    const targetSel = `[id="${labelledbyId.split(/\s+/)[0]}"]`;
    const hasLink = await ctx
      .$eval(targetSel, (el) => !!el.querySelector("a[href]") || el.tagName === "A")
      .catch(() => true); // unreadable target -> assume unsafe
    if (!hasLink) {
      await ctx.click(targetSel, { timeout: 2500 }).catch(() => {});
      if (await isChecked()) return true;
    }
  }

  // 5. Last resort: bypass the actionability wait. Still verified, so a
  //    forced click that doesn't actually toggle is reported as a failure
  //    rather than a success.
  await ctx.check(selector, { timeout: 2000, force: true }).catch(() => {});
  return isChecked();
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
 * Clicks whichever sibling <button> matches one of the given candidates -
 * the counterpart to a checkbox/radio field whose `options` were populated
 * from sibling button text in discoverFields() (confirmed live on Ashby's
 * Yes/No-style questions, where the buttons - not the underlying hidden
 * input - are the real click surface). Returns the clicked button's own
 * text if a match was found and clicked, or null otherwise.
 */
async function clickChoiceButton(ctx: FormContext, inputSelector: string, candidates: (string | RegExp)[]): Promise<string | null> {
  const input = await ctx.$(inputSelector);
  if (!input) return null;
  const parentHandle = await input.evaluateHandle((el) => el.parentElement);
  const parent = parentHandle.asElement();
  if (!parent) return null;
  const buttons = await parent.$$("button");
  for (const candidate of candidates) {
    for (const btn of buttons) {
      const text = (await btn.textContent().catch(() => ""))?.trim() ?? "";
      if (text && optionTextMatches(text, candidate)) {
        await btn.click();
        return text;
      }
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
  // Only meaningful for distinguishing a checkbox/radio-backed
  // choice-buttons field (see clickChoiceButton) from a real <input> text
  // field - both share tag === "INPUT", so tag alone can't tell them apart.
  type: string;
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

// Matches an open-ended "what's your desired/expected salary" style
// question specifically - not the separate yes/no "do you accept the
// listed range" shape, which already has a confident answer without
// needing research (see the salary guidance in the main prompt below).
const SALARY_OPEN_ENDED_RE = /salary (requirement|expectation)|desired (salary|compensation|pay)|expected (salary|compensation|pay)|compensation expectation/i;
// A candidate's own instruction: the job description itself is always the
// first place to check for a salary figure before ever researching one -
// some postings state a range in body text (not just a dedicated "do you
// accept this range" form field), and that beats a live search every
// time. Matches common ways a range/figure gets written: "$60,000",
// "$60K", or a bare number range like "60,000-72,000" immediately
// preceded by a dollar sign on either side.
const JD_HAS_SALARY_RE = /\$\s?\d{2,3}(,\d{3})+|\$\s?\d{2,3}\s?[kK]\b|\$\s?\d{2,3}[,.]?\d{0,3}\s*(-|–|to)\s*\$?\s?\d{2,3}[,.]?\d{0,3}\s?[kK]?/;

/**
 * A candidate's own instruction: for open-ended salary questions, look up
 * real current market data rather than relying only on Claude's trained
 * knowledge (which can be stale). Kept as its own small call, separate from
 * the main batched answerWithClaude() - that call forces a specific tool
 * choice (answer_fields) for clean structured output in a single turn,
 * which isn't compatible with the back-and-forth a web-search-enabled call
 * needs. This one runs with an ordinary text response instead, and its
 * findings get threaded into the main prompt as grounding.
 */
async function researchSalaryRange(anthropic: Anthropic, jobTitle: string, jobDescription: string): Promise<string> {
  try {
    const message = await anthropic.messages.create({
      model: MODEL,
      max_tokens: 512,
      tools: [{ type: "web_search_20260318", name: "web_search", max_uses: 3 } satisfies Anthropic.WebSearchTool20260318],
      messages: [
        {
          role: "user",
          content: `Search the web for the current, typical salary range for this specific role, using real sources (e.g. Glassdoor, Levels.fyi, Payscale, LinkedIn Salary, Indeed, Salary.com). Job title: "${jobTitle}".\n\nJob description (for context on seniority/location/company):\n${jobDescription.slice(0, 2000)}\n\nRespond with just the estimated range as plain text (e.g. "$70,000-$85,000 per year"), plus a brief one-sentence note on what it's based on. If you can't find reliable, current data, say so plainly rather than guessing.`,
        },
      ],
    });
    const textBlock = message.content.find((b): b is Anthropic.TextBlock => b.type === "text");
    return textBlock?.text?.trim() || "";
  } catch {
    // Not essential to the run - if the search fails for any reason (API
    // hiccup, tool unavailable), fall back silently to the existing
    // trained-knowledge estimate in the main prompt rather than blocking.
    return "";
  }
}

async function answerWithClaude(
  anthropic: Anthropic,
  resume: Resume,
  jobDescription: string,
  context: PersonalContext,
  fields: AnswerableField[],
  isRetry = false,
  salaryResearch = ""
): Promise<Map<string, ClaudeAnswer>> {
  if (fields.length === 0) return new Map();

  const fieldsBlock = fields
    .map(
      (f) =>
        `- selector: ${f.selector} | label: "${f.label}" | ${f.required ? "[REQUIRED]" : "[optional]"}${f.multiSelect ? " | [MULTI-SELECT] (use \"values\", a list of every matching option)" : ""}${f.isCombobox && f.options.length === 0 ? " | TYPE: combobox (return a short target phrase)" : ""}${f.options.length ? ` | options: [${f.options.join(", ")}]` : ""}`
    )
    .join("\n");

  const contextBlocks = buildContextBlocks(context);
  const salaryResearchBlock = salaryResearch ? `\n\nLive salary research for this specific role (from a real web search just now - use this as the primary source for any open-ended salary question, ahead of your own trained knowledge, and mark HIGH confidence when it found solid data):\n${salaryResearch}` : "";

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
        content: `${retryNotice}Resume:\n${resume.text}\n\nJob description:\n${jobDescription.slice(0, 4000)}\n\n${contextBlocks}${salaryResearchBlock}\n\nFill in these application form fields. Guidance:\n- Salary/compensation questions come in two shapes, answered differently:\n  - "Do you accept/agree to the salary or range listed in this posting?" (yes/no framing tied to a range already stated in the job description): answer "Yes" with HIGH confidence whenever the job description lists a salary or range. Submitting this application already implies the range has been seen and is acceptable - this is not a guess.\n  - "What is your desired/expected salary?" (asking the candidate to state a number): FIRST check the actual job description text above for a stated salary or range (it doesn't have to be in a dedicated salary field - some postings just state it in the body text) - if it's there, use it and say you're fine with that listed range (high confidence). This always wins over anything else below, including live research, even if a range you find some other way looks different. Otherwise, if live salary research was provided above, use that range (high confidence - it's real current data, not a guess). If neither is available, give your best-estimate typical range for this specific role and location based on your own knowledge, as "$X-$Y", and mark confidence "low" since it's an estimate. If you're not confident even estimating, default to "$65,000-$80,000 depending on scope and responsibilities" and mark confidence "low".\n- "Why are you interested in this role/company" or similar company-specific questions: write a grounded, specific 2-4 sentence answer using concrete details from the job description (including any "About [Company]" section) and the resume's relevant experience. Avoid generic, templated-sounding language - it should be clearly specific to this exact company and role, not something that could be pasted into any application.\n- Everything else: concise and truthful, based only on the resume and the context above.\n- Fields marked [REQUIRED] must always get a real, non-empty best-effort value - never decline by returning an empty string, even if you have to extrapolate. Set confidence to "low" whenever you had to extrapolate rather than answer from something concrete. Fields marked [optional] may get an empty string if you can't confidently answer at all.\n\n${fieldsBlock}`,
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

/** Fills every field on the currently-displayed page/step of a form. */
export async function fillCurrentPage(
  page: Page,
  anthropic: Anthropic,
  resume: Resume,
  resumeFilePath: string,
  jobDescription: string,
  context: PersonalContext,
  jobTitle = ""
): Promise<{ filled: FillReport["filled"]; skipped: FillReport["skipped"]; notes: string[] }> {
  const formCtx = await findFormContext(page);
  const fields = await discoverFields(formCtx);
  const notes: string[] = [];
  const filled: FillReport["filled"] = [];
  const skipped: FillReport["skipped"] = [];
  const toAnswer: AnswerableField[] = [];
  const profile = context.profile;
  const filledSelectors: FilledTextRecord[] = [];

  // EEOC radio groups (Gender, Race, Veteran Status, etc.) are made up of
  // several individually-discovered radio options sharing one native
  // `name` - group them back into one logical question so a genuinely
  // sensitive group's own "decline to answer" option can be selected
  // automatically, the same trusted treatment a combobox/select-shaped
  // version of the exact same question already gets below (see
  // SENSITIVE_RE further down). This never guesses at an actual
  // demographic answer - it only ever finds and clicks a real "decline"
  // option (matched via the same DECLINE_RE used for EEOC selects/
  // comboboxes and the SMS-consent opt-out), or leaves the whole group
  // alone if one isn't found. Confirmed live on Ashby that every such
  // group includes a real, matchable decline option ("Decline to
  // self-identify", "I decline to self-identify for protected veteran
  // status").
  const handledSelectors = new Set<string>();
  const radioGroups = new Map<string, DiscoveredField[]>();
  for (const field of fields) {
    if (field.type !== "radio" || !field.groupName) continue;
    if (!radioGroups.has(field.groupName)) radioGroups.set(field.groupName, []);
    radioGroups.get(field.groupName)!.push(field);
  }
  for (const members of radioGroups.values()) {
    const question = members[0].groupQuestion || members[0].label;
    if (!SENSITIVE_RE.test(question.toLowerCase())) continue;
    const required = members.some((m) => m.required);
    const declineOption = members.find((m) => DECLINE_RE.test(m.label));
    if (declineOption) {
      const ok = await checkField(formCtx, declineOption.selector);
      if (ok) filled.push({ label: question, value: declineOption.label });
      else skipped.push({ label: question, reason: "voluntary demographic/EEO field - could not select decline option, left for you to complete", required });
    } else {
      skipped.push({ label: question, reason: "voluntary demographic/EEO field - no decline option found, left for you to complete", required });
    }
    for (const m of members) handledSelectors.add(m.selector);
  }

  for (const field of fields) {
    if (handledSelectors.has(field.selector)) continue;

    // Anti-bot / not-part-of-the-form guard. Reported as a deliberate skip
    // (required: false) rather than a "couldn't answer" failure - leaving a
    // honeypot empty is the correct outcome, not a gap.
    if (field.skipAlways) {
      skipped.push({ label: field.label || field.selector, reason: field.skipReason, required: false });
      continue;
    }
    // Fill-time reachability. Exempt controls whose aria-labelledby points
    // at a visible partner: those are real inputs styled behind a visible
    // clickable surface (checkField handles them) and always fail a
    // hit-test by design. This exemption MUST run before the check below -
    // reversing the order would block every such control before anything
    // could rescue it, including a required consent checkbox that gates
    // page 1 of a real multi-page flow.
    if (!field.hasVisibleLabelPartner) {
      const reach = await reachability(formCtx, field.selector);
      if (reach === "blocked") {
        skipped.push({
          label: field.label || field.selector,
          reason: "not reachable by a real click (hidden or covered) - left empty",
          required: false,
        });
        continue;
      }
      // Fail-open, but not silently. A 0x0 control with no visible
      // aria-labelledby partner is exactly the shape a novel honeypot would
      // take on a site that uses neither aria-hidden nor a give-away name.
      // We still attempt it (skipping on an inconclusive verdict is how
      // real fields silently vanish), but surface it for review.
      // File inputs are exempt from the note: a 0x0 <input type="file">
      // behind a styled dropzone is the near-universal pattern, and
      // setInputFiles() doesn't need the element to be clickable at all, so
      // it isn't evidence of anything. Flagging them would fire on every
      // run of several already-verified forms and train the reader to
      // ignore these notes, which defeats the point of the signal.
      if (reach === "inconclusive-zero-size" && field.type !== "file") {
        notes.push(
          `Filled a zero-size field with no visible label partner: "${(field.label || field.selector).slice(0, 60)}". Legitimate hidden controls look like this, but so would an unrecognized honeypot - worth a look.`
        );
      }
    }

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
          // is itself a positive signal, not a failure.
          const filesLength = await formCtx
            .$eval(field.selector, (el) => (el as HTMLInputElement).files?.length ?? 0)
            .catch(() => null);
          if (filesLength === 0) {
            // A still-present input reporting zero files is ambiguous, not
            // conclusive - confirmed live on Rippling's ATS that a widget
            // can keep the same input in the DOM while its own React state
            // (not the native input) tracks the upload, resetting
            // input.files back to empty immediately after consuming it,
            // even though the upload genuinely succeeded (visually
            // confirmed: the dropzone UI swapped to a "<filename> ×" chip).
            // Checking for "any file-extension-looking text on the page" is
            // too broad a signal - forms commonly show static instructional
            // text like "Accepted file types: pdf, doc, docx" regardless of
            // upload state. Look for a distinctive prefix of the actual
            // uploaded filename instead (long filenames get visually
            // truncated with "...", so only the first ~15 characters are
            // safe to rely on being shown intact).
            await delay(300);
            const namePrefix = path.basename(resumeFilePath, path.extname(resumeFilePath)).slice(0, 15);
            const looksUploaded = await formCtx
              .locator("body")
              .evaluate((body, prefix) => (body.textContent || "").includes(prefix), namePrefix)
              .catch(() => false);
            if (looksUploaded) {
              filled.push({ label: field.label || "Resume upload", value: path.basename(resumeFilePath) });
            } else {
              skipped.push({ label: field.label || "Resume upload", reason: "failed to upload resume file - attach it manually", required: field.required });
            }
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
      const ok = await checkField(formCtx, field.selector);
      if (ok) filled.push({ label: field.label, value: "Agreed" });
      else skipped.push({ label: field.label, reason: "standard recruitment-data consent - could not check it, please check manually", required: field.required });
      continue;
    }

    if (field.type === "radio" && TEXT_MESSAGE_RE.test(field.label) && DECLINE_RE.test(field.label)) {
      // SMS/text-message opt-in questions render as a "Yes, I consent" /
      // "No, I don't consent" radio pair, each option individually
      // labeled - a candidate's own instruction: always decline text
      // message updates, so click whichever radio's own label is the
      // opt-out one.
      const ok = await checkField(formCtx, field.selector);
      if (ok) filled.push({ label: field.label, value: field.label });
      else skipped.push({ label: field.label, reason: "text-message consent opt-out - could not select it, please select manually", required: field.required });
      continue;
    }

    if ((field.type === "checkbox" || field.type === "radio") && field.options.length >= 2 && field.label && !SENSITIVE_RE.test(labelLower)) {
      // Routine Yes/No-style questions (work authorization, visa
      // sponsorship, etc., confirmed live on Ashby) render via the
      // sibling-button pattern harvested into field.options by
      // discoverFields() - real, answerable questions that would
      // otherwise fall into the generic "always skip" bucket right below,
      // alongside genuinely sensitive EEOC fields. SENSITIVE_RE is checked
      // here rather than left to the dedicated check further down in this
      // function, because that check only runs for SELECT/combobox/text
      // fields - checkboxes and radios never reach that far, they always
      // continue out of this loop via one branch in this section or the
      // next.
      toAnswer.push({
        selector: field.selector,
        label: field.label,
        tag: field.tag,
        type: field.type,
        options: field.options,
        isCombobox: false,
        required: field.required,
        multiSelect: false,
      });
      continue;
    }

    if (field.type === "checkbox" || field.type === "radio") {
      // Broader-scope consent/legal checkboxes are always left for the
      // user, as are genuinely sensitive EEOC questions (gender, race,
      // veteran/disability status) - those render as a real multi-option
      // radio group (confirmed live on Ashby: grouped by a shared native
      // `name`, with the question text as a direct-child <label> of the
      // group's <fieldset>), and reliably identifying just the "decline"
      // option among several sibling radios isn't covered; safer to leave
      // for manual review than guess at a protected-category answer.
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
    // A work-authorization/sponsorship question can phrase itself around
    // location ("...authorized to work in the location where this role is
    // based?", confirmed live on Vanta's form) and would otherwise trip
    // WORK_LOCATION_RE's "where...based" arm - guard it out so such a
    // question is never mistaken for a "fill in your city" field. (In
    // practice these render as Yes/No choice-buttons handled earlier in
    // this loop, but this keeps the text/combobox-shaped case safe too.)
    const looksLikeAuthQuestion = /authoriz|sponsor|eligible to work|legally.*\bwork\b|right to work/i.test(labelLower);
    const isLocationField =
      !looksLikeAuthQuestion &&
      (labelLower.includes("city") ||
        // Bare/prefixed "Location" (confirmed live on Vanta: a field
        // labeled exactly "Location"), anchored so it can't swallow
        // "relocation" or "Are you open to relocation?" (which has its own
        // qa_context answer and must go to Claude, not be filled with a
        // city).
        /^(current |preferred |your )?location$/.test(labelLower) ||
        WORK_LOCATION_RE.test(labelLower));
    if (isLocationField && profile.city) {
      // "Current Location" (confirmed live on Ashby: a single combined
      // city/state/country combobox, e.g. "Decatur, Georgia, United
      // States") is the same kind of field as a bare "City" one, just a
      // different label - without this alias it fell through to Claude's
      // general answering instead of this deterministic, profile-sourced
      // path, and Claude guessed a plausible-looking but wrong city
      // ("Atlanta" rather than the real "Decatur") with no disambiguation.
      // WORK_LOCATION_RE extends the same handling to "where do you plan on
      // working from"/payroll-jurisdiction phrasings (see its definition) -
      // the honest answer to those is the candidate's own city too.
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
    // grounding to answer them from. isCombobox is checked in addition to
    // the tag allowlist, not instead of it - a combobox's clickable
    // trigger isn't always a real <input>/<select> (confirmed live on
    // Rippling's ATS: state-residency and sponsorship both render as a
    // bare <div role="combobox">), and without this check those fields
    // were being discovered but then silently dropped here - appearing in
    // neither the filled nor skipped report, not even a "left blank"
    // signal.
    if (field.tag === "SELECT" || field.tag === "INPUT" || field.tag === "TEXTAREA" || field.isCombobox) {
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
      toAnswer.push({ selector: field.selector, label: field.label, tag: field.tag, type: field.type, options, isCombobox: field.isCombobox, required: field.required, multiSelect });
    }
  }

  if (toAnswer.length > 0) {
    // A candidate's own instruction: open-ended salary questions should
    // use real current market data, not just Claude's trained knowledge -
    // but only once the job description itself has been checked for a
    // stated figure, which always wins over a search. Some postings state
    // a range in their own body text (not just a dedicated "do you accept
    // this range" field), and skipping the research call entirely when one's
    // already there isn't just an optimization - it removes any chance of a
    // separately-researched figure out-competing the JD's own number in
    // Claude's answer, which is exactly the failure mode a live test hit
    // (the JD stated $60,000-$72,000, but a live-researched $58,000-$85,000
    // got used instead, backwards from what should always win).
    const hasOpenEndedSalaryQuestion = toAnswer.some((f) => SALARY_OPEN_ENDED_RE.test(f.label));
    const salaryResearch =
      hasOpenEndedSalaryQuestion && !JD_HAS_SALARY_RE.test(jobDescription)
        ? await researchSalaryRange(anthropic, jobTitle, jobDescription)
        : "";

    const answers = await answerWithClaude(anthropic, resume, jobDescription, context, toAnswer, false, salaryResearch);
    const hasAnswer = (f: AnswerableField, a: ClaudeAnswer | undefined) =>
      !!a && (f.multiSelect ? a.values.length > 0 : !!a.value);

    // The prompt tells Claude required fields must never come back empty,
    // but that's an instruction, not an enforced constraint - it doesn't
    // always comply. Give it one more, firmer-worded shot at just the
    // required fields it left blank before accepting the gap.
    const stillEmptyRequired = toAnswer.filter((f) => f.required && !hasAnswer(f, answers.get(f.selector)));
    let retried = false;
    if (stillEmptyRequired.length > 0) {
      const retryAnswers = await answerWithClaude(anthropic, resume, jobDescription, context, stillEmptyRequired, true, salaryResearch);
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

      if (field.type === "checkbox" || field.type === "radio") {
        // The choice-buttons pattern (see clickChoiceButton) - the real
        // click surface is a sibling <button>, not the underlying
        // input, so this can't go through fillTextVerified/selectOption
        // like an ordinary field.
        const picked = await clickChoiceButton(formCtx, field.selector, [value]);
        if (picked) filled.push({ label: field.label, value: picked, generated: true, lowConfidence });
        else skipped.push({ label: field.label, reason: `could not find a matching button for "${value}" for this question`, required });
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
  return { filled: finalFilled, skipped, notes };
}

// Advance controls. NEXT_RE is anchored: a real Oracle HCM page carries a
// session-keepalive "Continue Working" button, which an unanchored
// /continue/ would happily click instead of the real Next.
const NEXT_RE = /^(next|continue|save (and|&) continue|save (and|&) next)$/i;
// Never clicked. The tool has no code path that submits an application.
const SUBMIT_RE = /submit|finish|send application|complete application/i;
// Never clicked either - these abandon or reset the flow.
const ABORT_RE = /^(cancel|discard|back|end session|sign out|log ?out|start over)$/i;
// Bot-detection. Seeing any of these is a hard stop, never something to
// work around.
const CAPTCHA_RE = /captcha|recaptcha|hcaptcha|are you a human|verify you are human|i'm not a robot/i;
// A code emailed/texted to the candidate. Unreachable programmatically -
// the tool has no access to the inbox, and shouldn't.
const VERIFICATION_CODE_RE = /verification code|one-?time (code|password|pin)|\bOTP\b|enter the code|code we (sent|emailed)|security code/i;
const MAX_PAGES = 10;

/** Clicks "Reject All Non-Essential" (or the closest decline) on a cookie banner. */
export async function dismissCookieBanner(page: Page): Promise<string | null> {
  const candidates = [
    /^reject all non-?essential/i,
    /^reject all/i,
    /^decline all/i,
    /^only (necessary|essential)/i,
    /^necessary cookies only/i,
  ];
  const buttons = await page.$$("button, [role=button], a");
  for (const re of candidates) {
    for (const b of buttons) {
      const t = ((await b.textContent().catch(() => "")) || "").replace(/\s+/g, " ").trim();
      if (t && re.test(t)) {
        const ok = await b.click({ timeout: 3000 }).then(() => true).catch(() => false);
        if (ok) {
          await delay(800);
          return t;
        }
      }
    }
  }
  return null;
}

/**
 * Closes a modal/dialog currently covering the form, returning a short
 * description of what was closed (or null if nothing was). Only touches
 * genuinely dismissive controls - a close/X button, or an acknowledgement
 * button on an informational dialog. Never agrees to anything scoped
 * beyond acknowledging the dialog itself.
 */
async function dismissBlockingOverlay(page: Page): Promise<string | null> {
  const open = await page
    .evaluate(() => {
      const d = Array.from(document.querySelectorAll('dialog[open], [role="dialog"], .oj-dialog')).find((el) => {
        const r = el.getBoundingClientRect();
        if (r.width <= 200 || r.height <= 200) return false;
        // CRITICAL: some ATSs render the application form itself inside a
        // dialog (Oracle HCM Cloud does - the apply flow lives in an
        // oj-dialog), so "a large dialog is open" is not evidence of an
        // interloper. Closing that would tear down the form mid-run.
        // An informational overlay (terms, privacy policy, a notice) has
        // no form controls in it; the application dialog is full of them.
        return el.querySelectorAll("input:not([type=hidden]), textarea, select, [role=combobox]").length === 0;
      });
      return d ? (d.textContent || "").replace(/\s+/g, " ").trim().slice(0, 60) : null;
    })
    .catch(() => null);
  if (!open) return null;

  const closers = ['[role="dialog"] button[aria-label*="close" i]', '[role="dialog"] .oj-dialog-close', ".oj-dialog button[title*='Close' i]", 'dialog[open] button[aria-label*="close" i]'];
  for (const sel of closers) {
    const ok = await page.click(sel, { timeout: 2000 }).then(() => true).catch(() => false);
    if (ok) {
      await delay(800);
      return open;
    }
  }
  // Fall back to an explicit acknowledgement button on the dialog itself.
  const btns = await page.$$('[role="dialog"] button, dialog[open] button, .oj-dialog button');
  for (const b of btns) {
    const t = ((await b.textContent().catch(() => "")) || "").replace(/\s+/g, " ").trim();
    if (/^(close|ok|got it|dismiss|agree|i agree|accept)$/i.test(t)) {
      const ok = await b.click({ timeout: 2000 }).then(() => true).catch(() => false);
      if (ok) {
        await delay(800);
        return `${open} [via "${t}"]`;
      }
    }
  }
  return null;
}

/** Finds a clickable "next/continue" control, excluding submit/abort controls. */
async function findNextControl(page: Page) {
  const els = await page.$$("button, [role=button], input[type=button], input[type=submit], a");
  for (const el of els) {
    const raw = ((await el.textContent().catch(() => "")) || "") + " " + ((await el.getAttribute("value").catch(() => "")) || "");
    const text = raw.replace(/\s+/g, " ").trim();
    if (!text) continue;
    if (SUBMIT_RE.test(text) || ABORT_RE.test(text)) continue;
    if (!NEXT_RE.test(text)) continue;
    const usable = await el.isEnabled().catch(() => false);
    if (usable) return { handle: el, text };
  }
  return null;
}

/**
 * A structural signature of the form controls currently on the page, used
 * to decide whether clicking Next actually advanced the flow.
 *
 * Deliberately identity-based (tag/id/name/type of every control) rather
 * than a snapshot of body text. A text-based fingerprint false-positives on
 * exactly the case that matters most: a failed Next injects validation-error
 * text into the page, which changes the text but not the step - so the loop
 * concluded it had advanced and re-filled the same page until the page cap.
 * Field identity doesn't move when an error message appears, but does change
 * completely on a real step transition.
 */
async function pageFieldSignature(page: Page): Promise<string> {
  return page
    .evaluate(() =>
      Array.from(document.querySelectorAll("input:not([type=hidden]), textarea, select"))
        .map((e) => `${e.tagName}:${e.id || e.getAttribute("name") || ""}:${(e as HTMLInputElement).type || ""}`)
        .sort()
        .join("|")
    )
    .catch(() => "");
}

/** Visible validation/error text the form is showing right now. */
async function readValidationErrors(page: Page): Promise<string[]> {
  return page
    .evaluate(() => {
      const sel = '[role="alert"], [aria-invalid="true"], .oj-messaging-inline-container, [class*="error-message"], [class*="ErrorMessage"]';
      return [
        ...new Set(
          Array.from(document.querySelectorAll(sel))
            .map((e) => (e.textContent || "").replace(/\s+/g, " ").trim())
            .filter((t) => t.length > 2 && t.length < 200)
        ),
      ].slice(0, 5);
    })
    .catch(() => [] as string[]);
}

/** True if the page currently shows a CAPTCHA / bot challenge. */
async function detectCaptcha(page: Page): Promise<boolean> {
  const frameHit = page.frames().some((f) => /hcaptcha|recaptcha|captcha/i.test(f.url()));
  if (frameHit) return true;
  return page
    .evaluate((src) => new RegExp(src, "i").test(document.body.innerText || ""), CAPTCHA_RE.source)
    .catch(() => false);
}

/**
 * Multi-page driver. Fills the current step, looks for a Next/Continue
 * control, clicks it, confirms the page actually advanced, and repeats.
 *
 * Never clicks Submit - the loop exits when only a submit control remains.
 * Stops and reports rather than improvising on: a CAPTCHA, a verification
 * code it can't read, or a Next that doesn't advance (which almost always
 * means required fields are still empty - reported with the specific
 * fields, so the stall is diagnosable rather than a spin).
 */
export async function fillApplication(
  page: Page,
  anthropic: Anthropic,
  resume: Resume,
  resumeFilePath: string,
  jobDescription: string,
  outDir: string,
  context: PersonalContext,
  jobTitle = "",
  options: { headed?: boolean; pinTimeoutMs?: number; onPagePrompt?: (msg: string, timeoutMs: number) => Promise<void> } = {}
): Promise<FillReport> {
  const filled: FillReport["filled"] = [];
  const skipped: FillReport["skipped"] = [];
  const screenshots: string[] = [];
  const notes: string[] = [];

  const cookieChoice = await dismissCookieBanner(page);
  if (cookieChoice) notes.push(`Cookie banner: clicked "${cookieChoice}".`);

  let pageNum = 1;
  for (; pageNum <= MAX_PAGES; pageNum++) {
    if (await detectCaptcha(page)) {
      notes.push(`HARD STOP on page ${pageNum}: a CAPTCHA / bot challenge is present. The tool never attempts to solve or bypass these - finish this application manually.`);
      break;
    }

    const res = await fillCurrentPage(page, anthropic, resume, resumeFilePath, jobDescription, context, jobTitle);
    for (const f of res.filled) filled.push({ ...f, label: `[p${pageNum}] ${f.label}` });
    for (const s of res.skipped) skipped.push({ ...s, label: `[p${pageNum}] ${s.label}` });
    for (const n of res.notes) notes.push(`[p${pageNum}] ${n}`);

    const shot = path.join(outDir, pageNum === 1 ? "application-preview.png" : `application-preview-page${pageNum}.png`);
    await page.screenshot({ path: shot, fullPage: true }).catch(() => {});
    screenshots.push(shot);

    // A code sent to the candidate's inbox/phone: not something this tool
    // can or should retrieve. Headed runs pause so a human can type it and
    // let the run continue; headless runs exit cleanly, since nobody's there.
    const needsCode = await page
      .evaluate((src) => new RegExp(src, "i").test(document.body.innerText || ""), VERIFICATION_CODE_RE.source)
      .catch(() => false);
    if (needsCode) {
      if (options.headed && options.onPagePrompt) {
        const timeoutMs = options.pinTimeoutMs ?? 5 * 60_000;
        notes.push(`Page ${pageNum} asked for a verification code - paused for manual entry.`);
        await options.onPagePrompt(
          `\nPage ${pageNum} is asking for a verification code, which this tool can't read.\nEnter it in the open browser window, then press Enter here to continue (auto-continues in ${Math.round(timeoutMs / 60000)} min).`,
          timeoutMs
        );
      } else {
        notes.push(`STOPPED on page ${pageNum}: this step requires a verification code sent to you, which the tool can't read. Re-run with --headed to enter it yourself and let the run continue.`);
        break;
      }
    }

    // A stray modal (a policy/terms dialog opened by a mis-aimed click, a
    // cookie re-prompt) sits on top of the form and silently swallows the
    // Next click - the flow then stalls with no obvious cause. Close any
    // dialog that's open before looking for Next, and say so, since an
    // unexpected dialog is itself worth knowing about.
    const dismissedOverlay = await dismissBlockingOverlay(page);
    if (dismissedOverlay) notes.push(`[p${pageNum}] Closed an overlay covering the form ("${dismissedOverlay}") before continuing.`);

    const next = await findNextControl(page);
    if (!next) {
      notes.push(`Reached the end of the flow at page ${pageNum} (no Next/Continue control - only a submit or nothing further). Nothing was submitted.`);
      break;
    }

    const urlBefore = page.url();
    const signatureBefore = await pageFieldSignature(page);
    await next.handle.click({ timeout: 5000 }).catch(() => {});
    await delay(3500);

    const urlAfter = page.url();
    const signatureAfter = await pageFieldSignature(page);

    if (urlAfter === urlBefore && signatureAfter === signatureBefore) {
      // Didn't advance. Overwhelmingly this means client-side validation
      // rejected the step, so surface the page's own error text - that
      // names the actual blocker far better than guessing from our own
      // skip list, which only knows what *we* declined to fill.
      const errors = await readValidationErrors(page);
      const blockers = skipped.filter((s) => s.required).map((s) => s.label);
      notes.push(
        `STOPPED on page ${pageNum}: clicked "${next.text}" but the page didn't advance - almost certainly required input still missing.` +
          (errors.length ? ` Page reported: ${errors.map((e) => `"${e}"`).join("; ")}.` : "") +
          (blockers.length ? ` Required fields left unfilled: ${blockers.join("; ")}.` : "") +
          (!errors.length && !blockers.length ? ` No validation text or unfilled required field found - check the screenshot.` : "")
      );
      break;
    }
    await delay(1500);
  }

  if (pageNum > MAX_PAGES) notes.push(`Stopped after the ${MAX_PAGES}-page safety cap.`);

  return { filled, skipped, screenshotPath: screenshots[0] ?? path.join(outDir, "application-preview.png"), screenshots, notes };
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
