/**
 * Reading a board that answers from Azure AI Search.
 *
 * The service is stood in for by intercepting the REAL endpoint URL rather
 * than running a local server on some other host: detection keys on the
 * `*.search.windows.net/indexes/<name>/docs/search` shape, so a stand-in
 * reachable at 127.0.0.1 is correctly not recognised - which is how the
 * first version of this spec managed to fail while the code was right.
 *
 * What the stand-in reproduces, measured on Kforce:
 *
 *   POST kforcewebeast.search.windows.net/indexes/kforcewebjobentity/docs/search
 *   { "filter":"(State eq 'GA')", "skip":0, "top":25, "count":true }
 *   -> 403 unless an api-key HEADER is present
 *   -> { "@odata.count": 30, "value":[ { Title, City, State, ApplyUrl } ] }
 *
 * Three faults had to be fixed before that board returned anything, and
 * every one of them failed SILENTLY - an empty board with nothing to say
 * why:
 *
 *   1. the endpoint was not recognised at all (Algolia only)
 *   2. the replay was refused 403, because Azure wants its key in a header
 *      where Algolia puts it in the query string
 *   3. every row then mapped to null, because the field lists were
 *      camelCase and Azure returns PascalCase
 *
 * Fixing any two of the three still produced zero jobs, which is why each
 * is pinned separately.
 *
 *   npm run test:azure
 */
import { chromium } from "playwright";
import {
  indexNameFor,
  looksLikeJobIndex,
  pickEndpoint,
  postingFromHit,
  readSearchIndex,
  searchFlavourFor,
  watchForSearchIndex,
} from "../src/searchIndex.js";

let pass = 0;
let fail = 0;
function check(name: string, ok: boolean, detail = ""): void {
  ok ? pass++ : fail++;
  console.log(`  ${ok ? "PASS" : "FAIL"}  ${name}${ok ? "" : ` — ${detail}`}`);
}

const SEARCH_URL =
  "https://kforcewebeast.search.windows.net/indexes/kforcewebjobentity/docs/search?api-version=2016-09-01";
const BOARD_URL = "https://www.kforce.com/find-work/search-jobs/";
const API_KEY = "test-key-not-a-real-credential";
// Deliberately MORE than one read page (HITS_PER_PAGE is 100), so paging
// is genuinely exercised. At 30 rows a single request returned everything
// and the "never advance skip" mutation stayed green - the test could not
// have caught a reader that only ever read page one, which is the whole
// failure being guarded against on a 1,182-job board.
const TOTAL = 250;

/** PascalCase, exactly as the measured index returns it. */
const JOBS = Array.from({ length: TOTAL }, (_, i) => ({
  "@search.score": 1,
  Id: `id-${i}`,
  Title: i === 0 ? "Sr. Application Engineer - SAP Quote-to-Cash" : `Georgia Role ${i}`,
  City: i % 2 === 0 ? "Atlanta" : "Oakwood",
  State: "GA",
  Zip: "30301",
  Responsibilities: "Long description text ".repeat(20),
  Skills: "SAP, SQL",
  ApplyUrl: `https://www.kforce.com/Jobs/${i}/ApplyOnline/?event=candidate.apply`,
}));

console.log("recognising the endpoint");
{
  check("THE BUG: an Azure search URL is recognised at all", searchFlavourFor(SEARCH_URL) === "azure");
  check(
    "Algolia is still recognised as Algolia",
    searchFlavourFor("https://x-dsn.algolia.net/1/indexes/*/queries?x-algolia-api-key=k") === "algolia"
  );
  check("the board's own page is neither", searchFlavourFor(BOARD_URL) === null);
  check(
    "a look-alike on another host is not taken for the service",
    searchFlavourFor("http://127.0.0.1:8080/indexes/x/docs/search") === null
  );
  check(
    "the index name comes out of the Azure path",
    indexNameFor("", SEARCH_URL) === "kforcewebjobentity",
    String(indexNameFor("", SEARCH_URL))
  );
  check("...and it reads as a job index", looksLikeJobIndex("kforcewebjobentity"));
  check(
    "Azure's page size is read from `top`, not `hitsPerPage`",
    // A query asking for no hits is a facet count, not the board's view -
    // the rule has to see Azure's spelling of the same thing.
    pickEndpoint(null, { url: SEARCH_URL, indexName: "kforcewebjobentity", flavour: "azure", hitsPerPage: 0 }) === null
  );
}

