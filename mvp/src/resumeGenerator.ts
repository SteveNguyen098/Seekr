import path from "node:path";
import os from "node:os";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { readFile, writeFile, mkdtemp, rm } from "node:fs/promises";
import Anthropic from "@anthropic-ai/sdk";
import JSZip from "jszip";
import { PDFDocument } from "pdf-lib";
import { MODEL } from "./match.js";

const execFileAsync = promisify(execFile);

function unescapeXml(s: string): string {
  return s.replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&quot;/g, '"').replace(/&apos;/g, "'").replace(/&amp;/g, "&");
}

function escapeXml(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

function isItalicRPr(rPrXml: string): boolean {
  const m = rPrXml.match(/<w:i\b([^/>]*)\/?>/);
  if (!m) return false;
  const valMatch = m[1].match(/w:val="([^"]*)"/i);
  if (!valMatch) return true;
  return !["0", "false"].includes(valMatch[1].toLowerCase());
}

function stripItalic(rPrXml: string): string {
  return rPrXml.replace(/<w:i\/>|<w:i\s+[^/>]*\/>|<w:i>[\s\S]*?<\/w:i>/g, "").replace(/<w:iCs\/>|<w:iCs\s+[^/>]*\/>|<w:iCs>[\s\S]*?<\/w:iCs>/g, "");
}

interface RawRun {
  xmlStart: number;
  xmlEnd: number;
  rPrXml: string;
  text: string;
}

/**
 * Word fragments text across many adjacent <w:r> runs (revision ids, the
 * literal "[" often lands in its own run, separate from the placeholder
 * text after it). Every downstream check operates at this per-run level
 * rather than assuming a bracket lives in one run.
 */
function parseRuns(xmlSlice: string, baseOffset: number): RawRun[] {
  const runs: RawRun[] = [];
  const runRe = /(<w:r(?:\s[^>]*)?>)([\s\S]*?)(<\/w:r>)/g;
  let m: RegExpExecArray | null;
  while ((m = runRe.exec(xmlSlice))) {
    const inner = m[2];
    const rPrMatch = inner.match(/<w:rPr>[\s\S]*?<\/w:rPr>/);
    const rPrXml = rPrMatch ? rPrMatch[0] : "";
    const textMatches = [...inner.matchAll(/<w:t(?:\s[^>]*)?>([\s\S]*?)<\/w:t>/g)];
    const text = textMatches.map((tm) => unescapeXml(tm[1])).join("");
    runs.push({
      xmlStart: baseOffset + m.index,
      xmlEnd: baseOffset + m.index + m[0].length,
      rPrXml,
      text,
    });
  }
  return runs;
}

interface RawParagraph {
  runs: RawRun[];
}

function parseParagraphs(documentXml: string): RawParagraph[] {
  const paragraphs: RawParagraph[] = [];
  const pRe = /(<w:p(?:\s[^>]*)?>)([\s\S]*?)(<\/w:p>)/g;
  let m: RegExpExecArray | null;
  while ((m = pRe.exec(documentXml))) {
    const innerStart = m.index + m[1].length;
    paragraphs.push({ runs: parseRuns(m[2], innerStart) });
  }
  return paragraphs;
}

export interface Placeholder {
  sectionHeader: string;
  paragraphText: string;
  originalContent: string;
  runXmlStart: number;
  runXmlEnd: number;
  beforeFragment: string;
  afterFragment: string;
  templateRPrXml: string;
}

// Resume section headers are conventionally short, all-caps, single-run
// paragraphs ("PROFESSIONAL SUMMARY", "CORE SKILLS") - distinct enough from
// body text (which always has lowercase letters) to detect generically.
const HEADING_RE = /^[A-Z0-9][A-Z0-9 &/-]{1,58}$/;

/**
 * A bracketed span is only a tailorable placeholder when every run its
 * text overlaps is italicized - the dual signal from the spec. Plain
 * italic text (job titles, dates) and stray brackets on their own don't
 * qualify; only the combination does. Detection happens at the paragraph
 * level so a bracket split across several fragmented runs is still found
 * and checked as one span, not missed run-by-run.
 */
