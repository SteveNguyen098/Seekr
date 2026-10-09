/**
 * The pure half of the search-index reader: which field is the title, which
 * is the URL, and how a role indexed once per location collapses back into
 * one posting.
 *
 * Hit shapes here are the ones measured on the live index (keys exactly as
 * returned: department, departmentName, isRemote, jobId, locationNames,
 * locations, name, url, objectID), including the leading and trailing
 * spaces its `name` values actually carry.
 */
import {
  type EndpointCandidate,
  indexNameFor,
  looksLikeJobIndex,
  mergeLocationVariants,
  pickEndpoint,
  postingFromHit,
  queryBodyFor,
} from "../src/searchIndex.js";
import { coverageShortfall } from "../src/scrape.js";

let passed = 0;
let failed = 0;

function check(name: string, ok: boolean, detail = ""): void {
  ok ? passed++ : failed++;
  console.log(`  ${ok ? "PASS" : "FAIL"}  ${name}${ok ? "" : ` — ${detail}`}`);
}

console.log("indexNameFor");
{
  const multi = '{"requests":[{"indexName":"careers_en-US_production","hitsPerPage":50}]}';
  check(
    "reads the index out of the multi-query body",
    indexNameFor(multi, "https://6fnax3tbef-dsn.algolia.net/1/indexes/*/queries?x-algolia-api-key=k") ===
      "careers_en-US_production",
    String(indexNameFor(multi, "https://x/1/indexes/*/queries"))
  );
  check(
    "reads it out of the single-query body",
    indexNameFor('{"indexName":"jobs_prod","query":""}', "https://x/1/indexes/*/queries") === "jobs_prod"
  );
  check(
    "falls back to the URL path when the body names nothing",
    indexNameFor("", "https://x-dsn.algolia.net/1/indexes/careers_prod/query") === "careers_prod",
    String(indexNameFor("", "https://x-dsn.algolia.net/1/indexes/careers_prod/query"))
  );
  check(
    "THE TRAP: the multi-query path names no index, so the wildcard is not taken as one",
    indexNameFor("not json", "https://x-dsn.algolia.net/1/indexes/*/queries") === null,
    String(indexNameFor("not json", "https://x-dsn.algolia.net/1/indexes/*/queries"))
  );
}

console.log("\nqueryBodyFor");
{
  check(
    "reads the query out of the multi-query shape",
    queryBodyFor('{"requests":[{"indexName":"careers","hitsPerPage":0}]}')?.hitsPerPage === 0
  );
  check(
    "reads it out of the bare REST shape",
    queryBodyFor('{"indexName":"careers","hitsPerPage":50}')?.hitsPerPage === 50
  );
  check("a non-JSON body yields nothing", queryBodyFor("not json") === null);
  check("an empty body yields nothing", queryBodyFor("") === null);
}

