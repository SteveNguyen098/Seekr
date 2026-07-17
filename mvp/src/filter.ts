import type { JobPosting } from "./scrape.js";

export interface Criteria {
  /** Keywords/phrases to match against job titles (case-insensitive substring match). */
  targetTitles: string[];
  /** Skip postings that require more years of experience than this. */
  maxYearsExperience?: number;
  /** Skip postings that list an annual salary below this. */
  minSalaryAnnual?: number;
  /** Skip postings that list an hourly rate below this. */
  minSalaryHourly?: number;
  /** Skip postings that read as pure contract/temp with no full-time conversion path. */
  requireFullTimeOrContractToHire?: boolean;
  /** Keep only postings whose location matches one of these (substring, case-insensitive). Empty/generic locations are never rejected on this basis alone. */
  acceptableLocations?: string[];
}

/** Cheap pass: keep only postings whose title contains one of the target keywords. */
export function filterByTitle(jobs: JobPosting[], criteria: Criteria): JobPosting[] {
  const needles = criteria.targetTitles.map((t) => t.toLowerCase());
  return jobs.filter((job) => {
    const title = job.title.toLowerCase();
    return needles.some((needle) => title.includes(needle));
  });
}

/**
 * Cheap pass: drop postings whose listing location clearly names a specific
 * place (contains a comma, e.g. "Nashville, Tennessee") that doesn't match
 * any accepted location. Generic/empty labels (e.g. "United States") are
 * left alone rather than guessed at - the AI ranking step already reasons
 * about location fit from the full job description.
 */
export function filterByLocation(jobs: JobPosting[], criteria: Criteria): JobPosting[] {
  if (!criteria.acceptableLocations || criteria.acceptableLocations.length === 0) return jobs;
  const needles = criteria.acceptableLocations.map((l) => l.toLowerCase());
  return jobs.filter((job) => {
    const location = job.location.toLowerCase();
    if (!location.trim()) return true;
    if (needles.some((n) => location.includes(n))) return true;
    const looksSpecific = location.includes(",");
    return !looksSpecific;
  });
}

const YEARS_RE =
  /(\d+)\s*(?:\+|-|to)?\s*(?:\d+\s*)?\+?\s*years?(?:\s+of)?\s+(?:relevant\s+|professional\s+)?experience/gi;

function checkYearsOfExperience(text: string, criteria: Criteria): { pass: boolean; reason?: string } {
  if (criteria.maxYearsExperience === undefined) return { pass: true };

  const matches = [...text.matchAll(YEARS_RE)];
  const requiredYears = matches.map((m) => Number(m[1])).filter((n) => Number.isFinite(n));
  if (requiredYears.length === 0) return { pass: true };

  const minRequired = Math.min(...requiredYears);
  if (minRequired > criteria.maxYearsExperience) {
    return {
      pass: false,
      reason: `Requires ${minRequired}+ years of experience (candidate has up to ${criteria.maxYearsExperience})`,
    };
  }
  return { pass: true };
}

const ANNUAL_SALARY_RE = /\$\s?(\d{2,3}),(\d{3})(?:\.\d+)?/g;
const HOURLY_SALARY_RE = /\$\s?(\d{1,3}(?:\.\d{1,2})?)\s?(?:\/|per\s+)\s?(?:hour|hr)\b/gi;

function checkSalary(text: string, criteria: Criteria): { pass: boolean; reason?: string } {
  if (criteria.minSalaryAnnual === undefined && criteria.minSalaryHourly === undefined) return { pass: true };

  if (criteria.minSalaryAnnual !== undefined) {
    const annual = [...text.matchAll(ANNUAL_SALARY_RE)].map((m) => Number(m[1]) * 1000 + Number(m[2]));
    if (annual.length > 0) {
      const min = Math.min(...annual);
      if (min < criteria.minSalaryAnnual) {
        return {
          pass: false,
          reason: `Lists salary as low as $${min.toLocaleString()}/year (floor: $${criteria.minSalaryAnnual.toLocaleString()})`,
        };
      }
    }
  }

  if (criteria.minSalaryHourly !== undefined) {
    const hourly = [...text.matchAll(HOURLY_SALARY_RE)].map((m) => Number(m[1]));
    if (hourly.length > 0) {
      const min = Math.min(...hourly);
      if (min < criteria.minSalaryHourly) {
        return {
          pass: false,
          reason: `Lists pay as low as $${min}/hour (floor: $${criteria.minSalaryHourly}/hour)`,
        };
      }
    }
  }

  return { pass: true };
}

// Deliberately narrow: bare "contract" appears constantly in job
// descriptions with nothing to do with employment type (sales contracts,
// vendor contracts, "contract close" in a sales-cycle sense, etc). Only
// match phrasing that's actually declaring the position itself is
// contract/temporary work.
const CONTRACT_RE =
  /\b(contract|contractor|temporary|temp|freelance)\s+(position|role|basis|employee|assignment|engagement|opportunity)\b|\bfixed[- ]term\b|\b(w-?2|1099)\s+contract\b|\b\d+[- ](month|week)\s+contract\b|employment\s+type:?\s*(contract|temporary)/i;
const CONVERSION_RE =
  /contract[- ]to[- ]hire|temp[- ]to[- ]perm|conversion to (a )?(full[- ]time|permanent)|possibility of (a )?(full[- ]time|permanent)|potential (for )?(full[- ]time|permanent)/i;
const FULL_TIME_RE = /\bfull[- ]time\b/i;

function checkEmploymentType(text: string, criteria: Criteria): { pass: boolean; reason?: string } {
  if (!criteria.requireFullTimeOrContractToHire) return { pass: true };
  // Only act when the posting actually declares itself contract/temp work -
  // most postings don't explicitly say "full-time" either, so absence of
  // both terms isn't itself a signal.
  if (!CONTRACT_RE.test(text)) return { pass: true };
  if (CONVERSION_RE.test(text) || FULL_TIME_RE.test(text)) return { pass: true };
  return { pass: false, reason: "Reads as contract/temporary with no stated full-time conversion path" };
}

/**
 * Regex/keyword pass over a job's full description text: years of
 * experience, salary floor, and employment type. All best-effort heuristics
 * (like the years-of-experience check), not exhaustive natural-language
 * understanding - they can miss requirements phrased unusually.
 */
export function passesHardRequirements(
  descriptionText: string,
  criteria: Criteria
): { pass: boolean; reason?: string } {
  const checks = [
    checkYearsOfExperience(descriptionText, criteria),
    checkSalary(descriptionText, criteria),
    checkEmploymentType(descriptionText, criteria),
  ];
  return checks.find((c) => !c.pass) ?? { pass: true };
}