export function detectPlaceholders(documentXml: string): Placeholder[] {
  const paragraphs = parseParagraphs(documentXml);
  const placeholders: Placeholder[] = [];
  let lastHeading = "";

  for (const para of paragraphs) {
    let text = "";
    const runStarts: number[] = [];
    for (const run of para.runs) {
      runStarts.push(text.length);
      text += run.text;
    }

    const trimmed = text.trim();
    if (trimmed && para.runs.length <= 2 && HEADING_RE.test(trimmed)) {
      lastHeading = trimmed;
      continue;
    }

    const bracketRe = /\[([^[\]]*)\]/g;
    let bm: RegExpExecArray | null;
    while ((bm = bracketRe.exec(text))) {
      const matchStart = bm.index;
      const matchEnd = bm.index + bm[0].length;

      let startRunIdx = -1;
      let endRunIdx = -1;
      for (let i = 0; i < para.runs.length; i++) {
        const rStart = runStarts[i];
        const rEnd = rStart + para.runs[i].text.length;
        if (startRunIdx === -1 && matchStart >= rStart && matchStart < rEnd) startRunIdx = i;
        if (matchEnd > rStart && matchEnd <= rEnd) endRunIdx = i;
      }
      if (startRunIdx === -1 || endRunIdx === -1 || endRunIdx < startRunIdx) continue;

      let allItalic = true;
      let bestRunIdx = startRunIdx;
      let bestOverlap = -1;
      for (let i = startRunIdx; i <= endRunIdx; i++) {
        const rStart = runStarts[i];
        const rEnd = rStart + para.runs[i].text.length;
        const overlapLen = Math.max(0, Math.min(rEnd, matchEnd) - Math.max(rStart, matchStart));
        if (overlapLen === 0) continue;
        if (!isItalicRPr(para.runs[i].rPrXml)) allItalic = false;
        if (overlapLen > bestOverlap) {
          bestOverlap = overlapLen;
          bestRunIdx = i;
        }
      }
      if (!allItalic) continue;

      const startRun = para.runs[startRunIdx];
      const endRun = para.runs[endRunIdx];
      const startLocal = matchStart - runStarts[startRunIdx];
      const endLocal = matchEnd - runStarts[endRunIdx];

      const beforeFragment =
        startLocal > 0 ? `<w:r>${startRun.rPrXml}<w:t xml:space="preserve">${escapeXml(startRun.text.slice(0, startLocal))}</w:t></w:r>` : "";
      const afterFragment =
        endLocal < endRun.text.length ? `<w:r>${endRun.rPrXml}<w:t xml:space="preserve">${escapeXml(endRun.text.slice(endLocal))}</w:t></w:r>` : "";

      placeholders.push({
        sectionHeader: lastHeading,
        paragraphText: text,
        originalContent: bm[1],
        runXmlStart: startRun.xmlStart,
        runXmlEnd: endRun.xmlEnd,
        beforeFragment,
        afterFragment,
        // The run with the most bracket-covered text is the real content
        // run, not a bracket-punctuation-only run - using its rPr avoids
        // inheriting a stray formatting difference from the "[" run (seen
        // live: "[" was bold+italic while the actual placeholder text was
        // italic-only, so picking "[" would have made the output bold).
        templateRPrXml: stripItalic(para.runs[bestRunIdx].rPrXml),
      });
    }
  }

  return placeholders;
}

/** Splices replacements directly into the original XML string in reverse
 * document order, so earlier offsets stay valid - nothing outside the
 * exact affected spans is touched or reserialized. */
export function applyReplacements(documentXml: string, placeholders: Placeholder[], replacements: string[]): string {
  let xml = documentXml;
  const order = placeholders.map((_, i) => i).sort((a, b) => placeholders[b].runXmlStart - placeholders[a].runXmlStart);
  for (const i of order) {
    const ph = placeholders[i];
    const newRun = `<w:r>${ph.templateRPrXml}<w:t xml:space="preserve">${escapeXml(replacements[i])}</w:t></w:r>`;
    xml = xml.slice(0, ph.runXmlStart) + ph.beforeFragment + newRun + ph.afterFragment + xml.slice(ph.runXmlEnd);
  }
  return xml;
}

