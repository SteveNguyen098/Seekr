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

console.log(`\n${"-".repeat(70)}`);
console.log(
  fail
    ? `${pass} passed, ${fail} FAILED`
    : `${pass} passed, 0 failed - a multi-site posting keeps the site you could actually take`
);
process.exit(fail ? 1 : 0);
