// TEST-ONLY — validation branch. Covers scripts/validation/check-isolation-diff.js.
//
// validation/PACKAGING_PATHS says which files may differ. This gate says what
// may differ inside them, which is the part path allowlisting cannot do.
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const { execFileSync } = require("node:child_process");

const {
  APP_FILES,
  isolationDiff,
  digestOf,
} = require("../../scripts/validation/check-isolation-diff.js");

const repoRoot = path.resolve(__dirname, "..", "..");
const script = path.join(repoRoot, "scripts", "validation", "check-isolation-diff.js");
const featureSha = fs.readFileSync(path.join(repoRoot, "validation", "FEATURE_SHA"), "utf8").trim();

const runGate = (args = []) => {
  const res = require("node:child_process").spawnSync("node", [script, ...args], {
    cwd: repoRoot,
    encoding: "utf8",
  });
  return { status: res.status, out: `${res.stdout}${res.stderr}` };
};

test("the committed pin matches the tree as it stands", () => {
  const { status, out } = runGate();
  assert.equal(status, 0, out);
  assert.match(out, /PASS: the application-file diff is the reviewed one/);
});

test("every pinned file is one PACKAGING_PATHS actually allows", () => {
  const allowed = fs
    .readFileSync(path.join(repoRoot, "validation", "PACKAGING_PATHS"), "utf8")
    .split("\n")
    .map((l) => l.trim())
    .filter((l) => l && !l.startsWith("#"));
  for (const file of APP_FILES) {
    const ok = allowed.some((entry) => (entry.endsWith("/") ? file.startsWith(entry) : file === entry));
    assert.ok(ok, `${file} is pinned but not in PACKAGING_PATHS`);
  }
});

test("the digest changes when an application file changes", () => {
  const before = digestOf(isolationDiff(featureSha, null, repoRoot));
  const target = path.join(repoRoot, "src", "helpers", "cliBridge.js");
  const original = fs.readFileSync(target);
  try {
    fs.writeFileSync(target, Buffer.concat([original, Buffer.from("\n// tamper\n")]));
    const after = digestOf(isolationDiff(featureSha, null, repoRoot));
    assert.notEqual(after, before);
    // And the gate itself must refuse, not merely report a different number.
    const { status, out } = runGate();
    assert.equal(status, 1);
    assert.match(out, /FAIL: the application-file diff is NOT the reviewed one/);
  } finally {
    fs.writeFileSync(target, original);
  }
  assert.equal(digestOf(isolationDiff(featureSha, null, repoRoot)), before);
});

test("an UNCOMMITTED change is caught — the default compares the working tree", () => {
  // The first version of this gate diffed base..HEAD, which compares two
  // commits and ignored the working tree entirely, so a tampered checkout
  // passed. This pins the fix.
  const target = path.join(repoRoot, "main.js");
  const original = fs.readFileSync(target);
  try {
    fs.writeFileSync(target, Buffer.concat([original, Buffer.from("\n// tamper\n")]));
    assert.equal(runGate().status, 1, "an uncommitted application edit must fail the gate");
    // Explicitly asking for HEAD still compares commits, and must say so.
    assert.match(runGate([featureSha, "HEAD"]).out, /\.\.HEAD:/);
  } finally {
    fs.writeFileSync(target, original);
  }
  assert.equal(runGate().status, 0);
});

test("index lines are stripped, so the digest pins content and not blob ids", () => {
  const diff = isolationDiff(featureSha, null, repoRoot);
  assert.ok(diff.length > 0);
  assert.equal(
    diff.split("\n").filter((l) => l.startsWith("index ")).length,
    0,
    "index lines must not reach the digest"
  );
  assert.ok(diff.includes("diff --git a/main.js"));
});

test("packaging-owned paths are deliberately NOT pinned", () => {
  // Pinning them would mean re-pinning on every packaging edit, which trains
  // a reviewer to re-pin without looking.
  for (const owned of ["validation/READ-ME-FIRST.txt", "scripts/validation/asarPaths.js"]) {
    assert.ok(!APP_FILES.includes(owned), `${owned} must not be in the isolation pin`);
  }
});

test("the pinned feature SHA is a real commit in this repository", () => {
  assert.match(featureSha, /^[0-9a-f]{40}$/);
  execFileSync("git", ["cat-file", "-e", `${featureSha}^{commit}`], { cwd: repoRoot });
});