console.log("\npickEndpoint - replaying the measured query trace");
{
  // Arrival order exactly as observed on the filtered board, including the
  // facet-count queries interleaved between the filtered ones.
  const trace: EndpointCandidate[] = [
    { url: "https://x-dsn.algolia.net/1/indexes/*/queries", indexName: "careers_en-US_production", hitsPerPage: 50 },
    { url: "https://x-dsn.algolia.net/1/indexes/*/queries", indexName: "careers_en-US_production", hitsPerPage: 50 },
    { url: "https://x-dsn.algolia.net/1/indexes/*/queries", indexName: "careers_en-US_production", hitsPerPage: 50, facetFilters: [["locationNames:Remote"]] },
    { url: "https://x-dsn.algolia.net/1/indexes/*/queries", indexName: "careers_en-US_production", hitsPerPage: 0 },
    { url: "https://x-dsn.algolia.net/1/indexes/*/queries", indexName: "careers_en-US_production", hitsPerPage: 50, facetFilters: [["locationNames:Remote", "locationNames:Remote (United States)"]] },
    { url: "https://x-dsn.algolia.net/1/indexes/*/queries", indexName: "careers_en-US_production", hitsPerPage: 0 },
    { url: "https://x-dsn.algolia.net/1/indexes/*/queries", indexName: "careers_en-US_production", hitsPerPage: 50, facetFilters: [["locationNames:GA", "locationNames:Remote", "locationNames:Remote (United States)"]] },
    { url: "https://x-dsn.algolia.net/1/indexes/*/queries", indexName: "careers_en-US_production", hitsPerPage: 0 },
  ];
  let chosen: ReturnType<typeof pickEndpoint> = null;
  for (const candidate of trace) chosen = pickEndpoint(chosen, candidate);

  check("an endpoint is chosen from the trace", chosen !== null);
  check(
    "THE BUG: the board's filters survive the facet-count query that follows them",
    // Query 8 asks for no hits and carries no filters. Keeping it would
    // return all 625 rows for a board the user had narrowed to 41.
    JSON.stringify(chosen?.facetFilters) ===
      JSON.stringify([["locationNames:GA", "locationNames:Remote", "locationNames:Remote (United States)"]]),
    JSON.stringify(chosen?.facetFilters)
  );

  // The unfiltered board must stay unfiltered, or it would be narrowed by
  // whatever the page happened to query last.
  let bare: ReturnType<typeof pickEndpoint> = null;
  for (const candidate of trace.slice(0, 2)) bare = pickEndpoint(bare, candidate);
  check("an unfiltered board carries no filters", bare?.facetFilters === undefined, JSON.stringify(bare?.facetFilters));

  check(
    "a non-job index never displaces a job one",
    pickEndpoint(
      { url: "https://x/1/indexes/*/queries", indexName: "careers_prod" },
      { url: "https://y/1/indexes/*/queries", indexName: "blog_prod", hitsPerPage: 20 }
    )?.indexName === "careers_prod"
  );
  check(
    "a facet-count query alone yields no endpoint at all",
    pickEndpoint(null, { url: "https://x/1/indexes/*/queries", indexName: "careers_prod", hitsPerPage: 0 }) === null
  );
}

console.log("\nlooksLikeJobIndex");
{
  check(
    "THE BUG: the measured index is accepted - 'production' contains 'product'",
    // An unanchored "product" match rejected careers_en-US_production, the
    // one index that mattered, so the reader silently did not run and the
    // scan fell back to reading 30 postings off the DOM.
    looksLikeJobIndex("careers_en-US_production") === true
  );
  check("a jobs index is accepted", looksLikeJobIndex("jobs_prod") === true);
  check("an unfamiliar but harmless name is accepted", looksLikeJobIndex("listings_v2") === true);
  check(
    "THE TRAP: a 'production' suffix is not read as 'product' when no job word rescues it",
    // Distinct from the case above: "careers_en-US_production" is accepted
    // on the strength of "career" alone, so it passes whether or not the
    // disqualifying words are anchored. This name has no job word in it, so
    // it is the only one that actually tests the anchoring.
    looksLikeJobIndex("listings_production") === true
  );
  check("the site's blog index is not read as a board", looksLikeJobIndex("blog_en-US_production") === false);
  check("its docs index is not read as a board", looksLikeJobIndex("docs_production") === false);
  check(
    "a product index is still rejected when the word stands alone",
    looksLikeJobIndex("product_catalog") === false
  );
  check(
    "but a job-shaped name wins over a disqualifying word beside it",
    looksLikeJobIndex("product_designer_roles") === true
  );
}

