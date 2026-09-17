import Anthropic from "@anthropic-ai/sdk";
import type { JobPosting } from "./scrape.js";

export const MODEL = process.env.CLAUDE_MODEL || "claude-sonnet-5";

/**
 * Sampling parameters are NOT available here. temperature, top_p and top_k
 * were removed on this model family - claude-sonnet-5 returns
 * "400 `temperature` is deprecated for this model", so the obvious fix for
 * run-to-run variance does not exist. Variance is reduced by constraining
 * the JUDGEMENT instead (see the scoring bands in rankJobs) and by making
 * the ordering deterministic once scores come back.
 */

export interface CandidateJob {
  title: string;
  url: string;
  location: string;
  descriptionText: string;
}

export interface RankedJob {
  job: CandidateJob;
  score: number;
  reasoning: string;
}

const MAX_DESC_CHARS = 6000;

const RANK_TOOL: Anthropic.Tool = {
  name: "rank_jobs",
  description: "Score how well each job posting matches the candidate's resume.",
  input_schema: {
    type: "object",
    properties: {
      rankings: {
        type: "array",
        items: {
          type: "object",
          properties: {
            url: { type: "string", description: "The job posting URL, copied exactly." },
            score: { type: "number", description: "Fit score from 0 (no fit) to 100 (excellent fit)." },
            reasoning: { type: "string", description: "One or two sentences explaining the score." },
          },
          required: ["url", "score", "reasoning"],
        },
      },
    },
    required: ["rankings"],
  },
};

export interface TriagedTitle {
  job: JobPosting;
  why: string;
}

/** Upper bound on what one triage pass may shortlist, whatever the model returns. */
export const MAX_SHORTLIST = 20;

const TRIAGE_TOOL: Anthropic.Tool = {
  name: "shortlist_titles",
  description: "Pick the postings whose titles are worth reading in full for this candidate.",
  input_schema: {
    type: "object",
    properties: {
      shortlist: {
        type: "array",
        items: {
          type: "object",
          properties: {
            // Index, NOT url. With ~200 postings a copied-back URL is long,
            // repetitive and easy to corrupt; an index is one token and is
            // trivially validated against the list that was sent.
            index: { type: "number", description: "The posting's number from the list, copied exactly." },
            why: { type: "string", description: "A short phrase - why this title is plausible for the candidate." },
          },
          required: ["index", "why"],
        },
      },
    },
    required: ["shortlist"],
  },
};

/**
 * First pass over a whole board: pick which postings are worth OPENING.
 *
 * Titles only, deliberately. Fetching a description costs a page load, so
 * on a 193-posting board the triage has to happen before any of them are
 * opened - and ~200 titles is a few KB, which is one cheap call.
 *
 * Replaces a substring match against a fixed title list, which measured
 * badly on a real board: of Sony Interactive Entertainment's 193 postings,
 * exact-substring matching kept 3 and dropped "Senior Product Analyst",
 * "Technical Planning Analytics Analyst" and "Payments Analyst" - roles
 * that read as obvious candidates to a person. The list of target titles
 * is still passed, but as a statement of intent rather than as the
 * matching rule itself.
 *
 * Location is given to the model as context, never as a filter. On that
 * same board a hard Atlanta/Remote gate left 0 of 193, because the 14
 * remote postings had already been dropped on their titles.
 */
export async function triageTitles(
  anthropic: Anthropic,
  resumeText: string,
  targetTitles: string[],
  jobs: JobPosting[]
): Promise<TriagedTitle[]> {
  if (jobs.length === 0) return [];

  const listBlock = jobs.map((j, i) => `${i}. ${j.title}${j.location ? ` — ${j.location}` : ""}`).join("\n");

  const message = await anthropic.messages.create({
    model: MODEL,
    max_tokens: 2048,
    tools: [TRIAGE_TOOL],
    tool_choice: { type: "tool", name: "shortlist_titles" },
    messages: [
      {
        role: "user",
        content:
          `Here is a candidate's resume:\n\n${resumeText}\n\n` +
          `Roles they have said they are looking for:\n${targetTitles.map((t) => `- ${t}`).join("\n")}\n\n` +
          `Here are ${jobs.length} postings from one company's job board, as title and location only:\n\n${listBlock}\n\n` +
          `Shortlist up to ${MAX_SHORTLIST} whose titles are worth reading in full for this candidate.\n\n` +
          `- Judge by what the role plainly IS, not by whether its wording matches the list above. ` +
          `"Analyst, Business Operations" and "Business Operations Analyst" are the same job; a title the list never anticipated can still be an obvious fit.\n` +
          `- Respect seniority. This candidate is early-career, so a Director, Principal, Staff or Head-of role is not a fit however well the domain matches.\n` +
          `- Stay in the candidate's actual domain. A software engineering role is not a fit for a business/operations analyst background, whatever the title shares.\n` +
          `- Location is context, not a filter: include a strong fit in any location and let the later stage weigh it. Do not shortlist a weak fit just because it is remote.\n` +
          `- Shortlist fewer than ${MAX_SHORTLIST} if fewer genuinely qualify. An empty shortlist is a valid answer for a board with nothing suitable on it.`,
      },
    ],
  });

  const toolUse = message.content.find((b): b is Anthropic.ToolUseBlock => b.type === "tool_use");
  if (!toolUse) throw new Error("Claude did not return a triage tool call.");
  const { shortlist } = toolUse.input as { shortlist: { index: number; why: string }[] };

  // Validated against the list actually sent: an out-of-range or repeated
  // index is dropped rather than trusted, so a bad response can shorten the
  // shortlist but never invent a posting.
  const seen = new Set<number>();
  const picked: TriagedTitle[] = [];
  for (const { index, why } of shortlist ?? []) {
    if (!Number.isInteger(index) || index < 0 || index >= jobs.length) continue;
    if (seen.has(index)) continue;
    seen.add(index);
    picked.push({ job: jobs[index], why });
    if (picked.length >= MAX_SHORTLIST) break;
  }
  return picked;
}

