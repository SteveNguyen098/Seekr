import { readFile } from "node:fs/promises";
import path from "node:path";

export interface UserProfile {
  address?: string;
  city?: string;
  county?: string;
  state?: string;
  zip?: string;
  country?: string;
  phoneCountryCode?: string;
  phoneNumber?: string;
  /**
   * The institution name for an education section's "School" field.
   *
   * Here rather than left to the model: a live SpaceX run answered
   * "Arizona State University" while the resume said Georgia State. A
   * school is a fixed fact about a person, so it belongs with the other
   * fixed facts and should never be generated at all.
   */
  school?: string;
  /**
   * The credential for an education section's "Degree" field, written the
   * way the resume states it ("Bachelor of Business Administration").
   *
   * Dropdowns rarely offer that exact phrasing, so the fill path falls
   * back to the generic level for the list in front of it - see
   * genericDegreeOptions. Store the truth here; the generalising happens
   * at fill time, where the real options are known.
   */
  degree?: string;
  /**
   * The field of study for an education section's "Discipline" / "Major"
   * field, written as the resume states it.
   *
   * Last of the three education facts to stop being generated. A live run
   * answered this with "Program Management" - the job's own title - rather
   * than the candidate's actual subject, which the resume states plainly.
   */
  discipline?: string;
  /**
   * When the candidate started and finished their studies, as "August 2019"
   * / "December 2023".
   *
   * Here rather than inferred, for two reasons. A live LTS run answered an
   * education section's "Start date" with a JOB's dates. And even reading
   * the section correctly would not have helped: the resume states a
   * graduation date and no start date at all, so the start was never
   * recoverable from it.
   */
  educationStart?: string;
  educationEnd?: string;
}

export interface PersonalContext {
  profile: UserProfile;
  qaContext: string;
  workAuthContext: string;
}

async function readOptional(filePath: string): Promise<string> {
  return readFile(filePath, "utf-8").catch(() => "");
}

const PROFILE_KEYS: Record<string, keyof UserProfile> = {
  address: "address",
  city: "city",
  county: "county",
  state: "state",
  zip: "zip",
  country: "country",
  "phone country code": "phoneCountryCode",
  "phone number": "phoneNumber",
  school: "school",
  university: "school",
  degree: "degree",
  discipline: "discipline",
  major: "discipline",
  "education start": "educationStart",
  "education end": "educationEnd",
};

function parseProfile(text: string): UserProfile {
  const profile: UserProfile = {};
  for (const line of text.split("\n")) {
    const sep = line.indexOf(":");
    if (sep === -1) continue;
    const key = line.slice(0, sep).trim().toLowerCase();
    const value = line.slice(sep + 1).trim();
    const field = PROFILE_KEYS[key];
    if (field && value) profile[field] = value;
  }
  return profile;
}

/**
 * Loads the optional personal-context files a user can drop into the mvp
 * folder: user_profile.txt (contact/location, Key: Value format),
 * qa_context.txt (canned answers for common screening questions), and
 * work_auth_context.txt (citizenship/sponsorship ground truth). All three
 * are gitignored - they're never meant to leave this machine. Missing
 * files degrade gracefully to empty values rather than failing the run.
 */
export async function loadPersonalContext(mvpDir: string): Promise<PersonalContext> {
  const [profileText, qaContext, workAuthContext] = await Promise.all([
    readOptional(path.join(mvpDir, "user_profile.txt")),
    readOptional(path.join(mvpDir, "qa_context.txt")),
    readOptional(path.join(mvpDir, "work_auth_context.txt")),
  ]);
  return { profile: parseProfile(profileText), qaContext, workAuthContext };
}
