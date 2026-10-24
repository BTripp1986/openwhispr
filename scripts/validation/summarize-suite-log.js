// TEST-ONLY - lives on the `validation/*` branches, never on the feature branch.
//
// Turns a `node --test --test-reporter=spec` log into a reconciled summary and
// a full skip/todo inventory, so a cross-platform run can be judged on what it
// actually executed rather than on a green check mark.
//
// Written against real output (run 39848701770): the spec reporter prints a
// flat list - no per-file headings - so a skipped case can only be attributed
// to a file by searching the test sources for its exact title. An
// unattributable title is reported as such instead of being guessed at.
//
// Usage: node scripts/validation/summarize-suite-log.js <log> [--test-dir test]
// Exit: 0 summary parsed, 2 no summary block (the run did not complete),
//       1 the log could not be read or the totals do not reconcile.

const fs = require("node:fs");
const path = require("node:path");

const SKIP_GLYPH = "﹣"; // the spec reporter's skip marker
const SUMMARY_KEYS = [
  "tests",
  "suites",
  "pass",
  "fail",
  "cancelled",
  "skipped",
  "todo",
  "duration_ms",
];

function parseArgs(argv) {
  const args = { log: null, testDir: "test" };
  for (let i = 0; i < argv.length; i += 1) {
    if (argv[i] === "--test-dir") {
      args.testDir = argv[i + 1];
      i += 1;
    } else if (!args.log) {
      args.log = argv[i];
    }
  }
  return args;
}

// `ℹ tests 8916`, with the leading glyph left unanchored because it is
// multibyte and a runner's locale must not decide whether this matches.
function readSummary(lines) {
  const summary = {};
  for (const line of lines) {
    const match = /(?:^|[^a-z_])([a-z_]+) ([0-9][0-9.]*)$/.exec(line.trim());
    if (match && SUMMARY_KEYS.includes(match[1])) summary[match[1]] = Number(match[2]);
  }
  return SUMMARY_KEYS.every((key) => key in summary) ? summary : null;
}

function cleanTitle(raw) {
  // `﹣ some title (0.284085ms) # a reason` -> `some title`
  let title = raw.trim();
  if (title.startsWith(SKIP_GLYPH)) title = title.slice(SKIP_GLYPH.length).trim();
  if (title.startsWith("✔")) title = title.slice(1).trim(); // ✔, how todo is marked
  const annotation = / # (?:SKIP|TODO)\b(.*)$|# (.*)$/.exec(title);
  let reason = "";
  if (annotation) {
    reason = (annotation[1] || annotation[2] || "").trim();
    title = title.slice(0, annotation.index).trim();
  }
  title = title.replace(/\s*\([0-9][0-9.]*ms\)$/, "").trim();
  return { title, reason };
}

function collectTestFiles(dir, found = []) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) collectTestFiles(full, found);
    else if (entry.name.endsWith(".test.js") || entry.name.endsWith(".test.ts")) found.push(full);
  }
  return found;
}

function attribute(title, sources) {
  // Literal search: a title is matched as written, so a regex metacharacter in
  // a test name cannot widen the match.
  const hits = sources.filter((source) => source.body.includes(title));
  if (hits.length === 1) return hits[0].file;
  if (hits.length === 0) return "UNATTRIBUTED (title not found in the test sources)";
  return `AMBIGUOUS (${hits.map((hit) => hit.file).join(", ")})`;
}

function main() {
  const args = parseArgs(process.argv.slice(2));
  if (!args.log) {
    console.error("usage: summarize-suite-log.js <log> [--test-dir test]");
    process.exit(1);
  }
  let text;
  try {
    text = fs.readFileSync(args.log, "utf8");
  } catch (error) {
    console.error(`cannot read ${args.log}: ${error.message}`);
    process.exit(1);
  }
  const lines = text.split(/\r?\n/);

  const skips = [];
  const todos = [];
  for (const line of lines) {
    const trimmed = line.trim();
    if (trimmed.startsWith(SKIP_GLYPH)) skips.push(cleanTitle(trimmed));
    else if (/# TODO\b/.test(trimmed)) todos.push(cleanTitle(trimmed));
  }

  const sources = fs.existsSync(args.testDir)
    ? collectTestFiles(args.testDir).map((file) => ({
        file,
        body: fs.readFileSync(file, "utf8"),
      }))
    : [];
  if (sources.length === 0) {
    console.log("NOTE: no test sources readable, so skips are listed unattributed.");
  }

  const summary = readSummary(lines);
  console.log(`log: ${args.log}`);
  if (!summary) {
    console.log("NO SUMMARY BLOCK: the suite did not run to completion.");
    console.log(`skip-marked lines seen: ${skips.length}`);
    process.exit(2);
  }

  for (const key of SUMMARY_KEYS) console.log(`${key} ${summary[key]}`);

  const accounted = summary.pass + summary.skipped + summary.todo + summary.fail + summary.cancelled;
  const reconciles = accounted === summary.tests;
  console.log(`RECONCILES=${reconciles} (pass+skipped+todo+fail+cancelled=${accounted}, tests=${summary.tests})`);
  console.log(`SKIP_LINES_SEEN=${skips.length} REPORTED_SKIPPED=${summary.skipped}`);
  console.log(`TODO_LINES_SEEN=${todos.length} REPORTED_TODO=${summary.todo}`);

  const render = (entries, label) => {
    console.log(`\n=== ${label} (${entries.length}) ===`);
    const sorted = entries
      .map((entry) => ({ ...entry, file: attribute(entry.title, sources) }))
      .sort((a, b) => a.file.localeCompare(b.file) || a.title.localeCompare(b.title));
    for (const entry of sorted) {
      console.log(`${entry.file}\t${entry.title}\t${entry.reason || "(no reason given)"}`);
    }
    const byFile = new Map();
    for (const entry of sorted) byFile.set(entry.file, (byFile.get(entry.file) || 0) + 1);
    console.log(`--- ${label} per file ---`);
    for (const [file, count] of [...byFile].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))) {
      console.log(`${count}\t${file}`);
    }
  };

  render(skips, "SKIPPED");
  render(todos, "TODO");

  // A mismatch between the lines seen and the reporter's own count means this
  // inventory is incomplete, which must be loud rather than implied.
  if (!reconciles) process.exit(1);
  process.exit(0);
}

main();
