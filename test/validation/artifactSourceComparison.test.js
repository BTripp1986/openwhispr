// TEST-ONLY — validation branch. Covers scripts/validation/compare-artifact-sources.js.
//
// A real asar is built for each case, so the comparator is exercised through
// @electron/asar exactly as it is against a packaged build.
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { execFileSync } = require("node:child_process");

const {
  compareArtifactSources,
  FEATURE_SOURCES,
  EXTRA_FILES,
} = require("../../scripts/validation/compare-artifact-sources.js");

const repoRoot = path.resolve(__dirname, "..", "..");
const atHead = (p) => execFileSync("git", ["show", `HEAD:${p}`], { cwd: repoRoot, maxBuffer: 1 << 28 });

// Two small real files keep the fixtures fast; the comparator does not care
// how many it is given.
const SOURCES = ["src/helpers/hotkeyBindingId.js", "src/helpers/dictationHotkeyConfig.js"];

async function buildArtifact(t, { sources = {}, extras = {} } = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "artifact-cmp-"));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const stage = path.join(dir, "stage");
  for (const relative of SOURCES) {
    const target = path.join(stage, relative);
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.writeFileSync(target, sources[relative] ?? atHead(relative));
  }
  const root = path.join(dir, "root");
  fs.mkdirSync(path.join(root, "resources"), { recursive: true });
  await require("@electron/asar").createPackage(stage, path.join(root, "resources", "app.asar"));
  for (const [shippedName, repoPath] of EXTRA_FILES) {
    fs.writeFileSync(path.join(root, shippedName), extras[shippedName] ?? atHead(repoPath));
  }
  return root;
}

const run = (root) => {
  const lines = [];
  const { failures, results } = compareArtifactSources({
    root,
    ref: "HEAD",
    gitDir: repoRoot,
    featureSources: SOURCES,
    isolationSources: [],
    localeSources: [],
    log: (line) => lines.push(line),
  });
  return { failures, results, output: lines.join("\n") };
};

test("an artifact built from the reviewed tree passes, and says EXACT", async (t) => {
  const { failures, results, output } = run(await buildArtifact(t));
  assert.equal(failures, 0);
  assert.ok(results.every((r) => r.ok));
  for (const source of SOURCES) {
    const row = results.find((r) => r.name === source);
    assert.match(row.detail, /^EXACT \d+ B — shipped [0-9a-f]{64} reviewed [0-9a-f]{64}$/);
  }
  assert.match(output, /PASS: all \d+ shipped files match HEAD exactly\./);
});

test("a CRLF-only difference in SOURCE is accepted and labelled, with both hashes", async (t) => {
  const [first] = SOURCES;
  const crlf = Buffer.from(atHead(first).toString("utf8").replace(/\n/g, "\r\n"), "utf8");
  const root = await buildArtifact(t, { sources: { [first]: crlf } });
  const { failures, results, output } = run(root);
  assert.equal(failures, 0, "a correct Windows build must not fail on line endings alone");
  const row = results.find((r) => r.name === first);
  assert.match(row.detail, /^CRLF-ONLY \(text identical\) — shipped [0-9a-f]{64} reviewed [0-9a-f]{64}$/);
  // The two hashes must actually differ, or the case did not exercise anything.
  const [, shipped, reviewed] = row.detail.match(/shipped ([0-9a-f]{64}) reviewed ([0-9a-f]{64})/);
  assert.notEqual(shipped, reviewed);
  assert.match(output, /1 by CRLF-only normalization, labelled above/);
});

test("a genuine byte change is still rejected", async (t) => {
  const [first] = SOURCES;
  const tampered = Buffer.concat([atHead(first), Buffer.from("\n// injected\n")]);
  const { failures, results } = run(await buildArtifact(t, { sources: { [first]: tampered } }));
  assert.equal(failures, 1);
  assert.match(results.find((r) => r.name === first).detail, /^CONTENT DIFFERS — shipped [0-9a-f]{64} reviewed [0-9a-f]{64}$/);
});

