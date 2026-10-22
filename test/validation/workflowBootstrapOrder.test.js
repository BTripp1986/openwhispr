// TEST-ONLY — validation branch.
//
// Run 39710513561 failed in 43 seconds: "Gate — every workflow shell block
// parses" runs check-workflow-shell.js, which requires js-yaml, and it sat
// AHEAD of `npm ci`. It had never run in CI before — the gate was added on
// this branch and validation/** had not been pushed since — so its first real
// execution was also its first failure. The steps after it then ran anyway on
// `if: ${{ !cancelled() }}`, with no node_modules, and buried the real cause
// under "Cannot find module 'better-sqlite3'".
//
// These assertions are about ORDER and CONDITIONS, so they catch the class,
// not just the one instance.
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const yaml = require("js-yaml");

const repoRoot = path.resolve(__dirname, "..", "..");
const workflowDir = path.join(repoRoot, ".github", "workflows");
// test-preflight.yml lives on the test-preflight/** branch, deliberately not
// on validation/** — a tests-only run must not sit on a branch a build
// workflow triggers from. So it is checked when present and skipped with a
// reason when it is not, rather than silently passing.
const workflowPath = (file) => path.join(workflowDir, file);
const present = (file) => fs.existsSync(workflowPath(file));
const load = (file) => yaml.load(fs.readFileSync(workflowPath(file), "utf8"));

// Which scripts need something from node_modules, read from the scripts
// themselves rather than hardcoded, so a new dependency is covered too.
const BUILTINS = new Set([
  "fs", "path", "os", "crypto", "child_process", "util", "assert", "events",
  "url", "stream", "zlib", "http", "https", "net", "tty", "readline", "buffer",
]);
function needsDependencies(scriptPath) {
  const full = path.join(repoRoot, scriptPath);
  if (!fs.existsSync(full)) return false;
  const source = fs.readFileSync(full, "utf8");
  return [...source.matchAll(/require\("([^"]+)"\)/g)]
    .map((m) => m[1])
    .some((id) => !id.startsWith(".") && !BUILTINS.has(id.replace(/^node:/, "")));
}

const stepsOf = (wf, job) => wf.jobs[job].steps;
const indexOfInstall = (steps) =>
  steps.findIndex((s) => typeof s.run === "string" && /\bnpm (ci|install)\b/.test(s.run));

function scriptsIn(step) {
  if (typeof step.run !== "string") return [];
  return [...step.run.matchAll(/node\s+(scripts\/validation\/[\w.-]+\.js)/g)].map((m) => m[1]);
}

for (const [file, jobs] of [
  ["validation-windows-build.yml", ["guard", "build-windows"]],
  ["test-preflight.yml", ["tests"]],
]) {
  test(`${file}: no step runs a dependency-requiring script before npm ci`, (t) => {
    if (!present(file)) return t.skip(`${file} is not on this branch`);
    const wf = load(file);
    for (const job of jobs) {
      const steps = stepsOf(wf, job);
      const install = indexOfInstall(steps);
      steps.forEach((step, i) => {
        for (const script of scriptsIn(step)) {
          if (!needsDependencies(script)) continue;
          assert.ok(
            install !== -1 && i > install,
            `${job} step ${i} ("${step.name}") runs ${script}, which needs node_modules, ` +
              `but ${install === -1 ? "the job never installs dependencies" : `npm ci is step ${install}`}`
          );
        }
      });
    }
  });
}

test("guard: the two builtin-only gates still run BEFORE the install, so a bad branch fails fast", () => {
  const steps = stepsOf(load("validation-windows-build.yml"), "guard");
  const install = indexOfInstall(steps);
  for (const script of [
    "scripts/validation/check-packaging-only-diff.js",
    "scripts/validation/check-isolation-diff.js",
  ]) {
    assert.equal(needsDependencies(script), false, `${script} gained a dependency`);
    const at = steps.findIndex((s) => scriptsIn(s).includes(script));
    assert.notEqual(at, -1, `${script} is not run by the guard job at all`);
    assert.ok(at < install, `${script} must stay ahead of npm ci (it is step ${at}, install is ${install})`);
  }
});

test("guard: steps that need the install do not run after a failed prerequisite", () => {
  const steps = stepsOf(load("validation-windows-build.yml"), "guard");
  for (const name of [
    "Build better-sqlite3 for the runner's node and open it",
    "Run the test suite",
    "Lint, typecheck, translations",
  ]) {
    const step = steps.find((s) => s.name === name);
    assert.ok(step, `missing step: ${name}`);
    assert.equal(
      step.if,
      undefined,
      `"${name}" must have no \`if:\` — \`!cancelled()\` ran it without node_modules and hid the real failure`
    );
  }
});

test("guard: failure is still always collected", () => {
  const steps = stepsOf(load("validation-windows-build.yml"), "guard");
  const totals = steps.find((s) => s.name === "Record the real suite totals");
  const upload = steps.find((s) => (s.uses || "").startsWith("actions/upload-artifact"));
  assert.match(String(totals.if), /always\(\)/);
  assert.match(String(upload.if), /always\(\)/);
});

test("every workflow on this branch still refuses to run outside Ben's fork", () => {
  const checked = [];
  for (const [file, jobs] of [
    ["validation-windows-build.yml", ["guard"]],
    ["test-preflight.yml", ["tests"]],
  ]) {
    if (!present(file)) continue;
    checked.push(file);
    const wf = load(file);
    for (const job of jobs) {
      const first = stepsOf(wf, job)[0];
      assert.match(String(first.if), /github\.repository != 'BTripp1986\/openwhispr'/);
    }
  }
  assert.ok(checked.includes("validation-windows-build.yml"), "the build workflow must be on this branch");
});
