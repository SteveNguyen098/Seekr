import { readFile } from "node:fs/promises";
import path from "node:path";
import mammoth from "mammoth";

export interface Resume {
  text: string;
  name: string;
  email: string;
  phone: string;
  location: string;
}

const EMAIL_RE = /[\w.+-]+@[\w-]+\.[\w.-]+/;
const PHONE_RE = /(\+?1[\s.-]?)?\(?\d{3}\)?[\s.-]?\d{3}[\s.-]?\d{4}/;

export async function loadResume(filePath: string): Promise<Resume> {
  const ext = path.extname(filePath).toLowerCase();
  let text: string;

  if (ext === ".docx") {
    const { value } = await mammoth.extractRawText({ path: filePath });
    text = value;
  } else if (ext === ".txt" || ext === ".md") {
    text = await readFile(filePath, "utf-8");
  } else {
    throw new Error(`Unsupported resume format "${ext}". Use .docx or .txt for this POC.`);
  }

  text = text.replace(/\r\n/g, "\n").trim();
  if (!text) {
    throw new Error(`Resume file "${filePath}" parsed to empty text.`);
  }

  const email = text.match(EMAIL_RE)?.[0] ?? "";
  const phone = text.match(PHONE_RE)?.[0] ?? "";
  // Name is conventionally the first non-empty line of a resume.
  const name = text.split("\n").find((line) => line.trim().length > 0)?.trim() ?? "";
  // Look for a "City, ST" style token on the first few lines (header/contact block).
  const location = text.split("\n").slice(0, 5).join(" ").match(/[A-Z][a-zA-Z]+,\s?[A-Z]{2}\b/)?.[0] ?? "";

  return { text, name, email, phone, location };
}
