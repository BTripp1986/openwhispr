// TEST-ONLY native Electron smoke for the dictation-cleanup-hotkeys candidate.
//
// What it is: the real main process, real preload and the built renderer,
// launched on the host platform with an isolated appData, driven over CDP
// through the app's OWN preload bridge (`window.electronAPI`). No app test
// hook, no source change, no added dependency - CDP is spoken with node's
// built-in fetch and WebSocket.
//
// What it is NOT:
//   * it never presses a key. Registration through Electron's globalShortcut
//     is not OS keyboard activation.
//   * it does NOT exercise the platform key-listener helpers
//     (windows-key-listener.exe, macos-globe-listener). Those serve
//     push-to-talk key-down/key-up and the macOS Globe key; this harness
//     neither compiles nor probes them, so nothing here may be read as
//     evidence about them. The native-suite workflow is where they are
//     compiled and probed.
//   * it records nothing, opens no microphone and calls no provider.
//
// Usage: node electron-smoke.js --repo <candidate root> --out <evidence dir>
//        [--port 9333]

const fs = require("node:fs");
const path = require("node:path");
const net = require("node:net");
const os = require("node:os");
const { spawn, execFileSync } = require("node:child_process");

const LAUNCHER = "xplat-electron-launcher.cjs";
// The preload exposes exactly one bridge, `electronAPI` (preload.js:65).
// There is no `window.api`; using it would make every probe silently report
// "not ready" and turn a working app into a false negative.
const BRIDGE = "window.electronAPI";

const checks = [];
let fatal = null;

function record(name, ok, detail) {
  checks.push({ name, ok, detail });
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}  ${detail ?? ""}`);
}

function args() {
  const out = {};
  const argv = process.argv.slice(2);
  for (let i = 0; i < argv.length; i += 2) out[argv[i].replace(/^--/, "")] = argv[i + 1];
  return out;
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// Every await on the app gets its own deadline. Without this a hung CDP
// socket outlives the readiness deadline and the whole run stalls.
function withTimeout(promise, ms, label) {
  let timer;
  const guard = new Promise((_, reject) => {
    timer = setTimeout(() => reject(new Error(`${label} timed out after ${ms}ms`)), ms);
    timer.unref?.();
  });
  return Promise.race([promise, guard]).finally(() => clearTimeout(timer));
}

async function listTargets(port) {
  const res = await withTimeout(
    fetch(`http://127.0.0.1:${port}/json/list`),
    5000,
    "CDP /json/list"
  );
  const list = await res.json();
  return list.filter((t) => t.type === "page" && t.webSocketDebuggerUrl);
}

function connect(url, timeoutMs = 15000) {
  return withTimeout(
    new Promise((resolve, reject) => {
      const ws = new WebSocket(url);
      let nextId = 0;
      const pending = new Map();
      const failAll = (error) => {
        for (const entry of pending.values()) entry.reject(error);
        pending.clear();
      };
      ws.addEventListener("message", (event) => {
        let message;
        try {
          message = JSON.parse(event.data);
        } catch {
          return;
        }
        const entry = pending.get(message.id);
        if (!entry) return;
        pending.delete(message.id);
        if (message.error) entry.reject(new Error(JSON.stringify(message.error)));
        else entry.resolve(message.result);
      });
      ws.addEventListener("error", () => {
        failAll(new Error("CDP socket error"));
        reject(new Error(`cannot open ${url}`));
      });
      ws.addEventListener("close", () => failAll(new Error("CDP socket closed")));
      ws.addEventListener("open", () =>
        resolve({
          ws,
          send(method, params = {}, ms = 20000) {
            return withTimeout(
              new Promise((res, rej) => {
                const id = ++nextId;
                pending.set(id, { resolve: res, reject: rej });
                ws.send(JSON.stringify({ id, method, params }));
              }),
              ms,
              `CDP ${method}`
            );
          },
        })
      );
    }),
    timeoutMs,
    `CDP connect ${url}`
  );
}

async function evaluate(session, expression) {
  const result = await session.send("Runtime.evaluate", {
    expression,
    awaitPromise: true,
    returnByValue: true,
  });
  if (result.exceptionDetails) {
    throw new Error(
      result.exceptionDetails.exception?.description ||
        result.exceptionDetails.text ||
        "evaluate threw"
    );
  }
  return result.result?.value;
}

