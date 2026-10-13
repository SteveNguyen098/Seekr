/**
 * Reconciling a board's stated location with the locations the posting
 * itself names.
 *
 * Exists because the first attempt at this REGRESSED the thing it was
 * meant to fix. Reading locations out of descriptions filled in the blanks,
 * but preferring the board's single answer then hid the extra sites a
 * multi-site posting names - and the one it hid, on the top match of a live
 * board, was the only site the candidate could reach. The row was left
 * flagged "outside your preferred locations", which is worse than a blank:
 * a blank invites a look, a wrong flag ends it.
 *
 *   npm run test:locations
 */
import { combineLocations } from "../src/match.js";
import { matchesAcceptableLocation } from "../src/filter.js";

let pass = 0;
let fail = 0;
function check(name: string, ok: boolean, detail = ""): void {
  ok ? pass++ : fail++;
  console.log(`  ${ok ? "PASS" : "FAIL"}  ${name}${ok ? "" : ` — ${detail}`}`);
}

console.log("combineLocations");

{
  // The measured case: RAS Legal Group's "Junior Business Analyst (Legal
  // Operations)". The board lists one city, the description names four.
  const got = combineLocations("Boca Raton, FL", "Boca Raton, FL / Westbury, NY / Alpharetta, GA / Fairfield, NJ");
  check("the board's own location leads", got.location === "Boca Raton, FL", got.location);
  check(
    "THE BUG: the sites only the posting names are carried too",
    got.alsoInPosting === "Westbury, NY / Alpharetta, GA / Fairfield, NJ",
    got.alsoInPosting
  );
  check("the board's city is not repeated back as an addition", !got.alsoInPosting.includes("Boca Raton"), got.alsoInPosting);
  check(
    "THE BUG: an acceptable site anywhere in the posting counts as in range",
    got.everywhere.includes("Alpharetta, GA"),
    got.everywhere
  );
}

{
  // The case the whole feature was for: a board that states nothing.
  const got = combineLocations("", "Alpharetta, GA");
  check("with no board location, the posting's becomes the location", got.location === "Alpharetta, GA", got.location);
  check(
    "and is not ALSO listed as an addition to itself",
    got.alsoInPosting === "",
    got.alsoInPosting
  );
  check("everywhere holds it once", got.everywhere === "Alpharetta, GA", got.everywhere);
}

{
  // Neither source knows. Must stay empty so the caller can say so
  // explicitly rather than printing a bare blank.
  const got = combineLocations("", "");
  check("both empty stays empty", got.location === "" && got.alsoInPosting === "" && got.everywhere === "");
}

{
  // The posting adds nothing the board did not already say.
  const got = combineLocations("Remote (United States)", "Remote (United States)");
  check("an agreeing posting adds nothing", got.alsoInPosting === "", got.alsoInPosting);
  check("and the location is stated once", got.everywhere === "Remote (United States)", got.everywhere);
}

{
  // Case and spacing differences must not produce a duplicate.
  const got = combineLocations("Boca Raton, FL", "  boca raton, fl  ");
  check("a case-only difference is not a new site", got.alsoInPosting === "", got.alsoInPosting);
}

{
  // A board location that is broader than the posting's: the posting's
  // narrower phrasing is already contained, so it adds nothing.
  const got = combineLocations("Remote (US) / Austin, TX", "Austin, TX");
  check("a site already covered by the board is not repeated", got.alsoInPosting === "", got.alsoInPosting);
}

{
  // Off-location decisions read `everywhere`, so it must contain every
  // candidate site - this is the string that decides whether a row gets
  // flagged as out of range.
  const got = combineLocations("Singapore", "Singapore / Remote (United States)");
  check(
    "everywhere spans board and posting both",
    got.everywhere === "Singapore / Remote (United States)",
    got.everywhere
  );
}

// A two-letter state code in acceptableLocations is the whole reason this
// has to match words rather than substrings.
console.log("\nmatchesAcceptableLocation");
const ACCEPTED = ["Atlanta", "Alpharetta", "GA", "Remote"];
const LOCATIONS: { location: string; want: boolean; why: string }[] = [
  // What adding "GA" is for.
  { location: "Alpharetta, GA", want: true, why: "the measured multi-site role's Georgia office" },
  { location: "GA", want: true, why: "the bare state code, as the Rippling index writes it" },
  { location: "Atlanta, GA", want: true, why: "the home city" },
  { location: "WI / TX / GA / IL", want: true, why: "a merged multi-location role including Georgia" },
  { location: "Remote (United States)", want: true, why: "remote still matches on a word" },

  // THE TRAP: a substring test matched 92 of 355 postings on one board,
  // every one of them through the "ga" inside another word.
  { location: "Bangalore, India", want: false, why: "THE TRAP: Ban-GA-lore is not Georgia" },
  { location: "Singapore, Singapore", want: false, why: "THE TRAP: Sin-GA-pore is not Georgia" },
  { location: "Galway, Ireland", want: false, why: "a city merely starting with those letters" },
  { location: "Atlantic City, NJ", want: false, why: "Atlantic is not Atlanta" },
  { location: "Boca Raton, FL", want: false, why: "a genuinely different state" },
  { location: "Westbury, NY", want: false, why: "the same" },
  { location: "Sunnyvale, CA / Saratoga, CA", want: false, why: "a multi-location role entirely out of range" },
];
for (const c of LOCATIONS) {
  const got = matchesAcceptableLocation(c.location, ACCEPTED);
  const ok = got === c.want;
  ok ? pass++ : fail++;
  console.log(`  ${ok ? "PASS" : "FAIL"}  ${String(got).padEnd(5)} ${JSON.stringify(c.location.slice(0, 44))}`);
  if (!ok) console.log(`        expected ${c.want} - ${c.why}`);
}

// A needle that does not end in a word character must still match at the
// end of a string, or a word boundary would be required after the dot.
check(
  "a needle ending in punctuation still matches",
  matchesAcceptableLocation("Washington, D.C.", ["D.C."]),
  "D.C."
);
check(
  "...and its regex characters are escaped rather than interpreted",
  // "DXCX" is what an UNescaped "D.C." matches: D, any, C, any. A shorter
  // string like "DXC" would fail either way and would test nothing.
  !matchesAcceptableLocation("Office in DXCX", ["D.C."]),
  "the dot must not act as a wildcard"
);
check("an empty needle matches nothing", !matchesAcceptableLocation("Atlanta, GA", [""]));
check("no needles at all matches nothing", !matchesAcceptableLocation("Atlanta, GA", []));

console.log(`\n${"-".repeat(70)}`);
console.log(
  fail
    ? `${pass} passed, ${fail} FAILED`
    : `${pass} passed, 0 failed - a multi-site posting keeps the site you could actually take`
);
process.exit(fail ? 1 : 0);
