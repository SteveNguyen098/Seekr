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
