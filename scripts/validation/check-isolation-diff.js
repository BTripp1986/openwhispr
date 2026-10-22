#!/usr/bin/env node
// TEST-ONLY — lives on the `validation/*` branch. See VALIDATION_BUILD.md.
//
//   node scripts/validation/check-isolation-diff.js [<baseSha>] [<headRef>]
//
// validation/PACKAGING_PATHS says WHICH files this branch may differ in. It
// says nothing about WHAT may change inside them, and two of those files are
// main.js and src/helpers/ipcHandlers.js — so the path gate alone would let an
// arbitrary application change ride into a packaged build.
//
// This pins the content. It hashes the diff of the application files between
// the pinned feature SHA and this branch, and fails when that hash is not the
// reviewed one in validation/ISOLATION_DIFF_SHA256. Any edit to an isolation
// hunk, and any new hunk, therefore has to be re-reviewed and re-pinned
// deliberately — including one that lands by merging a new feature candidate.
//
// `index <blob>..<blob>` lines are stripped before hashing: they restate blob
// identities that the +/- lines already pin, and they churn for reasons that
// are not content.

const fs = require("fs");
const path = require("path");
const crypto = require("crypto");
const { execFileSync } = require("child_process");

// Application files only. Packaging-owned paths (validation/, test/validation/,
// scripts/validation/, the workflow, the docs) are reviewed as themselves and
// are not pinned here — pinning them would mean re-pinning on every packaging
// edit, which would train the reviewer to re-pin without looking.
const APP_FILES = [
  "main.js",
  "src/updater.js",
  "src/helpers/cliBridge.js",
  "src/helpers/cloudApiRequest.js",
  "src/helpers/ipcHandlers.js",
  "src/helpers/modelDirUtils.js",
  "src/helpers/qdrantManager.js",
  "src/helpers/secretCrypto.js",
  "src/helpers/validationBuildPolicy.js",
];

const repoRoot = path.resolve(__dirname, "..", "..");
const pinFile = path.join(repoRoot, "validation", "ISOLATION_DIFF_SHA256");

// `headRef` null means the WORKING TREE, which is the default on purpose:
// `git diff base HEAD` compares two commits and silently ignores an
// uncommitted edit, so a tampered working tree passed this gate until a
// negative control caught it.
function isolationDiff(baseSha, headRef = null, cwd = repoRoot) {
  const raw = execFileSync(
    "git",
    [
      "diff",
      "--no-color",
      "--no-ext-diff",
      "-U3",
      baseSha,
      ...(headRef ? [headRef] : []),
      "--",
      ...APP_FILES,
    ],
    { cwd, maxBuffer: 1 << 28 }
  ).toString("utf8");
  return raw
    .split("\n")
    .filter((line) => !line.startsWith("index "))
    .join("\n");
}

const digestOf = (diff) => crypto.createHash("sha256").update(diff, "utf8").digest("hex");

module.exports = { APP_FILES, isolationDiff, digestOf };

if (require.main === module) {
  const baseSha =
    process.argv[2] ||
    fs.readFileSync(path.join(repoRoot, "validation", "FEATURE_SHA"), "utf8").trim();
  // No third argument = the working tree, not HEAD.
  const headRef = process.argv[3] || null;
  const diff = isolationDiff(baseSha, headRef);
  const actual = digestOf(diff);

  if (process.env.WRITE_ISOLATION_PIN === "1") {
    fs.writeFileSync(pinFile, `${actual}\n`);
    console.log(`wrote validation/ISOLATION_DIFF_SHA256 = ${actual}`);
    process.exit(0);
  }

  let expected = null;
  try {
    expected = fs.readFileSync(pinFile, "utf8").trim();
  } catch {
    console.error("validation/ISOLATION_DIFF_SHA256 is missing. Nothing is pinned.");
    process.exit(1);
  }

  const files = diff.split("\n").filter((l) => l.startsWith("diff --git ")).length;
  const added = diff.split("\n").filter((l) => l.startsWith("+") && !l.startsWith("+++")).length;
  const removed = diff.split("\n").filter((l) => l.startsWith("-") && !l.startsWith("---")).length;
  console.log(
    `isolation diff ${baseSha.slice(0, 8)}..${headRef || "working tree"}: ${files} file(s), +${added}/-${removed}`
  );

  if (actual === expected) {
    console.log(`PASS: the application-file diff is the reviewed one (${actual.slice(0, 16)}…).`);
    process.exit(0);
  }
  console.error(
    `\nFAIL: the application-file diff is NOT the reviewed one.\n` +
      `  expected ${expected}\n  actual   ${actual}\n\n` +
      `Something changed inside an allowlisted application file. Review the diff,\n` +
      `and re-pin deliberately with WRITE_ISOLATION_PIN=1 only once it is approved.`
  );
  process.exit(1);
}
