import type { Page, Request } from "playwright";
import type { JobPosting } from "./scrape.js";

/**
 * Reads a career board that is a search-index front end rather than a list
 * of links.
 *
 * THE GAP this closes was silent and badly misleading. Rippling's board
 * states "625 roles across all departments in all locations" and renders
 * thirty of them; there is no pager, no load-more control, and scrolling
 * adds nothing (measured: eight scrolls, still thirty). The jobs are not in
 * the HTML at all - curl returns zero job links and the page's 586KB
 * __NEXT_DATA__ holds none of them - because the list is fetched from an
 * Algolia index after hydration.
 *
 * So the DOM scraper collected 26 postings out of 348 distinct ones, and
 * because the index is served in ALPHABETICAL order those 26 were the "A"s:
 * 24 of them Sales. One suggestion came back, which reads as a verdict on
 * the company rather than as 7% coverage.
 *
 * Worse, it looked like it worked. Filtering the board by location in the
 * site's own UI appeared to fix it - but only because narrowing to 41 hits
 * dropped the result set below the page's 50-hit request size, so the whole
 * filtered board happened to render at once. The user was being asked to
 * hand-assemble a 21-parameter URL to compensate for a scraper gap.
 *
 * Reading the index instead fixes three things at once: coverage is
 * complete, titles arrive as clean fields instead of concatenated card text,
 * and locations arrive structured, so location preferences can be applied
 * here rather than by the user in the site's filter UI.
 */
export interface SearchIndexEndpoint {
  /** The board's own query URL, reused verbatim - it carries the search key. */
  url: string;
  indexName: string;
  /**
   * The narrowing from the board's own most refined query, carried through
   * so a filtered board stays filtered.
   *
   * Inherited rather than translated. A filtered board URL states its
   * filters as query parameters ("location[0]=Remote&location[1]=GA"),
   * and mapping those onto the index's own facet names would be a guess
   * per site - the measured board calls that facet `locationNames`, which
   * nothing in the URL says. The page already performs that mapping to
   * render itself, so reusing the query it issued needs no guess, and it
   * is right by construction: the board showed 41 roles for exactly this
   * narrowing.
   */
  facetFilters?: unknown;
  filters?: unknown;
}

/**
 * Matches Algolia's query endpoint on either host it is served from
 * (algolia.net directly, or the algolianet.com CDN alias).
 */
const ALGOLIA_SEARCH_RE = /algolia(?:net)?\.(?:net|com)\/1\/indexes\//i;

/** An index name that says it holds jobs. */
const JOB_INDEX_RE = /career|job|role|position|opening|vacanc|hiring/i;

/**
 * Index names that are plainly something else on a site that indexes
 * several things.
 *
 * Anchored at word edges, which is not fussiness: the measured board's
 * index is called `careers_en-US_production`, and an unanchored "product"
 * matches inside "production". That rejected the one index that mattered
 * and sent the scan back to reading 30 postings off the DOM - the exact
 * failure this module exists to fix, reintroduced by its own guard.
 */
const NON_JOB_INDEX_RE =
  /(^|[^a-z])(blog|article|glossary|help|support|product|pricing|customer|event|webinar|doc|docs)([^a-z]|$)/i;

/**
 * Whether an index is worth reading as a board.
 *
 * A job-shaped name wins outright, so a name that happens to contain
 * another word's letters cannot disqualify it.
 */
export function looksLikeJobIndex(indexName: string): boolean {
  if (JOB_INDEX_RE.test(indexName)) return true;
  return !NON_JOB_INDEX_RE.test(indexName);
}

/**
 * Hard cap on index pages, so a board that keeps reporting more pages than
 * it serves cannot loop forever. 25 pages x 100 hits is 2500 postings,
 * comfortably above any single-company board (Rippling's 625 is 7 pages).
 */
const MAX_INDEX_PAGES = 25;

const HITS_PER_PAGE = 100;

/**
 * Starts watching for the board's own search traffic. Must be called BEFORE
 * navigation: the query fires during page load, so a listener attached
 * afterwards sees nothing.
 *
 * Detection is by observation rather than by hostname. A hostname list would
 * only ever be checkable against the live site, and would miss the next
 * site built on the same template; watching for the request the page itself
 * makes costs nothing on boards that make no such request.
 */
export function watchForSearchIndex(page: Page): {
  found: () => SearchIndexEndpoint | null;
  stop: () => void;
} {
  let endpoint: SearchIndexEndpoint | null = null;

  const onRequest = (req: Request) => {
    const url = req.url();
    if (!ALGOLIA_SEARCH_RE.test(url)) return;
    const postData = req.postData() ?? "";
    const indexName = indexNameFor(postData, url);
    if (!indexName) return;
    const query = queryBodyFor(postData);
    endpoint = pickEndpoint(endpoint, {
      url,
      indexName,
      hitsPerPage: query?.hitsPerPage,
      facetFilters: query?.facetFilters,
      filters: query?.filters,
    });
  };

  page.on("request", onRequest);
  return {
    found: () => endpoint,
    // Detached explicitly: listJobsOnePage is called once per board page, so
    // a listener left attached would accumulate across a paginated walk.
    stop: () => page.off("request", onRequest),
  };
}