const REPLACEMENT_TOOL: Anthropic.Tool = {
  name: "tailor_resume_sections",
  description: "Generate tailored replacement text for each bracketed resume placeholder, grounded in the candidate's real background and the target job description.",
  input_schema: {
    type: "object",
    properties: {
      replacements: {
        type: "array",
        items: {
          type: "object",
          properties: {
            index: { type: "number" },
            text: {
              type: "string",
              description:
                "Replacement text only - no brackets. Match the original content's format (a prose paragraph stays a prose paragraph, a comma-separated list stays a comma-separated list).",
            },
          },
          required: ["index", "text"],
        },
      },
    },
    required: ["replacements"],
  },
};

// A comma-heavy span with no terminal sentence punctuation reads as a
// flat list (skills, tools) rather than prose - used to decide whether a
// placeholder gets the explicit "always reorder" instruction below.
function looksLikeList(content: string): boolean {
  return content.split(",").length > 3 && !/[.!?]\s*$/.test(content.trim());
}

// Generic marker, not tied to any one candidate's exact wording - matches
// "independent product development", "personal project", "side project",
// "self-directed", etc., so this keeps working if the template's phrasing
// changes.
const INDEPENDENT_PROJECT_RE = /independent (product|project)|personal project|side project|self-directed/i;

// The candidate's canonical wording for their CRM background is "CRM
// Platform Experience" (as it appears in Core Competencies). A tailored run
// once emitted "CRM Platforms" in Technical Skills instead - a run-to-run
// terminology drift that makes otherwise-identical resumes look
// inconsistent side by side. Normalize every CRM reference in the skills
// sections to the one canonical phrase deterministically, so the LLM's
// phrasing choice can't reintroduce the drift regardless of what it emits.
// The trailing qualifier group is optional and greedy, so bare "CRM", "CRM
// Platforms", "CRM Software/Tools/Systems", and the already-canonical "CRM
// Platform Experience" all collapse to the same string (re-normalizing the
// canonical form is a no-op, no doubling). Plural forms are listed BEFORE
// their singular prefix (Platforms before Platform, Tools before Tool,
// Systems before System, Applications before Application) - regex
// alternation takes the first alternative that matches at a position, not
// the longest, so with the plural listed second "CRM Platforms" matched
// only "CRM Platform", leaving the trailing "s" outside the replaced span
// and producing "CRM Platform Experiences" (confirmed by a live test run -
// a real bug caught before it shipped, not hypothetical).
const CANONICAL_CRM = "CRM Platform Experience";
export function normalizeCrmTerminology(text: string): string {
  return text.replace(
    /\bCRM\b(?:[\s-]+(?:Platforms|Platform|Software|Tools|Tool|Systems|System|Applications|Application|Experience))*/gi,
    CANONICAL_CRM
  );
}

// True for the CORE SKILLS placeholders (Technical Skills / Core
// Competencies lists) - the only sections CRM-terminology normalization is
// scoped to, since forcing the exact noun phrase "CRM Platform Experience"
// into the prose Professional Summary would read awkwardly.
function isSkillsSection(p: Placeholder): boolean {
  return /core skills|technical skills|core competenc/i.test(`${p.sectionHeader} ${p.paragraphText}`);
}

