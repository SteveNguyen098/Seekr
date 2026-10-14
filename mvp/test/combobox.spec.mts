/**
 * Integration harness for the custom-combobox machinery, run against a
 * fixture rather than a live form and needing no API key.
 *
 * It exists because the expensive failure here is a CASCADE: an open
 * listbox covers whatever sits beneath it, so one question that cannot be
 * answered takes out every question below it, and the report blames those
 * on being "not reachable by a real click" rather than on the dropdown
 * this run left hanging open. Measured on a live Rippling form, that cost
 * three required answers behind one unanswerable question.
 *
 *   npm run test:combobox
 */
import { chromium } from "playwright";
import { pathToFileURL } from "url";
import path from "path";
import { degreeCandidates, pickAriaRadioOption, reachability, selectComboboxOption } from "../src/apply.js";

const FIXTURE = pathToFileURL(
  path.resolve(import.meta.dirname, "fixtures", "rippling-dropdown-covers-fields.html")
).href;

let pass = 0;
let fail = 0;
function check(name: string, ok: boolean, detail = ""): void {
  ok ? pass++ : fail++;
  console.log(`  ${ok ? "PASS" : "FAIL"}  ${name}${ok ? "" : ` — ${detail}`}`);
}

const browser = await chromium.launch();

// The widget ignores Escape, so "did it close" has to be measured, not
// assumed. Any rendered option anywhere counts: the listbox is portaled to
// <body>, outside the field's own subtree.
const openOptions = (page: import("playwright").Page) =>
  page.evaluate(`document.querySelectorAll('[role="option"]').length`).then((n) => Number(n) || 0);

console.log("a degree question whose options are Yes/No");
{
  const page = await browser.newPage({ viewport: { width: 1280, height: 900 } });
  await page.goto(FIXTURE, { waitUntil: "load" });

  // The real candidate list from the degree branch, not a copy of it - a
  // restatement here would keep passing while that list changed.
  const DEGREE = "Bachelor of Business Administration";
  const picked = await selectComboboxOption(
    page,
    "#degree",
    degreeCandidates("Do you have a 4 year degree?", DEGREE)
  );
  check(
    "THE BUG: a yes/no degree question is answered instead of reported unmatched",
    picked === "Yes",
    String(picked)
  );
  check("the trigger shows the answer", (await page.textContent("#degree"))?.trim() === "Yes");
  check("nothing is left open after a successful pick", (await openOptions(page)) === 0);
  await page.close();
}

console.log("\na failed selection must not leave the listbox covering the page");
{
  const page = await browser.newPage({ viewport: { width: 1280, height: 900 } });
  await page.goto(FIXTURE, { waitUntil: "load" });

  // Fields below the degree question are reachable before anything opens.
  check("the field below is reachable to begin with", (await reachability(page, "#aitools")) === "reachable");

  // A candidate list that cannot match - the pre-fix degree behaviour.
  const picked = await selectComboboxOption(page, "#degree", ["Bachelor of Business Administration"]);
  check("the unmatchable candidate is correctly not picked", picked === null, String(picked));
  check(
    "THE BUG: the listbox is closed afterwards, not left hanging open",
    (await openOptions(page)) === 0,
    `${await openOptions(page)} option(s) still rendered`
  );
  check(
    "THE BUG: so the question below is still answerable, not 'not reachable by a real click'",
    (await reachability(page, "#aitools")) === "reachable",
    await reachability(page, "#aitools")
  );
  check(
    "...and so is the one after that",
    (await reachability(page, "#authorized")) === "reachable",
    await reachability(page, "#authorized")
  );

  // The following question can now actually be answered, which is the
  // outcome the cascade was costing.
  const next = await selectComboboxOption(page, "#aitools", [/^\s*yes\b/i]);
  check("the question below gets answered", next === "Yes", String(next));
  await page.close();
}

console.log("\nthe guard proves the cascade is real");
{
  // With the listbox deliberately left open, the field below MUST be
  // blocked - otherwise the two checks above would pass whether or not
  // anything closes the dropdown, and this file would be testing nothing.
  const page = await browser.newPage({ viewport: { width: 1280, height: 900 } });
  await page.goto(FIXTURE, { waitUntil: "load" });
  await page.click("#degree");
  await page.waitForTimeout(300);
  check("the listbox is open", (await openOptions(page)) > 0);
  check(
    "an open listbox does block the field beneath it",
    (await reachability(page, "#aitools")) === "blocked",
    await reachability(page, "#aitools")
  );
  await page.close();
}

console.log("\nan ARIA rating scale is clicked, not set");
{
  const page = await browser.newPage({ viewport: { width: 1280, height: 900 } });
  await page.goto(
    pathToFileURL(path.resolve(import.meta.dirname, "fixtures", "rippling-rating-scale.html")).href,
    { waitUntil: "load" }
  );

  const consent = '[role="radiogroup"]#input-65';
  const picked = await pickAriaRadioOption(page, consent, ["Yes"]);
  check("THE BUG: a scale question can be answered at all", picked === "Yes", String(picked));
  check(
    "THE TRAP: 'Yes' does not land on 'Strong Yes'",
    // The options differ only by a prefix and option matching accepts
    // containment BOTH ways, so a shorter answer would otherwise match a
    // longer option - putting an emphatic answer on the application that
    // the candidate never gave.
    (await page.getAttribute('[role="radio"][aria-label="Yes"]', "aria-checked")) === "true",
    String(await page.getAttribute('[role="radio"][aria-label="Yes"]', "aria-checked"))
  );
  check(
    "...and the emphatic box is left alone",
    (await page.getAttribute('[role="radio"][aria-label="Strong Yes"]', "aria-checked")) === "false"
  );

  const auth = '[role="radiogroup"]#input-70';
  const strong = await pickAriaRadioOption(page, auth, ["Strong No"]);
  check("an emphatic answer still reaches its own box", strong === "Strong No", String(strong));
  check(
    "and the plain box is not the one ticked",
    (await page.getAttribute('#input-70 [role="radio"][aria-label="No"]', "aria-checked")) === "false"
  );

  const missing = await pickAriaRadioOption(page, auth, ["Maybe"]);
  check("an answer matching no box is reported, not forced", missing === null, String(missing));
  await page.close();
}

await browser.close();
console.log(`\n${"-".repeat(70)}`);
console.log(
  fail
    ? `${pass} passed, ${fail} FAILED`
    : `${pass} passed, 0 failed - one unanswerable question cannot take out the ones below it`
);
process.exit(fail ? 1 : 0);