/**
 * The index being queried, from the request the board made.
 *
 * Read from the POST body first, which is where Algolia's JS client puts it
 * (`{"requests":[{"indexName":"..."}]}`), and from the URL path second,
 * which is where the REST shape puts it (`/1/indexes/<name>/query`). The
 * multi-query endpoint names no index in its path - it uses a wildcard
 * segment - so the URL form is only usable when a real name is there.
 */
export function indexNameFor(postData: string, url: string): string | null {
  try {
    const body = JSON.parse(postData);
    const named = body?.requests?.[0]?.indexName ?? body?.indexName;
    if (typeof named === "string" && named) return named;
  } catch {
    // Not JSON, or an empty body - fall through to the URL form.
  }
  const fromPath = url.match(/\/1\/indexes\/([^/*?]+)\//i)?.[1];
  return fromPath ? decodeURIComponent(fromPath) : null;
}

/** One observed search request, before deciding whether to keep it. */
export interface EndpointCandidate {
  url: string;
  indexName: string;
  hitsPerPage?: number;
  facetFilters?: unknown;
  filters?: unknown;
}

/**
 * Which search request to read the board from, given the one held so far.
 *
 * Pure, and separated from the listener, because the rule is subtle and
 * fails silently in both directions - too eager and the board's filters are
 * discarded, too reluctant and only the first unfiltered query is seen. The
 * measured trace it has to survive, in arrival order:
 *
 *   1. hitsPerPage 50, no filters            -> 625 hits
 *   2. hitsPerPage 50, no filters            -> 625 hits
 *   3. hitsPerPage 50, locationNames:Remote  ->   2 hits
 *   4. hitsPerPage 0,  no filters            -> facet counts only
 *   5. hitsPerPage 50, + Remote (US)         ->  40 hits
 *   6. hitsPerPage 0,  no filters            -> facet counts only
 *   7. hitsPerPage 50, + GA                  ->  41 hits  <- the board's view
 *   8. hitsPerPage 0,  no filters            -> facet counts only
 *
 * The last hit-returning query is the only one holding every filter, and a
 * facet-count query arrives after it carrying none - so "keep the latest"
 * alone would throw the filters away on the final step.
 */
export function pickEndpoint(
  current: SearchIndexEndpoint | null,
  candidate: EndpointCandidate
): SearchIndexEndpoint | null {
  if (!looksLikeJobIndex(candidate.indexName)) return current;
  // Asks for no hits, so it is a facet-count query: it says nothing about
  // which postings the board is showing.
  if (candidate.hitsPerPage === 0) return current;
  // A job-named index already found is not given up for one that merely
  // was not disqualified.
  if (current && JOB_INDEX_RE.test(current.indexName) && !JOB_INDEX_RE.test(candidate.indexName)) {
    return current;
  }
  return {
    url: candidate.url,
    indexName: candidate.indexName,
    facetFilters: candidate.facetFilters,
    filters: candidate.filters,
  };
}

/**
 * The single query out of a request body, whichever shape it uses: the
 * JS client's `{"requests":[{...}]}` or the REST endpoint's bare object.
 */
export function queryBodyFor(
  postData: string
): { hitsPerPage?: number; facetFilters?: unknown; filters?: unknown } | null {
  try {
    const body = JSON.parse(postData);
    return body?.requests?.[0] ?? body ?? null;
  } catch {
    return null;
  }
}

/** Field names carrying a posting's title, most specific first. */
const TITLE_KEYS = ["name", "title", "jobTitle", "positionName", "position", "role"];
/** Field names carrying its absolute URL. */
const URL_KEYS = ["url", "jobUrl", "applyUrl", "absolute_url", "absoluteUrl", "link", "permalink"];
/** Field names carrying its location(s). */
const LOCATION_KEYS = [
  "locationNames", "locations", "locationName", "location",
  "officeNames", "offices", "city", "cities",
];

/**
 * Pulls the strings out of a field that may be a string, an array of
 * strings, or an array of objects - all three shapes appear in career
 * indexes, and `locations` on the measured board is the object form while
 * `locationNames` beside it is the string form.
 */
function textsFrom(value: unknown): string[] {
  if (typeof value === "string") return value.trim() ? [value.trim()] : [];
  if (!Array.isArray(value)) {
    if (value && typeof value === "object") {
      const named = (value as Record<string, unknown>).name;
      return typeof named === "string" && named.trim() ? [named.trim()] : [];
    }
    return [];
  }
  return value.flatMap((entry) => textsFrom(entry));
}

function firstText(hit: Record<string, unknown>, keys: string[]): string {
  for (const key of keys) {
    const [text] = textsFrom(hit[key]);
    if (text) return text;
  }
  return "";
}

/**
 * Maps one index hit onto a posting, or null when it carries no title and
 * absolute URL.
 *
 * Deliberately tolerant about field names: the schema belongs to whoever
 * built the index, not to Algolia, so another company's careers index will
 * not necessarily use `name`/`url`/`locationNames`. Returning null for an
 * unrecognised shape is what lets the caller fall back to DOM scraping
 * rather than returning an empty board.
 */
export function postingFromHit(hit: Record<string, unknown>): JobPosting | null {
  const title = firstText(hit, TITLE_KEYS).replace(/\s+/g, " ").trim();
  const url = firstText(hit, URL_KEYS);
  if (!title || title.length < 3) return null;
  if (!/^https?:\/\//i.test(url)) return null;

  const locations = new Set<string>();
  for (const key of LOCATION_KEYS) {
    for (const text of textsFrom(hit[key])) locations.add(text.replace(/\s+/g, " ").trim());
  }
  return { title, url, location: [...locations].join(" / ") };
}

/**
 * Collapses the location variants of one posting into a single entry.
 *
 * The measured index reports 625 hits for 348 distinct postings, because a
 * role open in several places is indexed once per location (its objectID is
 * `<jobId>__<location>`). Deduplicating on url alone would keep whichever
 * variant arrived first and discard the rest, which is how a role open in
 * both Bangalore and Remote (United States) ends up looking like a
 * Bangalore-only role and scoring as off-location.
 */
export function mergeLocationVariants(postings: JobPosting[]): JobPosting[] {
  const byUrl = new Map<string, { title: string; url: string; locations: Set<string> }>();
  for (const posting of postings) {
    const existing = byUrl.get(posting.url);
    const locations = posting.location.split(" / ").map((l) => l.trim()).filter(Boolean);
    if (!existing) {
      byUrl.set(posting.url, { title: posting.title, url: posting.url, locations: new Set(locations) });
      continue;
    }
    for (const location of locations) existing.locations.add(location);
  }
  return [...byUrl.values()].map(({ title, url, locations }) => ({
    title,
    url,
    // Every location is kept rather than truncated: acceptableLocations is
    // matched by substring, so dropping variants to shorten the line would
    // silently drop the one the user actually wanted.
    location: [...locations].join(" / "),
  }));
}

/**
 * Walks every page of the index and returns the postings it holds.
 *
 * The query runs inside the page via fetch, not from Node, so the board's
 * own endpoint URL - which carries its public search key - is used exactly
 * as the board uses it, from the same origin, with no key handling here.
 */
export async function readSearchIndex(
  page: Page,
  endpoint: SearchIndexEndpoint
): Promise<{ postings: JobPosting[]; rows: number }> {
  const hits = await page.evaluate(
    async ({ url, indexName, maxPages, hitsPerPage, facetFilters, filters }) => {
      const collected: Record<string, unknown>[] = [];
      for (let pageNum = 0; pageNum < maxPages; pageNum++) {
        const request: Record<string, unknown> = { indexName, hitsPerPage, page: pageNum };
        // Omitted rather than sent as undefined, so an unfiltered board
        // sends the same query it would have sent before.
        if (facetFilters) request.facetFilters = facetFilters;
        if (filters) request.filters = filters;
        const response = await fetch(url, {
          method: "POST",
          body: JSON.stringify({ requests: [request] }),
        }).catch(() => null);
        if (!response || !response.ok) break;

        const body = await response.json().catch(() => null);
        const result = body?.results?.[0] ?? body;
        const batch = result?.hits;
        if (!Array.isArray(batch) || batch.length === 0) break;

        collected.push(...batch);
        if (pageNum >= (result?.nbPages ?? 1) - 1) break;
      }
      return collected;
    },
    {
      url: endpoint.url,
      indexName: endpoint.indexName,
      maxPages: MAX_INDEX_PAGES,
      hitsPerPage: HITS_PER_PAGE,
      facetFilters: endpoint.facetFilters ?? null,
      filters: endpoint.filters ?? null,
    }
  ).catch(() => [] as Record<string, unknown>[]);

  const postings = hits
    .map((hit) => postingFromHit(hit))
    .filter((posting): posting is JobPosting => posting !== null);

  // `rows` is the count BEFORE location variants are merged, which is what
  // the board states about itself. The measured index reports 625 rows for
  // 348 postings, so comparing the merged count against the stated total
  // would report a 277-posting shortfall on a complete read.
  return { postings: mergeLocationVariants(postings), rows: hits.length };
}
