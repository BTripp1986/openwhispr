#!/usr/bin/env node
// TEST-ONLY — lives on the `validation/*` branch. See VALIDATION_BUILD.md.
//
// Refuses to let the validation branch package anything beyond the enumerated
// packaging paths. Run against the feature SHA the artifact claims to be:
//
//   node scripts/validation/check-packaging-only-diff.js <baseSha>
//
// Exits non-zero if the branch differs from <baseSha> in any path that
// validation/PACKAGING_PATHS does not list, or if <baseSha> is not an ancestor
// of HEAD (the artifact would then not contain that feature commit at all).

const fs = require("fs");
const path = require("path");
const { execFileSync } = require("child_process");

const base = (process.argv[2] || "").trim();
if (!/^[0-9a-f]{7,40}$/.test(base)) {
  console.error(
    `usage: ${path.basename(process.argv[1])} <baseSha>  (got ${JSON.stringify(base)})`
  );
  process.exit(2);
}

function git(...args) {
  return execFileSync("git", args, { encoding: "utf8" }).trim();
}

const allowed = fs
  .readFileSync(path.resolve(__dirname, "..", "..", "validation", "PACKAGING_PATHS"), "utf8")
  .split("\n")
  .map((line) => line.trim())
  .filter((line) => line && !line.startsWith("#"));

let ancestor = true;
try {
  execFileSync("git", ["merge-base", "--is-ancestor", base, "HEAD"], { stdio: "ignore" });
} catch {
  ancestor = false;
}

const changed = git("diff", "--name-only", `${base}..HEAD`).split("\n").filter(Boolean);
const offenders = changed.filter(
  (file) =>
    !allowed.some((entry) => (entry.endsWith("/") ? file.startsWith(entry) : file === entry))
);

const stat = git("diff", "--shortstat", `${base}..HEAD`) || "no changes";

console.log(
  `base            ${base} (${ancestor ? "ancestor of HEAD" : "NOT an ancestor of HEAD"})`
);
console.log(`head            ${git("rev-parse", "HEAD")}`);
console.log(`diff vs base    ${stat}`);
console.log(`changed files   ${changed.length}`);
for (const file of changed) {
  console.log(`  ${offenders.includes(file) ? "REJECT" : "ok    "}  ${file}`);
}

if (!ancestor) {
  console.error(
    `\nFAIL: ${base} is not an ancestor of HEAD, so this branch does not contain that commit.`
  );
}
if (offenders.length > 0) {
  console.error(
    `\nFAIL: ${offenders.length} path(s) outside validation/PACKAGING_PATHS:\n  ${offenders.join("\n  ")}`
  );
}
if (!ancestor || offenders.length > 0) process.exit(1);
console.log("\nPASS: the branch differs from the base only in enumerated packaging paths.");
