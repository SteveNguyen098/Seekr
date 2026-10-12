/**
 * The path handed to Word for the docx -> PDF conversion.
 *
 * Small, but it guards a failure that degrades QUIETLY: when Word cannot
 * open the file, tailoring "fails" with a COM error, the run continues
 * with the UNTAILORED resume, and only a warning line says so - so the
 * application goes out with a generic document. Measured with one real
 * file three ways:
 *
 *   ../Seekr Resume Template.docx  -> C:\Windows\Seekr Resume Template.docx
 *   C:/Users/.../Seekr Resume...   -> C:\//Users/stron/OneDrive/...
 *   C:\Users\...\Seekr Resume...   -> converted, a 157KB PDF
 *
 *   npm run test:resumepath
 */
import path from "path";
import { pathForWord } from "../src/resumeGenerator.js";

let pass = 0;
let fail = 0;
function check(name: string, ok: boolean, detail = ""): void {
  ok ? pass++ : fail++;
  console.log(`  ${ok ? "PASS" : "FAIL"}  ${name}${ok ? "" : ` — ${detail}`}`);
}

console.log("pathForWord");

const forwardSlashAbsolute = "C:/Users/stron/OneDrive/Desktop/Seekr/seekr/Seekr Resume Template.docx";
const got = pathForWord(forwardSlashAbsolute);
check(
  "THE BUG: an absolute path written with forward slashes is not mangled",
  got === "C:\\Users\\stron\\OneDrive\\Desktop\\Seekr\\seekr\\Seekr Resume Template.docx",
  got
);
check("no forward slash survives", !got.includes("/"), got);
check("no doubled separator is introduced", !got.includes("\\\\"), got);

const relative = pathForWord("../Seekr Resume Template.docx");
check(
  "THE BUG: a relative path is resolved here, not against Word's own working directory",
  path.isAbsolute(relative) && !relative.includes(".."),
  relative
);
check("...and it resolves against OUR cwd", relative === path.resolve("../Seekr Resume Template.docx"), relative);

const alreadyRight = "C:\\Users\\stron\\Seekr Resume Template.docx";
check("a path that was already correct is left alone", pathForWord(alreadyRight) === alreadyRight, pathForWord(alreadyRight));

check("a space in the filename is preserved", pathForWord("C:/tmp/My Resume.docx").endsWith("\\My Resume.docx"), pathForWord("C:/tmp/My Resume.docx"));

console.log(`\n${"-".repeat(70)}`);
console.log(
  fail ? `${pass} passed, ${fail} FAILED` : `${pass} passed, 0 failed - Word gets a path it can actually open`
);
process.exit(fail ? 1 : 0);
