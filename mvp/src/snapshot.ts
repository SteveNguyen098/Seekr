import type { Page } from "playwright";
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";

/**
 * Freezes the open application form to a single MHTML file, for the
 * regression corpus replayed by test/snapshots.spec.mts.
 *
 * Captured through the real pipeline rather than by a standalone "go fetch
 * this URL" script, and deliberately so: the DOM worth freezing does not
 * exist at the job URL. It only appears once openApplicationForm() has
 * dismissed the cookie banner and clicked past whatever decoy Apply control
 * the platform ships. A separate capture tool would have to reimplement that
 * path and would drift from the one that actually runs.
 *
 * MHTML rather than page.content(): it inlines subresources AND subframes in
 * one file, which is what the two hardest cases need -
 *   - stylesheets, because required-detection falls back to a CSS-painted
 *     ::after asterisk. Capture without CSS and that check does not fail, it
 *     passes while testing nothing.
 *   - subframes, because an embedded ATS keeps the entire form in a
 *     cross-origin iframe and page.content() returns only the main document.
 * Both were measured round-tripping intact before this was built.
 *
 * Called BEFORE any field is filled, so a snapshot never contains the
 * candidate's personal data - it is the empty form, as served.
 */
export async function captureFormSnapshot(
  page: Page,
  snapshotRoot: string,
  jobUrl: string,
  jobTitle: string
): Promise<string | null> {
  try {
    const slug = buildSlug(jobUrl, jobTitle);
    const dir = path.resolve(snapshotRoot, slug);
    await mkdir(dir, { recursive: true });

    const cdp = await page.context().newCDPSession(page);
    const { data } = (await cdp.send("Page.captureSnapshot", { format: "mhtml" })) as { data: string };
    await cdp.detach().catch(() => {});

    await writeFile(path.join(dir, "page.mhtml"), data, "utf-8");
    await writeFile(
      path.join(dir, "meta.json"),
      JSON.stringify(
        {
          sourceUrl: jobUrl,
          formUrl: page.url(),
          jobTitle,
          capturedAt: new Date().toISOString(),
          // Filled in by hand when a snapshot is kept because it broke
          // something. An unexplained snapshot is one nobody dares delete
          // and nobody can interpret later.
          guards: "",
        },
        null,
        2
      ) + "\n",
      "utf-8"
    );
    return dir;
  } catch (err) {
    // Never fail a real application run over a test artifact.
    console.log(`  -> WARNING: could not capture form snapshot (${(err as Error).message})`);
    return null;
  }
}

function buildSlug(jobUrl: string, jobTitle: string): string {
  let host = "";
  try {
    host = new URL(jobUrl).hostname.replace(/^www\./, "").split(".")[0];
  } catch {
    /* not a parseable URL - fall back to the title alone */
  }
  const clean = (s: string) =>
    s
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-+|-+$/g, "")
      .slice(0, 60);
  return [clean(host), clean(jobTitle)].filter(Boolean).join("-") || "snapshot";
}