test("a one-character change that leaves the length alone is still rejected", async (t) => {
  const [first] = SOURCES;
  const text = atHead(first).toString("utf8");
  const swapped = Buffer.from(text.replace("const", "CONST"), "utf8");
  assert.notEqual(swapped.toString("utf8"), text);
  const { failures } = run(await buildArtifact(t, { sources: { [first]: swapped } }));
  assert.equal(failures, 1);
});

test("whitespace that is not a line ending is NOT normalized away", async (t) => {
  const [first] = SOURCES;
  const padded = Buffer.from(`${atHead(first).toString("utf8")}   `, "utf8");
  const { failures, results } = run(await buildArtifact(t, { sources: { [first]: padded } }));
  assert.equal(failures, 1);
  assert.match(results.find((r) => r.name === first).detail, /CONTENT DIFFERS/);
});

test("a source file missing from the asar fails rather than being skipped", async (t) => {
  const root = await buildArtifact(t);
  const { failures, results } = (() => {
    const lines = [];
    const out = compareArtifactSources({
      root,
      ref: "HEAD",
      gitDir: repoRoot,
      featureSources: [...SOURCES, "src/helpers/hotkeyCanonical.js"],
      isolationSources: [],
      localeSources: [],
      log: (l) => lines.push(l),
    });
    return out;
  })();
  assert.equal(failures, 1);
  assert.match(results.find((r) => r.name === "src/helpers/hotkeyCanonical.js").detail, /NOT IN THE ASAR/);
});

test("a missing app.asar fails loudly", async (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "artifact-cmp-"));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  for (const [shippedName, repoPath] of EXTRA_FILES) {
    fs.writeFileSync(path.join(dir, shippedName), atHead(repoPath));
  }
  const { failures, results } = run(dir);
  assert.ok(failures >= 1);
  assert.match(results[0].detail, /missing at /);
});

test("an extraFile that differs in content fails; CRLF alone does not", async (t) => {
  const changed = await buildArtifact(t, {
    extras: { "READ-ME-FIRST.txt": Buffer.from("not the readme\r\n", "utf8") },
  });
  assert.equal(run(changed).failures, 1);

  // What a Windows build actually ships. `.gitattributes` marks
  // validation/*.txt as `text eol=crlf`, so git STORES it with LF and checks
  // it out with CRLF: `git show` gives LF, the packaged file is CRLF, and the
  // comparator must accept that pair and label it rather than fail a correct
  // build.
  const asWindowsShipsIt = Buffer.from(
    atHead("validation/READ-ME-FIRST.txt").toString("utf8").replace(/\r?\n/g, "\r\n"),
    "utf8"
  );
  const normalized = await buildArtifact(t, { extras: { "READ-ME-FIRST.txt": asWindowsShipsIt } });
  const { failures, results } = run(normalized);
  assert.equal(failures, 0);
  const row = results.find((r) => r.name === "READ-ME-FIRST.txt");
  assert.match(row.detail, /^CRLF-ONLY \(text identical\)/);
  const [, shipped, reviewed] = row.detail.match(/shipped ([0-9a-f]{64}) reviewed ([0-9a-f]{64})/);
  assert.notEqual(shipped, reviewed);
});

test("the shipped list covers every source file the revision changed", () => {
  const changed = execFileSync(
    "git",
    ["diff", "--name-only", "5d17ed47db832f1e21d1928c15f1baa3da77c67c", "HEAD"],
    { cwd: repoRoot, maxBuffer: 1 << 28 }
  )
    .toString("utf8")
    .split("\n")
    .filter(Boolean)
    // Only the trees electron-builder actually ships as source.
    .filter((p) =>
      /^(main\.js|preload\.js|src\/(helpers|hooks|types|config|constants|models|workers|utils)\/)/.test(p)
    )
    .filter((p) => !p.startsWith("src/helpers/validationBuildPolicy.js"));
  const covered = new Set([
    ...FEATURE_SOURCES,
    ...require("../../scripts/validation/compare-artifact-sources.js").ISOLATION_SOURCES,
  ]);
  const missing = changed.filter((p) => !covered.has(p));
  assert.deepEqual(missing, [], `shipped source files not compared: ${missing.join(", ")}`);
});