// Readiness is waited for, never assumed: main awaits loadFile(), so touching
// a renderer the moment its target appears can land in the document that load
// is about to replace - and a reload there can abort the load main is still
// awaiting. A window counts as ready only once document.readyState is
// "complete" AND the preload bridge is present. Nothing here ever reloads.
async function openFeatureWindow(port, handle, timeoutMs = 180000) {
  const deadline = Date.now() + timeoutMs;
  const sessions = new Map();
  const PROBE =
    `(() => ({ rs: document.readyState, bridge: typeof ${BRIDGE},` +
    ` hasApi: Boolean(${BRIDGE} && ${BRIDGE}.getDictationHotkeyConfig` +
    ` && ${BRIDGE}.applyDictationHotkeys), url: location.href }))()`;
  let lastSeen = [];
  const closeAll = (keep) => {
    for (const [id, session] of sessions) {
      if (id === keep) continue;
      try {
        session.ws.close();
      } catch {}
    }
  };
  while (Date.now() < deadline) {
    // Fail early and loudly rather than waiting out the deadline on a process
    // that is already gone.
    const gone = handle?.exited();
    if (gone) {
      closeAll(null);
      throw new Error(
        `the app exited before a renderer was ready (code=${gone.code}, signal=${gone.signal})`
      );
    }
    let pages = [];
    try {
      pages = await listTargets(port);
    } catch (error) {
      lastSeen = [{ error: error.message }];
      await sleep(1000);
      continue;
    }
    lastSeen = [];
    for (const page of pages) {
      try {
        if (!sessions.has(page.id)) {
          const session = await connect(page.webSocketDebuggerUrl);
          await session.send("Runtime.enable");
          sessions.set(page.id, session);
        }
        const state = await evaluate(sessions.get(page.id), PROBE);
        lastSeen.push({ url: page.url, ...state });
        if (state?.rs === "complete" && state?.hasApi) {
          closeAll(page.id);
          // The load finished, but main's own post-load work (window
          // publication, startup hotkey registration) may still be settling,
          // so give it a moment before the first mutation.
          await sleep(1500);
          return { session: sessions.get(page.id), page, pages: lastSeen, targetCount: pages.length };
        }
      } catch (error) {
        lastSeen.push({ url: page.url, error: error.message });
      }
    }
    await sleep(1000);
  }
  closeAll(null);
  throw new Error(`no renderer became ready with the dictation bridge: ${JSON.stringify(lastSeen)}`);
}

function launch(opts) {
  const electron = require(path.join(opts.repo, "node_modules", "electron"));
  const extra = process.platform === "linux" ? ["--no-sandbox", "--disable-gpu"] : [];
  const child = spawn(
    electron,
    [path.join(opts.repo, LAUNCHER), `--remote-debugging-port=${opts.port}`, ...extra],
    {
      cwd: opts.repo,
      env: {
        ...process.env,
        XPLAT_APPDATA: opts.appData,
        // The app's own isolated test channel, as the accepted Windows test
        // build uses. NODE_ENV is deliberately unset so the built renderer is
        // loaded from disk rather than from a dev server.
        OPENWHISPR_CHANNEL: "staging",
        NODE_ENV: "",
      },
      stdio: ["ignore", "pipe", "pipe"],
    }
  );
  const out = [];
  let paths = null;
  const absorb = (buf) => {
    const text = buf.toString();
    out.push(text);
    for (const line of text.split(/\r?\n/)) {
      if (line.startsWith("XPLAT_PATHS ")) {
        try {
          paths = JSON.parse(line.slice("XPLAT_PATHS ".length));
        } catch {}
      }
    }
  };
  child.stdout.on("data", absorb);
  child.stderr.on("data", absorb);
  const exited = () =>
    child.exitCode !== null || child.signalCode
      ? { code: child.exitCode, signal: child.signalCode }
      : null;
  return {
    child,
    pid: child.pid,
    exited,
    log: () => out.join(""),
    paths: () => paths,
    // Requires a real exit. SIGKILL is recorded as `forced`, which is a
    // failure: a hang must not be reported as a clean shutdown.
    async stop() {
      if (exited()) return { ...exited(), forced: false, exited: true };
      child.kill("SIGTERM");
      for (let i = 0; i < 60 && !exited(); i += 1) await sleep(250);
      if (!exited()) {
        child.kill("SIGKILL");
        for (let i = 0; i < 20 && !exited(); i += 1) await sleep(250);
        return { ...(exited() ?? { code: null, signal: null }), forced: true, exited: Boolean(exited()) };
      }
      return { ...exited(), forced: false, exited: true };
    },
  };
}

