/**
 * Walking a multi-page board, against a local server rather than the live
 * internet - because the thing under test is how the walk responds to a
 * board's PAGINATION CONVENTION, and that cannot be reproduced with static
 * files: the same URL has to answer differently per ?page=N.
 *
 * Three real behaviours, all measured on live boards before being
 * reproduced here:
 *
 *   zero-based     Rippling ATS (RAS Legal Group): page=0 is the first
 *                  page, 17/20/17/4, and page=4 is empty. A bare URL
 *                  serves page 0, so assuming the Greenhouse convention
 *                  silently dropped its first page - 17 of 58 scanned.
 *   one-based      Greenhouse (Sony): page=1 is the first page, and page=0
 *                  serves the same content as page=1.
 *   ignores it     Lever (Match Group): 68 postings at page=0, 1 and 2
 *                  alike. Without a second stop condition this board would
 *                  be fetched MAX_BOARD_PAGES times to learn nothing.
 *
 *   npm run test:pagination
 */
import { createServer, type Server } from "http";
import { chromium } from "playwright";
import { coverageShortfall, listJobs } from "../src/scrape.js";

let pass = 0;
let fail = 0;
function check(name: string, ok: boolean, detail = ""): void {
  ok ? pass++ : fail++;
  console.log(`  ${ok ? "PASS" : "FAIL"}  ${name}${ok ? "" : ` — ${detail}`}`);
}

/** Pages of posting slugs, keyed by the page number the board serves them at. */
const ZERO_BASED: Record<number, string[]> = {
  0: ["accounts-payable-coordinator", "junior-staff-accountant", "payroll-assistant"],
  1: ["associate-attorney-missouri", "appellate-attorney", "paralegal"],
  2: ["title-curative-specialist", "legal-assistant"],
};
const ONE_BASED: Record<number, string[]> = {
  1: ["sales-operations-senior-executive", "technical-artist", "producer"],
  2: ["qa-analyst", "community-manager"],
};
const IGNORES = ["engineer", "designer", "recruiter", "analyst"];

function boardHtml(slugs: string[], statedTotal: number): string {
  const rows = slugs
    .map((s) => `<a href="/jobs/${s}"><div>${s.replace(/-/g, " ")}</div><div>Remote</div></a>`)
    .join("\n");
  // The pager is text, not links: every board measured renders it as
  // JavaScript buttons with no href, which is why the walk has to build
  // page URLs itself rather than following anything.
  return `<!doctype html><html><head><meta charset="utf-8"><title>Jobs</title></head>
<body><p>${statedTotal} jobs</p><main>${rows}</main><nav>1 2 3</nav></body></html>`;
}

const requests: string[] = [];
const server: Server = createServer((req, res) => {
  requests.push(req.url ?? "");
  const url = new URL(req.url ?? "/", "http://127.0.0.1");
  const asked = Number(url.searchParams.get("page"));
  const hasPage = url.searchParams.has("page") && Number.isInteger(asked);
  res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });

  if (url.pathname === "/zero") {
    // No page parameter serves the first page, which here is page 0.
    const n = hasPage ? asked : 0;
    res.end(boardHtml(ZERO_BASED[n] ?? [], 8));
    return;
  }
  if (url.pathname === "/one") {
    // Out-of-range below the first page clamps up to it, as Greenhouse does.
    const n = !hasPage || asked < 1 ? 1 : asked;
    res.end(boardHtml(ONE_BASED[n] ?? [], 5));
    return;
  }
  if (url.pathname === "/ignores") {
    res.end(boardHtml(IGNORES, 4));
    return;
  }
  res.end("<html><body>not a board</body></html>");
});

await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
const port = (server.address() as { port: number }).port;
const base = `http://127.0.0.1:${port}`;
const browser = await chromium.launch();