async function generateReplacements(
  anthropic: Anthropic,
  placeholders: Placeholder[],
  jobDescription: string,
  fullResumeText: string,
  qaContext: string,
  feedback?: string
): Promise<string[]> {
  const placeholdersBlock = placeholders
    .map((p, i) => {
      const notes: string[] = [];
      if (looksLikeList(p.originalContent)) {
        notes.push(
          "[LIST: reorder these existing items by relevance to this job - the most relevant items first. Even when nothing new can be safely added, an unchanged order is only acceptable if it's already the best order for this specific job; don't default to leaving it untouched.]"
        );
      }
      if (INDEPENDENT_PROJECT_RE.test(p.originalContent)) {
        notes.push(
          "[MUST PRESERVE: this section references independent/personal project work - keep a reference to it in your replacement. This is a deliberate differentiator, not filler, and should not be dropped just because the job description doesn't happen to mention personal projects. Only omit it if keeping it would clearly overflow the page - treat that as a last resort, not a routine trim.]"
        );
      }
      return `[${i}] Section: "${p.sectionHeader}" | Surrounding paragraph: "${p.paragraphText}" | Current content: "${p.originalContent}" (${p.originalContent.length} characters)${notes.length ? ` ${notes.join(" ")}` : ""}`;
    })
    .join("\n\n");

  const qaBlock = qaContext ? `\n\nCandidate's own screening-question answers (also valid grounding for what's genuinely true about their background):\n${qaContext}` : "";

  const message = await anthropic.messages.create({
    model: MODEL,
    max_tokens: 2048,
    tools: [REPLACEMENT_TOOL],
    tool_choice: { type: "tool", name: "tailor_resume_sections" },
    messages: [
      {
        role: "user",
        content: `${feedback ? `${feedback}\n\n` : ""}You are tailoring specific bracketed sections of a resume for a job application. Each section below already contains the candidate's real content (real skills they have, a real summary of their background) - your job is to rewrite/select/reorder/re-emphasize this existing content to best match the target job description, not invent new facts.

The goal is rigorous, PRECISE alignment with the job description - not maximum keyword density. Use natural phrasing, not keyword stuffing. The test for whether a replacement is good: does this read as a natural, precise match to what the job description is actually asking for - not: does this contain the maximum number of matched keywords. Nothing outside these listed sections is being touched at all (Professional Experience, Education, and Projects stay word-for-word identical no matter what) - your only job is making these specific sections as precisely relevant as possible.

STRICT no-fabrication rule: only use skills, tools, technologies, and claims that already appear - verbatim or near-verbatim - somewhere in the candidate's full resume, their own screening-question answers, or the section's current content (all provided below). Do NOT upgrade a generic category into a specific named product just because the job description asks for that product unless that specific product is actually confirmed in the resume or screening answers: e.g. if nothing below ever names a specific CRM, do not write "Salesforce" even though the job wants Salesforce - keep the generic category the candidate's background actually supports. If something IS specifically confirmed below (even if it's not in the section's current wording), you should surface it when relevant - this rule is about not inventing things, not about being needlessly generic when specifics are genuinely available. If you are not sure whether something is genuinely grounded, leave it out rather than guess.

Surface the most SPECIFIC true match, not generic framing: when the job description specifically emphasizes systems administration, IT infrastructure, endpoint/device management, or hands-on technical systems management, and the candidate's full resume genuinely contains that kind of experience (for example a System Administrator role - device/endpoint management, Intune, Google Admin, network infrastructure), the Professional Summary should reference that concrete real experience explicitly rather than falling back on vague "systems-minded" phrasing. It's a stronger, more precise, and fully truthful match. Only do this when that experience actually appears in the resume below; never invent it, and don't force it in when the job isn't actually about those things.

Terminology consistency: whenever the candidate's CRM background is referenced in a skills list, write it as exactly "CRM Platform Experience" (not "CRM", "CRM Platforms", "CRM Software", etc.) so it reads identically across the Technical Skills and Core Competencies sections.

Never leave a section byte-for-byte identical to its current content as a default/safe choice - "no fabrication" means don't invent new facts, it does not mean "don't bother tailoring this one." At minimum, reorder/re-emphasize using what's already there (see the [LIST] notes below for sections where this applies); only genuinely identical output when the current content already happens to be the precise best fit for this job.

For each section:
- PRIMARY signal for what's being asked: the section header and surrounding paragraph text.
- The section's current content is real material to draw from - tailor it, don't discard it wholesale.
- SUPPORTING/fallback context only (for grounding facts, not primary intent): the candidate's full resume and screening answers below.
- Target roughly the same length as the current content unless told otherwise below - the output must fit the original page layout, which is verified separately after this.
- Follow any [LIST] or [MUST PRESERVE] notes attached to a specific section exactly.

Job description:
${jobDescription.slice(0, 4000)}

Candidate's full resume (supporting context):
${fullResumeText}${qaBlock}

Sections to tailor:
${placeholdersBlock}`,
      },
    ],
  });

  const toolUse = message.content.find((b): b is Anthropic.ToolUseBlock => b.type === "tool_use");
  const input = toolUse?.input as { replacements: { index: number; text: string }[] } | undefined;
  const result = placeholders.map((p) => p.originalContent);
  for (const r of input?.replacements ?? []) {
    if (r.index >= 0 && r.index < result.length && r.text) result[r.index] = r.text;
  }
  // Deterministic terminology normalization: guarantee the CRM wording is
  // identical across the skills sections and across runs, no matter how the
  // LLM phrased it (see normalizeCrmTerminology).
  for (let i = 0; i < placeholders.length; i++) {
    if (isSkillsSection(placeholders[i])) result[i] = normalizeCrmTerminology(result[i]);
  }
  return result;
}

