// TEST-ONLY. MEASURES; it asserts nothing, changes no source and changes no
// assertion. It exists to explain one Intel failure with numbers.
//
// test/helpers/textEditMonitorSelection.test.js:33 asserts
//   Date.now() - start < 3000
// around `getSelectedText(99999999, 1500)`. On macos-15-intel that case took
// 3023.677 ms; on macos-15 (arm64) it passed. The behavioural assertion on the
// line above it PASSED on both - only the wall-clock budget failed.
//
// textEditMonitor.getSelectedText runs two legs SEQUENTIALLY, each with the
// SAME timeout: the native `macos-text-monitor --selected-text <pid>` through
// execFile({timeout}), and then osascript as a fallback. With timeoutMs=1500
// the worst case is therefore ~3000 ms of timeouts plus two process spawns,
// against a `< 3000` budget. This measures each leg so the margin is visible
// rather than guessed at.
//
// A fresh TextEditMonitor is used per run, exactly as the test does, because
// the instance remembers pids whose native lookup failed
// (_nativeSelectionUnsupportedPids) and would skip the native leg on a reuse.
//
// Usage: node measure-selected-text.js <repo root> [runs]

const path = require("node:path");
const { execFile } = require("node:child_process");

const repo = path.resolve(process.argv[2] || process.cwd());
const runs = Number(process.argv[3] || 5);
const PID = 99999999;
const TIMEOUT_MS = 1500;

const TextEditMonitor = require(path.join(repo, "src/helpers/textEditMonitor"));
const ms = (from) => Number(process.hrtime.bigint() - from) / 1e6;

function timeNativeLeg(resolved) {
  return new Promise((resolve) => {
    const started = process.hrtime.bigint();
    execFile(
      resolved.command,
      [...resolved.args, "--selected-text", String(PID)],
      { timeout: TIMEOUT_MS },
      (error, stdout) => {
        resolve({
          elapsed: ms(started),
          outcome: error
            ? error.killed
              ? "killed by its own timeout"
              : `error ${error.code ?? error.message}`
            : `exited 0, stdout ${JSON.stringify(String(stdout).slice(0, 60))}`,
        });
      }
    );
  });
}

async function main() {
  const probe = new TextEditMonitor();
  const resolved = typeof probe.resolveBinary === "function" ? probe.resolveBinary() : null;
  console.log(`platform:        ${process.platform}/${process.arch}`);
  console.log(`node:            ${process.version}`);
  console.log(`timeout per leg: ${TIMEOUT_MS} ms`);
  console.log(`resolveBinary(): ${JSON.stringify(resolved)}`);
  console.log(
    resolved
      ? "the native leg WILL run, so both legs can time out in sequence"
      : "no native binary resolved, so only the osascript leg runs"
  );
  console.log("");

  const totals = [];
  for (let run = 1; run <= runs; run += 1) {
    // The native leg measured on its own first, with its own fresh process.
    const native = resolved ? await timeNativeLeg(resolved) : null;
    // Then the real call, on a fresh instance, exactly as the test makes it.
    const monitor = new TextEditMonitor();
    const started = process.hrtime.bigint();
    const result = await monitor.getSelectedText(PID, TIMEOUT_MS);
    const total = ms(started);
    totals.push(total);
    // On a non-darwin host getSelectedText short-circuits before either leg,
    // so the separately measured native leg is not part of `total` and a
    // subtraction would print nonsense.
    const rest = native && total >= native.elapsed ? total - native.elapsed : null;
    console.log(
      `run ${run}: total=${total.toFixed(1)}ms` +
        ` native_leg=${native ? native.elapsed.toFixed(1) + "ms" : "n/a"}` +
        ` remainder(osascript+overhead)=${rest === null ? "n/a (call did not include the native leg)" : rest.toFixed(1) + "ms"}` +
        ` under_3000=${total < 3000}` +
        ` result=${JSON.stringify(result)}` +
        (native ? ` native_outcome=${native.outcome}` : "")
    );
  }

  const sorted = [...totals].sort((a, b) => a - b);
  const over = totals.filter((t) => t >= 3000).length;
  console.log("");
  console.log(
    `min=${sorted[0].toFixed(1)}ms median=${sorted[Math.floor(sorted.length / 2)].toFixed(1)}ms` +
      ` max=${sorted[sorted.length - 1].toFixed(1)}ms` +
      ` runs_at_or_over_3000=${over}/${totals.length}`
  );
  // Reported, not judged: whether the budget holds is the owner's call, and
  // this script never decides that a test is flaky.
  console.log(`BUDGET_3000_EXCEEDED=${over}`);
}

main();