// Not everything the app writes follows appData. cliBridge.js builds its path
// from os.homedir() unconditionally, so a CLI bridge file lands under $HOME
// whatever appData says. HOME is deliberately NOT overridden, so this is
// recorded as a disclosure instead of being claimed as isolated.
//
// METADATA ONLY. The bridge file holds a generated bearer token, so its
// contents are never read, printed or uploaded.
function homeFootprint() {
  const dir = path.join(os.homedir(), ".openwhispr");
  try {
    if (!fs.existsSync(dir)) return { dir, existed: false, entries: [] };
    const entries = fs.readdirSync(dir).map((name) => {
      try {
        const st = fs.statSync(path.join(dir, name));
        return { name, bytes: st.size, mode: (st.mode & 0o777).toString(8), mtime: st.mtime.toISOString() };
      } catch (error) {
        return { name, error: error.message };
      }
    });
    return { dir, existed: true, entries };
  } catch (error) {
    return { dir, error: error.message };
  }
}

// Positive evidence that nothing holds the port: bind it. A failed CDP fetch
// proves only that the endpoint did not answer - a hiccup, a refused
// connection and a parse error all look identical - so it is recorded
// alongside, never used as the assertion.
function portFree(port) {
  return new Promise((resolve) => {
    const server = net.createServer();
    server.once("error", (error) => resolve({ free: false, code: error.code }));
    server.once("listening", () => server.close(() => resolve({ free: true, code: null })));
    server.listen(port, "127.0.0.1");
  });
}

async function cdpAnswers(port) {
  try {
    await listTargets(port);
    return true;
  } catch {
    return false;
  }
}

// Electron runs a process tree (renderer, GPU, utility), so the direct child's
// exit says nothing about its descendants. This takes a real OS snapshot and
// attributes by the candidate path, and reports "unavailable" rather than
// implying an empty result when the snapshot itself cannot be taken.
function processSnapshot(repo) {
  // Match the ELECTRON BINARY path, not the repo path plus the word
  // "electron": this driver's own argv contains both (`--repo <repo>` and
  // `electron-smoke.js`), so a looser needle makes the driver match itself and
  // report a leftover that does not exist. Its own pid is excluded too.
  const needle = path.join(repo, "node_modules", "electron");
  const notSelf = (pid) => pid !== process.pid;
  try {
    if (process.platform === "win32") {
      const raw = execFileSync(
        "powershell",
        [
          "-NoProfile",
          "-NonInteractive",
          "-Command",
          "Get-CimInstance Win32_Process -Filter \"Name='electron.exe'\" |" +
            " Select-Object ProcessId,ParentProcessId,CommandLine | ConvertTo-Json -Compress",
        ],
        { encoding: "utf8", timeout: 30000 }
      ).trim();
      if (!raw) return { available: true, matches: [] };
      const parsed = JSON.parse(raw);
      const rows = Array.isArray(parsed) ? parsed : [parsed];
      return {
        available: true,
        matches: rows
          .filter(
            (r) => String(r.CommandLine ?? "").includes(needle) && notSelf(r.ProcessId)
          )
          .map((r) => ({ pid: r.ProcessId, ppid: r.ParentProcessId })),
      };
    }
    const raw = execFileSync("ps", ["-Ao", "pid=,ppid=,command="], {
      encoding: "utf8",
      timeout: 30000,
    });
    return {
      available: true,
      matches: raw
        .split("\n")
        .filter((line) => line.includes(needle))
        .map((line) => {
          const m = /^\s*(\d+)\s+(\d+)\s+/.exec(line);
          return { pid: m ? Number(m[1]) : null, ppid: m ? Number(m[2]) : null };
        })
        .filter((row) => notSelf(row.pid)),
    };
  } catch (error) {
    return { available: false, error: error.message };
  }
}