const EXTRACT_TOOL: Anthropic.Tool = {
  name: "extract_company_role",
  description: "Extract a clean, human-readable company name and role title from a job description.",
  input_schema: {
    type: "object",
    properties: {
      company: { type: "string", description: "The hiring company's name only, e.g. 'Samsara' - no legal suffixes like Inc." },
      role: { type: "string", description: "The job title being applied for, cleaned of any location/employment-type text run together with it, e.g. 'Partner Operations Analyst'." },
    },
    required: ["company", "role"],
  },
};

async function extractCompanyAndRole(anthropic: Anthropic, jobDescription: string, scrapedTitle: string): Promise<{ company: string; role: string }> {
  const message = await anthropic.messages.create({
    model: MODEL,
    max_tokens: 256,
    tools: [EXTRACT_TOOL],
    tool_choice: { type: "tool", name: "extract_company_role" },
    messages: [
      {
        role: "user",
        content: `Scraped job title (may have location or other text run directly onto it with no separator): "${scrapedTitle}"\n\nJob description:\n${jobDescription.slice(0, 3000)}\n\nExtract the clean company name and role title.`,
      },
    ],
  });
  const toolUse = message.content.find((b): b is Anthropic.ToolUseBlock => b.type === "tool_use");
  const input = toolUse?.input as { company?: string; role?: string } | undefined;
  return { company: input?.company || "Company", role: input?.role || scrapedTitle || "Role" };
}