async function scan(path: string) {
  requests.length = 0;
  const page = await browser.newPage({ viewport: { width: 1280, height: 900 } });
  const listing = await listJobs(page, `${base}${path}`);
  await page.close();
  return { listing, loads: requests.filter((r) => !r.startsWith("/jobs/")).length };
}

console.log("a zero-based board (Rippling ATS)");
{
  const { listing } = await scan("/zero?page=0");
  const titles = listing.jobs.map((j) => j.url.split("/").pop());
  check("every page is walked, not just the one pasted", listing.jobs.length === 8, `got ${listing.jobs.length}`);
  check(
    "THE BUG: the first page's postings are present",
    titles.includes("accounts-payable-coordinator"),
    titles.join(",")
  );
  check("so are the last page's", titles.includes("legal-assistant"), titles.join(","));
  check("nothing is double-counted", new Set(titles).size === titles.length);
  check("rows matches what was enumerated", listing.rows === 8, String(listing.rows));
  check("the board's stated total is read", listing.statedTotal === 8, String(listing.statedTotal));
  check("and a complete walk reports no shortfall", coverageShortfall(listing.rows, listing.statedTotal) === null);
}

console.log("\nthe same board with no page parameter at all");
{
  const { listing } = await scan("/zero");
  const titles = listing.jobs.map((j) => j.url.split("/").pop());
  check(
    "THE BUG: its first page is not skipped by assuming the other convention",
    listing.jobs.length === 8,
    `got ${listing.jobs.length}: ${titles.join(",")}`
  );
  check("including the page-0 postings", titles.includes("junior-staff-accountant"), titles.join(","));
}

console.log("\na one-based board (Greenhouse)");
{
  const { listing } = await scan("/one?page=1");
  const titles = listing.jobs.map((j) => j.url.split("/").pop());
  check("both pages are walked", listing.jobs.length === 5, `got ${listing.jobs.length}`);
  check("the clamped page=0 request does not duplicate anything", new Set(titles).size === 5);
  check("rows is not inflated by re-read pages", listing.rows === 5, String(listing.rows));
  check("so a complete walk is not reported as a shortfall", coverageShortfall(listing.rows, listing.statedTotal) === null);
}

console.log("\nthe one-based board with no page parameter");
{
  const { listing } = await scan("/one");
  check("still finds both pages", listing.jobs.length === 5, `got ${listing.jobs.length}`);
  check(
    "THE BUG: rows counts distinct postings, not the probe's duplicates",
    // Measured live before this was fixed: Greenhouse with no page
    // parameter reported 256 rows for 206 postings, which would mask a
    // genuine shortfall rather than reveal it.
    listing.rows === 5,
    String(listing.rows)
  );
}

console.log("\na board that ignores the page parameter (Lever)");
{
  const { listing, loads } = await scan("/ignores");
  check("its postings are returned once", listing.jobs.length === 4, `got ${listing.jobs.length}`);
  check(
    "THE BUG: the walk stops instead of fetching MAX_BOARD_PAGES times",
    loads <= 4,
    `${loads} board page loads`
  );
  check("rows is the distinct count, not loads x postings", listing.rows === 4, String(listing.rows));
}

console.log("\na partial board still discloses the gap");
{
  // The stated total exceeds what any page serves - the RAS case, which
  // really does hold 58 of a claimed 65.
  const { listing } = await scan("/zero?page=2");
  check("a walk starting mid-board collects what follows", listing.jobs.length === 2, `got ${listing.jobs.length}`);
  check(
    "and says so against the stated total",
    (coverageShortfall(listing.rows, listing.statedTotal) ?? "").includes("8"),
    String(coverageShortfall(listing.rows, listing.statedTotal))
  );
}

await browser.close();
await new Promise<void>((resolve) => server.close(() => resolve()));

console.log(`\n${"-".repeat(70)}`);
console.log(
  fail ? `${pass} passed, ${fail} FAILED` : `${pass} passed, 0 failed - a multi-page board is walked whichever page it starts at`
);
process.exit(fail ? 1 : 0);