console.log("\nmapping a PascalCase hit");
{
  const mapped = postingFromHit(JOBS[0]);
  check("THE BUG: a PascalCase hit is not dropped", mapped !== null, JSON.stringify(mapped));
  check("Title becomes the title", mapped?.title === "Sr. Application Engineer - SAP Quote-to-Cash", mapped?.title ?? "");
  check("ApplyUrl becomes the url", !!mapped?.url.startsWith("https://www.kforce.com/Jobs/0/"), mapped?.url ?? "");
  check(
    "THE TRAP: City and State read as one place, not two",
    // Collecting them like multi-location variants would say
    // "Atlanta / GA", which looks like a role open in two cities.
    mapped?.location === "Atlanta, GA",
    mapped?.location ?? ""
  );
  check(
    "a camelCase hit still maps, so Algolia is unaffected",
    postingFromHit({ name: "Analyst", url: "https://example.com/jobs/1", locationNames: ["Remote (US)"] })?.location ===
      "Remote (US)"
  );
}

const browser = await chromium.launch();

console.log("\nreading the whole index");
{
  const page = await browser.newPage();
  let refusals = 0;
  const bodies: Record<string, unknown>[] = [];

  await page.route(SEARCH_URL.split("?")[0] + "**", async (route) => {
    const request = route.request();
    const cors = {
      "Access-Control-Allow-Origin": "*",
      "Access-Control-Allow-Headers": "api-key, content-type",
      "Access-Control-Allow-Methods": "POST, OPTIONS",
    };
    if (request.method() === "OPTIONS") {
      await route.fulfill({ status: 204, headers: cors });
      return;
    }
    // Azure refuses a request with no api-key header - the fault that made
    // the first reader return zero rows and report nothing.
    if (request.headers()["api-key"] !== API_KEY) {
      refusals++;
      await route.fulfill({ status: 403, headers: cors, contentType: "application/json", body: '{"error":"forbidden"}' });
      return;
    }
    const body = JSON.parse(request.postData() || "{}");
    bodies.push(body);
    const skip = Number(body.skip) || 0;
    const top = Number(body.top) || 25;
    // The filter is honoured, so a test can prove it travelled.
    const pool = /State eq 'GA'/.test(String(body.filter ?? "")) ? JOBS : JOBS.slice(0, 5);
    await route.fulfill({
      status: 200,
      headers: cors,
      contentType: "application/json",
      body: JSON.stringify({ "@odata.count": pool.length, value: pool.slice(skip, skip + top) }),
    });
  });

  // The board itself: a page that issues its own query, as Kforce's does.
  await page.route(BOARD_URL, (route) =>
    route.fulfill({
      status: 200,
      contentType: "text/html",
      body: `<!doctype html><html><body><p>25 of ${TOTAL} jobs</p><script>
        fetch(${JSON.stringify(SEARCH_URL)}, {
          method: "POST",
          headers: { "Content-Type": "application/json", "api-key": ${JSON.stringify(API_KEY)} },
          body: JSON.stringify({ count: true, search: "", filter: "(State eq 'GA')", skip: 0, top: 25 })
        }).catch(function () {});
      </script></body></html>`,
    })
  );

  const watcher = watchForSearchIndex(page);
  await page.goto(BOARD_URL, { waitUntil: "networkidle" }).catch(() => {});
  await page.waitForTimeout(700);

  const endpoint = watcher.found();
  check("the board's own query is captured", endpoint !== null);
  check("captured as azure", endpoint?.flavour === "azure", String(endpoint?.flavour));
  check("THE BUG: the api-key header is carried", !!endpoint?.apiKey, endpoint?.apiKey ? "present" : "missing");
  check(
    "the board's filter travels with it",
    String((endpoint?.query as Record<string, unknown>)?.filter) === "(State eq 'GA')",
    String((endpoint?.query as Record<string, unknown>)?.filter)
  );

  if (endpoint) {
    refusals = 0;
    bodies.length = 0;
    const read = await readSearchIndex(page, endpoint);
    check(`all ${TOTAL} rows are read, across several requests`, read.rows === TOTAL, String(read.rows));
    check("and every row maps to a posting", read.postings.length === TOTAL, String(read.postings.length));
    check("THE BUG: nothing was refused for a missing key", refusals === 0, `${refusals} refusal(s)`);
    check("every posting has a location", read.postings.every((p) => /, GA$/.test(p.location)));
    check(
      "the filter was sent on every request, not just the first",
      bodies.length > 0 && bodies.every((b) => String(b.filter) === "(State eq 'GA')"),
      JSON.stringify(bodies.map((b) => b.filter))
    );
  }
  watcher.stop();
  await page.close();
}

await browser.close();
console.log(`\n${"-".repeat(70)}`);
console.log(fail ? `${pass} passed, ${fail} FAILED` : `${pass} passed, 0 failed - an Azure-backed board is read in full`);
process.exit(fail ? 1 : 0);