export async function rankJobs(
  anthropic: Anthropic,
  resumeText: string,
  candidates: CandidateJob[],
  acceptableLocations: string[] = []
): Promise<RankedJob[]> {
  // Location is weighed HERE rather than filtered earlier, because a hard
  // pre-filter measured terribly: on a 193-posting board an Atlanta/Remote
  // gate left nothing at all. But leaving it as a footnote measured badly
  // too - the first run's top suggestion was a 5+ year role in Adelaide,
  // Australia, ranked above a California role the candidate could plausibly
  // do. Stated explicitly so the score reflects whether someone can
  // actually take the job, while an exceptional distant role can still
  // surface rather than being hidden outright.
  const locationBlock = acceptableLocations.length
    ? `\n\nThe candidate is based in, or willing to work from: ${acceptableLocations.join(", ")}.\n` +
      `Weigh location as part of the score, not as a footnote:\n` +
      `- A role they can do from where they are - fully remote, or in one of those locations - should outrank an otherwise equivalent role that would require relocation.\n` +
      `- A role requiring relocation to another country is a substantial practical barrier. Reflect that in the number, not only in the reasoning.\n` +
      `- Do not reduce a score to zero on location alone: an outstanding fit elsewhere should still appear, just below a comparable one they can actually take.\n` +
      `- Judge from the description, which is what states the real policy. A posting labelled "Remote" that then requires hybrid on-site work is not remote.`
    : "";
  const postingsBlock = candidates
    .map(
      (c, i) =>
        `--- Posting ${i + 1} ---\nURL: ${c.url}\nTitle: ${c.title}\nLocation: ${c.location}\nDescription:\n${c.descriptionText.slice(0, MAX_DESC_CHARS)}`
    )
    .join("\n\n");

  const message = await anthropic.messages.create({
    model: MODEL,
    max_tokens: 2048,
    tools: [RANK_TOOL],
    tool_choice: { type: "tool", name: "rank_jobs" },
    messages: [
      {
        role: "user",
        content:
          `Here is a candidate's resume:\n\n${resumeText}\n\n` +
          `Here are ${candidates.length} job postings the candidate might apply to:\n\n${postingsBlock}\n\n` +
          `Score each posting on how well it fits the candidate's background, skills, and experience level. Be honest about mismatches (e.g. wrong seniority, wrong domain).\n\n` +
          // Anchored bands, because sampling parameters are unavailable on
          // this model family and an unanchored 0-100 scale is where the
          // run-to-run drift lives: the same posting scored 40 and 28 on
          // consecutive runs. Naming what each band MEANS gives the number
          // something to be anchored to.
          `Use these bands, and say which band you are applying:\n` +
          `- 80-100: squarely the role they already do, at their level, somewhere they can work.\n` +
          `- 60-79: clearly plausible - a stretch or a sidestep in one dimension only.\n` +
          `- 40-59: real overlap, but a definite mismatch in seniority, domain or location.\n` +
          `- 20-39: some transferable skills, but they are not a candidate a recruiter would shortlist.\n` +
          `- 0-19: wrong role, wrong field, or far beyond their experience.\n\n` +
          `Score in multiples of 5. Judge each posting on its own against the bands, not relative to the others in this list - the same posting must land in the same band whether it appears alongside strong or weak company.` +
          locationBlock,
      },
    ],
  });

  const toolUse = message.content.find((b): b is Anthropic.ToolUseBlock => b.type === "tool_use");
  if (!toolUse) throw new Error("Claude did not return a ranking tool call.");

  // Validated rather than trusted, the same way triageTitles validates its
  // indices. Observed live on a 194-posting board: `rankings` came back as
  // something other than an array and .filter threw a TypeError, taking
  // down a 40-second scan with a stack trace after all the work was done.
  // A malformed response can now shorten the list, never crash the run.
  const raw = (toolUse.input as { rankings?: unknown }).rankings;
  const rankings = Array.isArray(raw) ? raw : [];

  const byUrl = new Map(candidates.map((c) => [c.url, c]));
  const results: RankedJob[] = rankings
    .filter((r): r is { url: string; score: number; reasoning: string } =>
      !!r && typeof r === "object" && typeof (r as { url?: unknown }).url === "string" && Number.isFinite((r as { score?: unknown }).score)
    )
    .filter((r) => byUrl.has(r.url))
    .map((r) => ({ job: byUrl.get(r.url)!, score: r.score, reasoning: String(r.reasoning ?? "") }));

  // Scoring nothing at all is a failed call, not a board with no matches -
  // those are very different things to report, and silently returning an
  // empty list would show up as "0 postings read in full" after the work
  // had already been done.
  if (results.length === 0 && candidates.length > 0) {
    throw new Error(
      `Claude returned no usable rankings for ${candidates.length} posting(s). This is a transient response problem, not a verdict on the board - try the scan again.`
    );
  }

  // Score first, then URL as a tie-break. Without the second key, equally
  // scored postings keep whatever order the model happened to emit, so a
  // list can reshuffle between runs with no score having changed - which
  // reads to the person as the recommendation itself having changed.
  results.sort((a, b) => b.score - a.score || a.job.url.localeCompare(b.job.url));
  return results;
}