console.log("\npostingFromHit");
{
  const measured = {
    department: "sales",
    departmentName: "Sales",
    isRemote: false,
    jobId: "ef0b7266-678c-4a23-a439-1a5e7362b604",
    locationNames: ["AR"],
    locations: [{ name: "AR" }],
    name: " Account Executive, Broker Channel (Arkansas) ",
    url: "https://ats.rippling.com/rippling/jobs/ef0b7266-678c-4a23-a439-1a5e7362b604",
    objectID: "ef0b7266-678c-4a23-a439-1a5e7362b604__ar",
  };
  const posting = postingFromHit(measured);
  check("title comes from `name`, trimmed", posting?.title === "Account Executive, Broker Channel (Arkansas)", `"${posting?.title}"`);
  check("url is the posting's own absolute url", posting?.url === measured.url, posting?.url ?? "");
  check("location comes from the index, not from card text", posting?.location === "AR", posting?.location ?? "");

  check(
    "a title-shaped key other than `name` is still found",
    postingFromHit({ title: "Staff Engineer", applyUrl: "https://example.com/jobs/1" })?.title === "Staff Engineer"
  );
  check(
    "an object-shaped location field is read through to its name",
    postingFromHit({ name: "Analyst", url: "https://example.com/jobs/2", locations: [{ name: "Austin, TX" }] })
      ?.location === "Austin, TX",
    String(postingFromHit({ name: "Analyst", url: "https://example.com/jobs/2", locations: [{ name: "Austin, TX" }] })?.location)
  );

  // Null is what lets the caller fall back to DOM scraping instead of
  // reporting an empty board, so the shapes that must return it matter as
  // much as the ones that must not.
  check("a hit with no recognisable title is rejected", postingFromHit({ url: "https://example.com/jobs/3" }) === null);
  check("a hit with no url is rejected", postingFromHit({ name: "Analyst" }) === null);
  check(
    "a relative url is rejected rather than queued as a bad link",
    postingFromHit({ name: "Analyst", url: "/jobs/4" }) === null,
    JSON.stringify(postingFromHit({ name: "Analyst", url: "/jobs/4" }))
  );
  check(
    "an index of something other than jobs yields nothing usable",
    postingFromHit({ headline: "How to run payroll", slug: "/blog/payroll" }) === null
  );
}

console.log("\nmergeLocationVariants");
{
  // The measured index reports 625 rows for 348 postings: a role open in
  // several places is indexed once per location.
  const sameRoleThreePlaces = [
    { title: "Account Executive, Broker Channel", url: "https://ats.example.com/jobs/aaa", location: "AR" },
    { title: "Account Executive, Broker Channel", url: "https://ats.example.com/jobs/aaa", location: "Remote (United States)" },
    { title: "Account Executive, Broker Channel", url: "https://ats.example.com/jobs/aaa", location: "GA" },
    { title: "Staff Engineer, Platform", url: "https://ats.example.com/jobs/bbb", location: "Bangalore, India" },
  ];
  const merged = mergeLocationVariants(sameRoleThreePlaces);
  check("variants of one role collapse to one posting", merged.length === 2, `got ${merged.length}`);

  const ae = merged.find((m) => m.url.endsWith("aaa"));
  check(
    "THE BUG: every location is kept, not just the first",
    ["AR", "Remote (United States)", "GA"].every((l) => ae!.location.includes(l)),
    ae?.location ?? ""
  );
  check(
    "so a role open remotely is not mistaken for an on-site-only one",
    /Remote \(United States\)/.test(ae!.location),
    ae?.location ?? ""
  );
  check("a repeated location is not repeated in the output", mergeLocationVariants([
    { title: "A", url: "https://x/jobs/1", location: "GA" },
    { title: "A", url: "https://x/jobs/1", location: "GA" },
  ])[0].location === "GA");
}

console.log("\ncoverageShortfall");
{
  check(
    "THE TRAP: a complete index read is not reported as a shortfall",
    // 625 rows read, 625 stated, collapsing to 348 postings. Comparing the
    // POSTING count against the stated total would announce a 277-posting
    // gap on a board that was read in full.
    coverageShortfall(625, 625) === null,
    String(coverageShortfall(625, 625))
  );
  check(
    "THE BUG: 26 of 625 is reported",
    (coverageShortfall(26, 625) ?? "").includes("625") && (coverageShortfall(26, 625) ?? "").includes("26"),
    String(coverageShortfall(26, 625))
  );
  check("a board stating no total reports nothing", coverageShortfall(26, null) === null);
  check("Greenhouse's full walk of its stated 193 is silent", coverageShortfall(193, 193) === null);
  check("a near-complete read is within tolerance", coverageShortfall(190, 193) === null, String(coverageShortfall(190, 193)));
  check("reading more than the board claims is not a shortfall", coverageShortfall(50, 41) === null);
}

console.log("\n" + "-".repeat(70));
console.log(`${passed} passed, ${failed} failed - a partial board cannot pass as a complete one`);
if (failed > 0) process.exit(1);