const ROWS = [
  { key: "F13", mode: "cleaned" },
  { key: "F14", mode: "raw" },
  { key: "F15", mode: null },
  // Deliberately an un-canonicalized spelling: dictationHotkeyConfig.js
  // promises the stored profile keeps the user's ORIGINAL text, because
  // CommandOrControl resolves to Command on macOS and Control elsewhere, so a
  // canonical form would bake the authoring platform into the profile. Only a
  // real macOS and a real Windows run can show that both keep it.
  { key: "CommandOrControl+Shift+F16", mode: "cleaned" },
];

const shape = (rows) =>
  JSON.stringify((rows ?? []).map((r) => ({ key: r.key, mode: r.mode ?? null })));
const EXPECTED = shape(ROWS);

async function main() {
  const opts = args();
  const repo = path.resolve(opts.repo);
  const out = path.resolve(opts.out);
  const port = Number(opts.port || 9333);
  fs.mkdirSync(out, { recursive: true });
  const appData = path.join(out, "isolated-appdata");
  fs.mkdirSync(appData, { recursive: true });

  fs.copyFileSync(path.join(__dirname, LAUNCHER), path.join(repo, LAUNCHER));

  let first = null;
  let second = null;
  const report = { candidate: null, platform: process.platform, arch: process.arch, checks };
  try {
    report.candidate = execFileSync("git", ["rev-parse", "HEAD"], {
      cwd: repo,
      encoding: "utf8",
    }).trim();

    // ---- launch 1 -------------------------------------------------------
    first = launch({ repo, port, appData });
    const { session, page, pages, targetCount } = await openFeatureWindow(port, first);
    report.paths = first.paths();
    report.targets = pages;
    record(
      "startup: the real main process booted and a renderer finished loading with the preload bridge",
      true,
      `${targetCount} page target(s); ready: ${page.url.split("/").pop()}`
    );

    const p = report.paths;
    if (!p) {
      record("isolation: effective paths reported", false, "launcher printed no XPLAT_PATHS line");
    } else {
      const inside = (v) =>
        typeof v === "string" && path.resolve(v).startsWith(path.resolve(appData));
      record(
        "isolation: appData and userData really resolve inside the harness directory",
        inside(p.appData) && inside(p.userData),
        `appData=${p.appData} userData=${p.userData} (HOME was not overridden; it stayed ${p.home})`
      );
      record(
        "isolation: the channel put userData on its own profile",
        /OpenWhispr-staging$/.test(p.userData || ""),
        `userData=${p.userData} channel=${p.channel}`
      );
    }

    // Disclosed, not asserted: this is a footprint record, so it passes as
    // long as the scan completed. It is the honest counterweight to the
    // isolation checks above - not every write the app makes is under appData.
    const home = homeFootprint();
    record(
      "disclosure: writes the app makes under $HOME, by metadata only (never the CLI bridge token)",
      !home.error,
      JSON.stringify(home)
    );

    const modeInfo = await evaluate(session, `${BRIDGE}.getHotkeyModeInfo()`);
    record("platform record: hotkey mode info", true, JSON.stringify(modeInfo));

    // The ONE place an Electron-ABI claim can be made: a real better-sqlite3
    // query through main, inside Electron, after the project's own
    // `electron-builder install-app-deps`. getTranscriptions returns an ARRAY
    // and throws on failure, so the assertion requires an array - not merely
    // a non-null value, which an error object would also satisfy.
    let dbProbe;
    let dbOk = false;
    try {
      dbProbe = await evaluate(session, `${BRIDGE}.getTranscriptions(1)`);
      dbOk = Array.isArray(dbProbe);
    } catch (error) {
      dbProbe = `threw: ${error.message}`;
    }
    record(
      "Electron ABI: better-sqlite3 returned a real query result (array) from inside Electron",
      dbOk,
      `${Array.isArray(dbProbe) ? `array(${dbProbe.length})` : "not an array"}: ${JSON.stringify(dbProbe).slice(0, 200)}`
    );

    const globalBefore = await evaluate(session, "localStorage.getItem('useCleanupModel')");
    const baseline = await evaluate(session, `${BRIDGE}.getDictationHotkeyConfig()`);
    record(
      "baseline: main reports its committed rows",
      Array.isArray(baseline?.rows),
      JSON.stringify(baseline)
    );

    // ---- apply per-row modes through the real native path ---------------
    const applied = await evaluate(
      session,
      `${BRIDGE}.applyDictationHotkeys(${JSON.stringify({ rows: ROWS })})`
    );
    record(
      "apply: four rows with per-row cleanup modes registered natively",
      applied?.success === true && applied?.degraded !== true,
      JSON.stringify(applied)
    );

    const readBack = await evaluate(session, `${BRIDGE}.getDictationHotkeyConfig()`);
    record(
      "apply: every row kept its own key AND its own mode, in order",
      shape(readBack?.rows) === EXPECTED,
      `got ${shape(readBack?.rows)}`
    );

    // ---- the stored profile must stay platform-portable ------------------
    const envPath = p?.userData ? path.join(p.userData, ".env") : null;
    const envText = envPath && fs.existsSync(envPath) ? fs.readFileSync(envPath, "utf8") : "";
    const storedRaw = /^DICTATION_HOTKEY_CONFIG=(.*)$/m.exec(envText)?.[1] ?? "";
    // environmentManager.encodeDictationHotkeyConfig base64-encodes the value,
    // so searching the stored text for the literal key would always miss.
    // Decode, then compare the parsed rows against what was asked for.
    let storedRows = null;
    let storedJson = "";
    try {
      const decoded = Buffer.from(storedRaw.trim().replace(/^"|"$/g, ""), "base64").toString("utf8");
      storedJson = decoded.includes('"key"') ? decoded : storedRaw;
      storedRows = JSON.parse(storedJson);
    } catch {
      storedJson = storedRaw;
    }
    record(
      "portability: the stored profile keeps the original spelling, not this platform's canonical form",
      shape(storedRows) === EXPECTED && storedJson.includes("CommandOrControl+Shift+F16"),
      storedRaw
        ? `decoded=${storedJson.slice(0, 240)}`
        : `no DICTATION_HOTKEY_CONFIG value in ${envPath}`
    );

    // ---- a refused edit must leave the working rows bound ---------------
    const refused = await evaluate(
      session,
      `${BRIDGE}.applyDictationHotkeys(${JSON.stringify({
        rows: [{ key: "F13", mode: "cleaned" }, { key: "ThisIsNotAKey", mode: "raw" }],
      })})`
    );
    const survived = await evaluate(session, `${BRIDGE}.getDictationHotkeyConfig()`);
    record(
      "refusal: an unregistrable key is refused and the working rows survive untouched",
      refused?.success === false && shape(survived?.rows) === EXPECTED,
      `result=${JSON.stringify(refused)} rows=${shape(survived?.rows)}`
    );

    const globalAfter = await evaluate(session, "localStorage.getItem('useCleanupModel')");
    record(
      "the global cleanup preference was never written by any of this",
      globalBefore === globalAfter,
      `before=${JSON.stringify(globalBefore)} after=${JSON.stringify(globalAfter)}`
    );

    session.ws.close();
    const firstExit = await first.stop();
    record(
      "shutdown: the app exited after SIGTERM without needing SIGKILL (a signal exit, not a proven graceful app.quit teardown)",
      firstExit.exited === true && firstExit.forced === false,
      JSON.stringify(firstExit)
    );
    const firstPort = await portFree(port);
    record(
      "shutdown: the debugging port can be bound again, so nothing still holds it",
      firstPort.free === true,
      `port ${port} free=${firstPort.free}${firstPort.code ? ` (${firstPort.code})` : ""}; cdp still answers=${await cdpAnswers(port)}`
    );
    const afterFirst = processSnapshot(repo);
    record(
      afterFirst.available
        ? "shutdown: an OS process snapshot shows no electron process left under the candidate path"
        : "shutdown: process snapshot unavailable, so no claim is made about descendants",
      afterFirst.available ? afterFirst.matches.length === 0 : true,
      JSON.stringify(afterFirst)
    );

    // ---- launch 2: persistence across a real restart --------------------
    second = launch({ repo, port: port + 1, appData });
    const again = await openFeatureWindow(port + 1, second);
    report.pathsSecond = second.paths();
    const persisted = await evaluate(again.session, `${BRIDGE}.getDictationHotkeyConfig()`);
    record(
      "restart: every row came back with both its key and its cleanup mode",
      shape(persisted?.rows) === EXPECTED,
      `got ${shape(persisted?.rows)}`
    );
    again.session.ws.close();
    const secondExit = await second.stop();
    record(
      "restart: the second instance exited after SIGTERM without needing SIGKILL (signal exit, not proven graceful teardown)",
      secondExit.exited === true && secondExit.forced === false,
      JSON.stringify(secondExit)
    );
    const secondPort = await portFree(port + 1);
    record(
      "restart: the second debugging port can be bound again",
      secondPort.free === true,
      `port ${port + 1} free=${secondPort.free}${secondPort.code ? ` (${secondPort.code})` : ""}`
    );
    const afterSecond = processSnapshot(repo);
    record(
      afterSecond.available
        ? "restart: an OS process snapshot shows no electron process left under the candidate path"
        : "restart: process snapshot unavailable, so no claim is made about descendants",
      afterSecond.available ? afterSecond.matches.length === 0 : true,
      JSON.stringify(afterSecond)
    );
  } catch (error) {
    fatal = error.stack || String(error);
    record("harness", false, `aborted: ${error.message}`);
  } finally {
    try {
      fs.rmSync(path.join(repo, LAUNCHER), { force: true });
    } catch {}
    // Nothing test-owned may outlive the run.
    const firstFinal = first ? await first.stop() : null;
    const secondFinal = second ? await second.stop() : null;
    report.cleanup = {
      launcherRemoved: !fs.existsSync(path.join(repo, LAUNCHER)),
      first: firstFinal,
      second: secondFinal,
      portsFree: {
        [port]: await portFree(port),
        [port + 1]: await portFree(port + 1),
      },
      processSnapshot: processSnapshot(repo),
    };
    const leftovers =
      (firstFinal && firstFinal.exited !== true) ||
      (secondFinal && secondFinal.exited !== true) ||
      !report.cleanup.launcherRemoved ||
      Object.values(report.cleanup.portsFree).some((p) => p.free !== true) ||
      (report.cleanup.processSnapshot.available &&
        report.cleanup.processSnapshot.matches.length > 0);
    // Wording is exactly what the evidence supports: the direct children
    // exited, both ports bind again, the launcher is gone, and an OS snapshot
    // (when it could be taken) found no electron process under the candidate
    // path. A snapshot that could not be taken makes no descendant claim.
    record(
      "cleanup: direct children exited, both ports bind again, launcher removed, and the process snapshot is clean",
      !leftovers,
      JSON.stringify(report.cleanup)
    );

    const logs = [];
    if (first) logs.push(`===== launch 1 (pid ${first.pid}) =====\n${first.log()}`);
    if (second) logs.push(`===== launch 2 (pid ${second.pid}) =====\n${second.log()}`);
    fs.writeFileSync(path.join(out, "electron-smoke-app.log"), logs.join("\n\n"));
    report.fatal = fatal;
    // Derived from `checks` at write time, AFTER every record above including
    // the cleanup assertions, and carrying its own reconciliation so a later
    // edit that records a check past this point cannot leave the JSON
    // disagreeing with its own array.
    report.total = checks.length;
    report.passed = checks.filter((c) => c.ok).length;
    report.failed = checks.filter((c) => !c.ok).length;
    report.reconciles = report.passed + report.failed === report.total;
    fs.writeFileSync(path.join(out, "electron-smoke-report.json"), JSON.stringify(report, null, 2));
  }

  const failed = checks.filter((c) => !c.ok);
  const passed = checks.length - failed.length;
  console.log(
    `\nSMOKE_TOTAL=${checks.length} SMOKE_PASSED=${passed} SMOKE_FAILED=${failed.length}` +
      ` SMOKE_RECONCILES=${passed + failed.length === checks.length}`
  );
  for (const check of failed) console.log(`STILL_FAILING: ${check.name} :: ${check.detail}`);
  process.exit(failed.length === 0 ? 0 : 1);
}

main();
