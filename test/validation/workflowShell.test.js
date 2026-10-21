// TEST-ONLY — lives on the `validation/*` branch. See VALIDATION_BUILD.md.
//
// Covers scripts/validation/check-workflow-shell.js, which exists because a
// quoting mistake in a workflow `run:` block is valid YAML and is only found
// when CI runs — after a push that also triggers a Windows build.

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { spawnSync } = require("node:child_process");

const REPO_ROOT = path.resolve(__dirname, "..", "..");
const CHECKER = path.join(REPO_ROOT, "scripts", "validation", "check-workflow-shell.js");
const WORKFLOW = path.join(REPO_ROOT, ".github", "workflows", "validation-windows-build.yml");

function run(args) {
  return spawnSync(process.execPath, [CHECKER, ...args], { encoding: "utf8", cwd: REPO_ROOT });
}

function writeWorkflow(yml) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "ow-workflow-shell-test-"));
  const file = path.join(dir, "workflow.yml");
  fs.writeFileSync(file, yml);
  return file;
}

test("the real validation workflow's shell blocks all parse", () => {
  const { status, stdout } = run([WORKFLOW]);
  assert.equal(status, 0, stdout);
  assert.match(stdout, /PASS: \d+\/\d+ bash run blocks parse\./);
});

test("an apostrophe inside a node -e single-quoted body is caught", () => {
  // The exact defect this checker was written for: valid YAML, valid
  // JavaScript, but the apostrophe closes the shell's single-quoted string.
  const file = writeWorkflow(
    [
      "on: push",
      "jobs:",
      "  build:",
      "    runs-on: ubuntu-latest",
      "    steps:",
      "      - name: Write the build manifest",
      "        shell: bash",
      "        run: |",
      "          node -e '",
      '            const info = ["An earlier candidate\'s profile is untouched"];',
      "            console.log(info);",
      "          '",
      "",
    ].join("\n")
  );
  const { status, stdout } = run([file]);
  assert.equal(status, 1);
  assert.match(stdout, /FAIL {4}build \/ Write the build manifest/);
  assert.match(stdout, /unexpected EOF/);
});

test("the same body inside a quoted heredoc passes", () => {
  const file = writeWorkflow(
    [
      "on: push",
      "jobs:",
      "  build:",
      "    runs-on: ubuntu-latest",
      "    steps:",
      "      - name: Write the build manifest",
      "        shell: bash",
      "        run: |",
      "          node <<'NODE'",
      '            const info = ["An earlier candidate\'s profile is untouched"];',
      "            console.log(info);",
      "          NODE",
      "",
    ].join("\n")
  );
  const { status, stdout } = run([file]);
  assert.equal(status, 0, stdout);
});

test("a job-level default shell is honoured and non-bash shells are skipped", () => {
  const file = writeWorkflow(
    [
      "on: push",
      "jobs:",
      "  build:",
      "    runs-on: windows-latest",
      "    defaults:",
      "      run:",
      "        shell: bash",
      "    steps:",
      "      - name: inherits bash and is broken",
      "        run: |",
      '          echo "unterminated',
      "      - name: powershell is not checkable here",
      "        shell: pwsh",
      "        run: |",
      '          Write-Host "it\'s fine"',
      "",
    ].join("\n")
  );
  const { status, stdout } = run([file]);
  assert.equal(status, 1);
  assert.match(stdout, /FAIL {4}build \/ inherits bash and is broken/);
  assert.doesNotMatch(stdout, /powershell is not checkable here/);
});

test("a missing workflow file is reported rather than silently passing", () => {
  const { status, stderr } = run([path.join(os.tmpdir(), "definitely-not-here.yml")]);
  assert.equal(status, 1);
  assert.match(stderr, /MISSING/);
});
