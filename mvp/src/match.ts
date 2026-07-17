import Anthropic from "@anthropic-ai/sdk";

export const MODEL = process.env.CLAUDE_MODEL || "claude-sonnet-5";

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

export async function rankJobs(
  anthropic: Anthropic,
  resumeText: string,
  candidates: CandidateJob[]
): Promise<RankedJob[]> {
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
        content: `Here is a candidate's resume:\n\n${resumeText}\n\nHere are ${candidates.length} job postings the candidate might apply to:\n\n${postingsBlock}\n\nScore each posting on how well it fits the candidate's background, skills, and experience level. Be honest about mismatches (e.g. wrong seniority, wrong domain).`,
      },
    ],
  });

  const toolUse = message.content.find((b): b is Anthropic.ToolUseBlock => b.type === "tool_use");
  if (!toolUse) throw new Error("Claude did not return a ranking tool call.");

  const { rankings } = toolUse.input as { rankings: { url: string; score: number; reasoning: string }[] };

  const byUrl = new Map(candidates.map((c) => [c.url, c]));
  const results: RankedJob[] = rankings
    .filter((r) => byUrl.has(r.url))
    .map((r) => ({ job: byUrl.get(r.url)!, score: r.score, reasoning: r.reasoning }));

  results.sort((a, b) => b.score - a.score);
  return results;
}