function sanitizeFilenamePart(s: string): string {
  return s
    .replace(/[<>:"/\\|?*\x00-\x1F]/g, "")
    .trim()
    .replace(/\s+/g, "_");
}

async function readDocumentXml(docxPath: string): Promise<{ zip: JSZip; xml: string }> {
  const buf = await readFile(docxPath);
  const zip = await JSZip.loadAsync(buf);
  const file = zip.file("word/document.xml");
  if (!file) throw new Error(`"${docxPath}" doesn't look like a valid .docx (no word/document.xml found).`);
  const xml = await file.async("string");
  return { zip, xml };
}

async function writeDocxWithXml(zip: JSZip, xml: string, outPath: string): Promise<void> {
  zip.file("word/document.xml", xml);
  const buf = await zip.generateAsync({ type: "nodebuffer" });
  await writeFile(outPath, buf);
}

/**
 * Renders a .docx to PDF via real Word (COM automation, through a small
 * PowerShell helper), rather than an approximation - font metrics, margins,
 * and line spacing all affect actual page breaks, so this is the only way
 * to know the true page count.
 */
async function docxToPdf(docxPath: string, pdfPath: string): Promise<void> {
  const scriptPath = path.join(import.meta.dirname, "..", "scripts", "docx-to-pdf.ps1");
  await execFileAsync("powershell.exe", ["-NoProfile", "-ExecutionPolicy", "Bypass", "-File", scriptPath, "-DocxPath", docxPath, "-PdfPath", pdfPath], {
    timeout: 60000,
  });
}

async function getPdfPageCount(pdfPath: string): Promise<number> {
  const buf = await readFile(pdfPath);
  const pdf = await PDFDocument.load(buf);
  return pdf.getPageCount();
}

export interface ResumeGenerationResult {
  path: string;
  pageCount: number;
  originalPageCount: number;
  converged: boolean;
  attempts: number;
}

const MAX_ATTEMPTS = 4;

/**
 * Tailors a bracketed+italicized .docx resume template to a specific job,
 * verifying the result renders to the same page count as the original
 * before saving it. Returns null if the template has no detected
 * placeholders (nothing to tailor - e.g. a plain .txt resume upstream).
 */
export async function generateTailoredResume(
  anthropic: Anthropic,
  templatePath: string,
  jobDescription: string,
  scrapedJobTitle: string,
  fullResumeText: string,
  resumeName: string,
  outDir: string,
  qaContext = ""
): Promise<ResumeGenerationResult | null> {
  const { zip, xml } = await readDocumentXml(templatePath);
  const placeholders = detectPlaceholders(xml);
  if (placeholders.length === 0) return null;

  const tmpDir = await mkdtemp(path.join(os.tmpdir(), "seekr-resume-"));
  try {
    const originalPdfPath = path.join(tmpDir, "original.pdf");
    await docxToPdf(templatePath, originalPdfPath);
    const originalPageCount = await getPdfPageCount(originalPdfPath);

    let feedback: string | undefined;
    let bestXml = xml;
    let bestPageCount = -1;
    let converged = false;
    let attemptsUsed = 0;

    for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
      attemptsUsed = attempt;
      const replacements = await generateReplacements(anthropic, placeholders, jobDescription, fullResumeText, qaContext, feedback);
      const candidateXml = applyReplacements(xml, placeholders, replacements);

      const candidateDocxPath = path.join(tmpDir, `attempt-${attempt}.docx`);
      const candidatePdfPath = path.join(tmpDir, `attempt-${attempt}.pdf`);
      await writeDocxWithXml(zip, candidateXml, candidateDocxPath);
      await docxToPdf(candidateDocxPath, candidatePdfPath);
      const pageCount = await getPdfPageCount(candidatePdfPath);

      if (bestPageCount === -1 || Math.abs(pageCount - originalPageCount) < Math.abs(bestPageCount - originalPageCount)) {
        bestXml = candidateXml;
        bestPageCount = pageCount;
      }

      if (pageCount === originalPageCount) {
        converged = true;
        break;
      }

      const diff = pageCount - originalPageCount;
      feedback =
        diff > 0
          ? `Attempt ${attempt} produced ${pageCount} page(s), but the original template is ${originalPageCount} page(s) - your replacement text was too long and pushed the resume onto an extra page. Write noticeably shorter replacements this time (aim for meaningfully fewer characters than your last attempt). If a section has a [MUST PRESERVE] note, trim other sections first rather than cutting that reference entirely - only shorten or drop it as a last resort if there's truly no other way to fit.`
          : `Attempt ${attempt} produced ${pageCount} page(s), but the original template is ${originalPageCount} page(s) - your replacement text was too short and left extra blank space. Write somewhat longer, more detailed replacements this time.`;
    }

    const { company, role } = await extractCompanyAndRole(anthropic, jobDescription, scrapedJobTitle);
    const nameParts = resumeName.split(/\s+/).filter(Boolean);
    const namePart = sanitizeFilenamePart(nameParts.length > 1 ? `${nameParts[0]} ${nameParts[nameParts.length - 1]}` : resumeName || "Candidate");
    const filename = `${namePart}_Resume_${sanitizeFilenamePart(company)}_${sanitizeFilenamePart(role)}.docx`;
    const finalPath = path.join(outDir, filename);

    await writeDocxWithXml(zip, bestXml, finalPath);

    return { path: finalPath, pageCount: bestPageCount, originalPageCount, converged, attempts: attemptsUsed };
  } finally {
    await rm(tmpDir, { recursive: true, force: true }).catch(() => {});
  }
}
