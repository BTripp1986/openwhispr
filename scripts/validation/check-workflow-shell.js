#!/usr/bin/env node
// TEST-ONLY — lives on the `validation/*` branch. See VALIDATION_BUILD.md.
//
// Syntax-checks every bash `run:` block in the validation workflow with
// `bash -n`, because a quoting mistake there is only discovered when CI runs,
// after a push that also triggers a build.
//
// The motivating failure: a BUILD-INFO prose line containing an apostrophe was
// added inside a `node -e '...'` body. The apostrophe closed the shell's
// single-quoted string, and the whole step died with "unexpected EOF while
// looking for matching quote" — valid YAML, valid JavaScript, broken shell.
//
// Usage: node scripts/validation/check-workflow-shell.js [workflow.yml ...]

const fs = require("fs");
const os = require("os");
const path = require("path");
const yaml = require("js-yaml");
const { spawnSync } = require("child_process");

const files = process.argv.slice(2);
if (files.length === 0) {
  files.push(path.join(".github", "workflows", "validation-windows-build.yml"));
}

let checked = 0;
let failed = 0;

for (const file of files) {
  if (!fs.existsSync(file)) {
    console.error(`MISSING  ${file}`);
    failed++;
    continue;
  }
  const doc = yaml.load(fs.readFileSync(file, "utf8"));
  for (const [jobId, job] of Object.entries(doc?.jobs ?? {})) {
    // A job-level `defaults.run.shell` applies to every step without its own.
    const jobShell = job?.defaults?.run?.shell;
    const steps = Array.isArray(job?.steps) ? job.steps : [];
    steps.forEach((step, index) => {
      if (typeof step?.run !== "string") return;
      const shell = step.shell ?? jobShell ?? "bash";
      // Only bash-family shells are checkable here; pwsh/python blocks are not.
      if (!/^(bash|sh)$/.test(shell)) return;
      const name = step.name || `step ${index + 1}`;
      const tmp = path.join(
        fs.mkdtempSync(path.join(os.tmpdir(), "ow-workflow-shell-")),
        "block.sh"
      );
      fs.writeFileSync(tmp, step.run);
      const res = spawnSync("bash", ["-n", tmp], { encoding: "utf8" });
      checked++;
      if (res.status === 0) {
        console.log(`  ok      ${jobId} / ${name}`);
      } else {
        failed++;
        const detail = (res.stderr || "").replace(new RegExp(tmp, "g"), "<block>").trim();
        console.log(`  FAIL    ${jobId} / ${name}`);
        console.log(`          ${detail.split("\n").join("\n          ")}`);
      }
      fs.rmSync(path.dirname(tmp), { recursive: true, force: true });
    });
  }
}

console.log(
  `\n${failed === 0 ? "PASS" : "FAIL"}: ${checked - failed}/${checked} bash run blocks parse.`
);
process.exit(failed === 0 ? 0 : 1);
