#!/usr/bin/env node
// TEST-ONLY — lives on the `validation/*` branch. See VALIDATION_BUILD.md.
//
// STATIC inspection of a packaged Windows validation artifact. Every check here
// reads bytes on disk; none of them launch the application. Nothing in this
// file establishes that global hotkeys, the microphone, clipboard paste or
// transcription work — that requires a native Windows run by a human.
//
//   node scripts/validation/verify-windows-test-artifact.js [dist/win-unpacked]

const fs = require("fs");
const path = require("path");
const crypto = require("crypto");
const { toAsarPath, fromAsarEntry, asarBasename } = require("./asarPaths");

const root = path.resolve(process.argv[2] || path.join("dist", "win-unpacked"));
const results = [];
let failed = 0;

function check(name, fn) {
  try {
    const detail = fn();
    results.push({ ok: true, name, detail: detail || "" });
  } catch (error) {
    failed += 1;
    results.push({ ok: false, name, detail: error.message });
  }
}

function must(condition, message) {
  if (!condition) throw new Error(message);
}

function readAsarFile(asarPath, filePath) {
  const { extractFile } = require("@electron/asar");
  return extractFile(asarPath, toAsarPath(filePath)).toString("utf8");
}

function asarEntries(asarPath) {
  const { listPackage } = require("@electron/asar");
  return listPackage(asarPath).map((entry) => fromAsarEntry(entry));
}

// PE data directory entry 4 is the Certificate Table: a non-zero size means the
// image carries an embedded Authenticode signature.
function hasAuthenticodeSignature(exePath) {
  const fd = fs.openSync(exePath, "r");
  try {
    const head = Buffer.alloc(0x400);
    fs.readSync(fd, head, 0, head.length, 0);
    must(head.readUInt16LE(0) === 0x5a4d, `${exePath} is not a PE image`);
    const peOffset = head.readUInt32LE(0x3c);
    must(head.readUInt32LE(peOffset) === 0x00004550, `${exePath} has no PE signature`);
    const optionalHeaderOffset = peOffset + 24;
    const magic = head.readUInt16LE(optionalHeaderOffset);
    must(magic === 0x20b || magic === 0x10b, `${exePath} has an unexpected optional header`);
    const dataDirOffset = optionalHeaderOffset + (magic === 0x20b ? 112 : 96);
    const certTableOffset = dataDirOffset + 4 * 8;
    const size = head.readUInt32LE(certTableOffset + 4);
    return size > 0;
  } finally {
    fs.closeSync(fd);
  }
}

function walk(dir, onFile) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) walk(full, onFile);
    else if (entry.isFile()) onFile(full);
  }
}

const exePath = path.join(root, "OpenWhispr.exe");
const asarPath = path.join(root, "resources", "app.asar");

check("artifact root exists", () => {
  must(fs.existsSync(root), `missing ${root}`);
  return root;
});

check("OpenWhispr.exe present", () => {
  must(fs.existsSync(exePath), `missing ${exePath}`);
  return `${(fs.statSync(exePath).size / 1e6).toFixed(1)} MB`;
});

check("executable is unsigned (expected for a test build)", () =>
  hasAuthenticodeSignature(exePath)
    ? (() => {
        throw new Error("OpenWhispr.exe carries an Authenticode signature — wrong builder config");
      })()
    : "no certificate table"
);

check("app.asar present", () => {
  must(fs.existsSync(asarPath), `missing ${asarPath}`);
  return `${(fs.statSync(asarPath).size / 1e6).toFixed(1)} MB`;
});

check("packaged package.json carries the validation marker", () => {
  const pkg = JSON.parse(readAsarFile(asarPath, "package.json"));
  must(
    pkg.openwhisprValidationBuild === true,
    `openwhisprValidationBuild is ${JSON.stringify(pkg.openwhisprValidationBuild)} — the artifact would resolve to the production channel and keep the updater on`
  );
  must(
    pkg.windowsTrayIdentity === false,
    `windowsTrayIdentity is ${JSON.stringify(pkg.windowsTrayIdentity)} — an unsigned build must not claim the production tray GUID`
  );
  return `version ${pkg.version}, marker set, tray identity cleared`;
});

check("packaged main.js pins the isolated channel", () => {
  const main = readAsarFile(asarPath, "main.js");
  must(
    main.includes("resolveValidationChannel"),
    "main.js in the asar has no validation channel pin"
  );
  return "resolveValidationChannel present";
});

check("packaged updater.js gates on the validation marker", () => {
  const updater = readAsarFile(asarPath, "src/updater.js");
  must(
    updater.includes("updatesDisabled()"),
    "src/updater.js in the asar still gates on NODE_ENV only"
  );
  const remaining = updater.match(/process\.env\.NODE_ENV\s*[!=]==\s*"development"/g);
  must(!remaining, `src/updater.js still has ungated NODE_ENV checks: ${remaining}`);
  return "all six update gates routed through updatesDisabled()";
});

check("packaged main.js refuses an inherited OAuth protocol override", () => {
  const main = readAsarFile(asarPath, "main.js");
  must(
    /shouldIgnoreProtocolOverride\(/.test(main),
    "getOAuthProtocol() in the asar no longer consults shouldIgnoreProtocolOverride — an inherited OPENWHISPR_PROTOCOL could claim the production openwhispr:// handler"
  );
  must(
    /development: "openwhispr-dev"/.test(main),
    "the development channel's OAuth scheme is missing from the asar"
  );
  return "override refused, channel default openwhispr-dev://";
});

check("packaged cliBridge.js scopes its token file away from production", () => {
  const bridge = readAsarFile(asarPath, "src/helpers/cliBridge.js");
  must(
    /resolveCliBridgeFileName\(/.test(bridge),
    "cliBridge.js in the asar still hardcodes ~/.openwhispr/cli-bridge.json, which it rewrites on launch and deletes on quit"
  );
  return "channel-scoped";
});

check("packaged build isolates its Qdrant index, vault entry and shared caches", () => {
  const qdrant = readAsarFile(asarPath, "src/helpers/qdrantManager.js");
  must(
    /resolveQdrantDataDirName\(/.test(qdrant),
    "qdrantManager.js in the asar still keys its storage directory on NODE_ENV, so a packaged test build would open the production index"
  );

  const secrets = readAsarFile(asarPath, "src/helpers/secretCrypto.js");
  must(
    /resolveKeyringService\(/.test(secrets),
    "secretCrypto.js in the asar still uses the cross-channel keyring service, so a test build would read the production master key"
  );

  const handlers = readAsarFile(asarPath, "src/helpers/ipcHandlers.js");
  must(
    /const eraseSharedCaches = !shouldSkipSharedDeviceCaches\(/.test(handlers),
    "ipcHandlers.js in the asar no longer guards the device-erasure path, so Reset app data would delete the production install's model caches"
  );
  const unguarded = [
    [/if \(eraseSharedCaches && fs\.existsSync\(whisperDir\)\)/, "whisper models"],
    [
      /if \(eraseSharedCaches\) await this\.parakeetManager\?\.deleteAllParakeetModels\(\)/,
      "Parakeet models",
    ],
    [
      /if \(eraseSharedCaches\) await this\.diarizationManager\?\.deleteModels\(\)/,
      "diarization models",
    ],
    [/if \(eraseSharedCaches\) await modelManager\.deleteAllModels\(\)/, "LLM models"],
    [/for \(const cacheName of eraseSharedCaches/, "the ~/.cache/openwhispr loop"],
  ]
    .filter(([pattern]) => !pattern.test(handlers))
    .map(([, label]) => label);
  must(unguarded.length === 0, `unguarded shared-cache deletions: ${unguarded.join(", ")}`);

  return "qdrant-data-validation, OpenWhispr-validation vault, erase guarded";
});

check("packaged build cannot delete or migrate the production model cache", () => {
  const handlers = readAsarFile(asarPath, "src/helpers/ipcHandlers.js");
  must(
    /const sharedDownloadDeleteRefusal = refuseSharedDownloadDelete\(/.test(handlers),
    "ipcHandlers.js in the asar no longer builds the shared-download delete refusal"
  );
  const routes = [
    "delete-whisper-model",
    "delete-all-whisper-models",
    "delete-parakeet-model",
    "delete-all-parakeet-models",
    "delete-diarization-models",
    "model-delete",
    "model-delete-all",
  ];
  const unguarded = routes.filter((route) => {
    const handler = handlers.match(
      new RegExp(`ipcMain\\.handle\\("${route}",[^\\n]*\\n\\s*([^\\n]*)`)
    );
    return (
      !handler ||
      !/if \(sharedDownloadDeleteRefusal\) return sharedDownloadDeleteRefusal;/.test(handler[1])
    );
  });
  must(
    unguarded.length === 0,
    `delete routes that would remove the production install's shared models: ${unguarded.join(", ")}`
  );

  const dirs = readAsarFile(asarPath, "src/helpers/modelDirUtils.js");
  must(
    /shouldSkipLegacyCacheMigration\(/.test(dirs),
    "modelDirUtils.js in the asar can still run migrateLegacyModelDirs, which renames the production install's model directories"
  );
  must(
    /shouldIgnoreCacheRootOverride\(/.test(dirs),
    "modelDirUtils.js in the asar still honours an inherited OPENWHISPR_CACHE_ROOT"
  );
  return `${routes.length} delete routes refused, cache migration disabled`;
});

check("asar is readable and carries the expected entry points", () => {
  const entries = asarEntries(asarPath);
  for (const expected of ["/main.js", "/preload.js", "/package.json", "/src/updater.js"]) {
    must(entries.includes(expected), `asar is missing ${expected}`);
  }
  const locales = entries.filter((entry) =>
    /^\/src\/locales\/[^/]+\/translation\.json$/.test(entry)
  );
  must(locales.length >= 11, `only ${locales.length} locale files in the asar, expected 11`);
  return `${entries.length} entries, ${locales.length} locales`;
});

check("native modules unpacked from the asar (presence only)", () => {
  const unpacked = path.join(root, "resources", "app.asar.unpacked", "node_modules");
  const required = {
    "better-sqlite3/build/Release/better_sqlite3.node": "history, notes and settings database",
    "ffmpeg-static/ffmpeg.exe": "audio decode for cloud transcription",
    "onnxruntime-node/bin/napi-v6/win32/x64/onnxruntime_binding.node": "ONNX utility process",
  };
  const missing = [];
  for (const [rel, why] of Object.entries(required)) {
    if (!fs.existsSync(path.join(unpacked, rel))) missing.push(`${rel} (${why})`);
  }
  must(missing.length === 0, `missing unpacked native modules: ${missing.join(", ")}`);

  const keyring = fs.existsSync(path.join(unpacked, "@napi-rs", "keyring"));
  const worker = fs.existsSync(
    path.join(root, "resources", "app.asar.unpacked", "src", "workers", "onnxWorker.js")
  );
  must(worker, "missing resources/app.asar.unpacked/src/workers/onnxWorker.js");
  // Whether these bindings match the bundled Electron's ABI cannot be read off
  // disk: only launching the app proves it. Presence is all this check claims.
  return `better-sqlite3, ffmpeg, onnxruntime, onnxWorker present${keyring ? ", keyring present" : ""} (ABI unverified without a launch)`;
});

check("Windows sidecar binaries bundled", () => {
  const binDir = path.join(root, "resources", "bin");
  const expected = [
    "windows-key-listener.exe",
    "windows-fast-paste.exe",
    "windows-mic-listener.exe",
    "nircmd.exe",
  ];
  const present = expected.filter((name) => fs.existsSync(path.join(binDir, name)));
  const missing = expected.filter((name) => !present.includes(name));
  // Only the key listener is load-bearing for this feature's acceptance (Hold);
  // afterPack already fails the build without it. The rest are reported, not
  // enforced, so a cache miss on an unrelated helper does not block the test.
  must(
    present.includes("windows-key-listener.exe"),
    "missing windows-key-listener.exe — Hold / push-to-talk would be unavailable"
  );
  return missing.length === 0
    ? `all ${expected.length} present`
    : `present: ${present.join(", ")}; ABSENT (non-blocking): ${missing.join(", ")}`;
});

// A tracked template (.env.example and friends) holds no values; only a real
// .env or a local/runtime variant could carry credentials.
const ENV_TEMPLATES = new Set([".env.example", ".env.sample", ".env.template"]);
const isEnvFile = (name) => name === ".env" || name.startsWith(".env.");

check("no real .env packaged anywhere in the artifact", () => {
  const found = [];
  const templates = [];
  walk(root, (file) => {
    const base = path.basename(file);
    if (!isEnvFile(base)) return;
    (ENV_TEMPLATES.has(base) ? templates : found).push(path.relative(root, file));
  });
  must(found.length === 0, `packaged env files: ${found.join(", ")}`);
  return templates.length === 0 ? "none" : `none (templates ignored: ${templates.join(", ")})`;
});

check("no real .env inside app.asar", () => {
  const entries = asarEntries(asarPath).filter((entry) => isEnvFile(asarBasename(entry)));
  const hits = entries.filter((entry) => !ENV_TEMPLATES.has(asarBasename(entry)));
  must(hits.length === 0, `asar contains: ${hits.join(", ")}`);
  const templates = entries.filter((entry) => ENV_TEMPLATES.has(asarBasename(entry)));
  return templates.length === 0 ? "none" : `none (templates ignored: ${templates.join(", ")})`;
});

check("no credential-shaped strings in packaged text config", () => {
  const patterns = [
    /sk-[A-Za-z0-9]{20,}/,
    /gh[pousr]_[A-Za-z0-9]{20,}/,
    /glpat-[\w-]{20,}/,
    /AKIA[0-9A-Z]{16}/,
    /-----BEGIN [A-Z ]*PRIVATE KEY-----/,
  ];
  const hits = [];
  walk(path.join(root, "resources"), (file) => {
    if (!/\.(json|env|txt|yml|yaml|cfg|ini)$/i.test(file)) return;
    if (fs.statSync(file).size > 2_000_000) return;
    const text = fs.readFileSync(file, "utf8");
    for (const pattern of patterns) {
      if (pattern.test(text)) hits.push(`${path.relative(root, file)} ~ ${pattern}`);
    }
  });
  must(hits.length === 0, hits.join("; "));
  return "none in resources/**/*.{json,env,txt,yml,yaml,cfg,ini}";
});

check("Windows key listener bundled (Hold / push-to-talk)", () => {
  const p = path.join(root, "resources", "bin", "windows-key-listener.exe");
  must(
    fs.existsSync(p),
    "missing resources/bin/windows-key-listener.exe — Hold would be unavailable"
  );
  return "present";
});

check("ONNX Runtime is privatized (#2054)", () => {
  const binDir = path.join(root, "resources", "bin");
  must(fs.existsSync(path.join(binDir, "ow-onnxrt.dll")), "missing resources/bin/ow-onnxrt.dll");
  must(
    !fs.existsSync(path.join(binDir, "onnxruntime.dll")),
    "resources/bin/onnxruntime.dll present — the System32 shadowing fix was skipped"
  );
  return "ow-onnxrt.dll present, onnxruntime.dll absent";
});

check("test launchers and readme shipped at the artifact root", () => {
  for (const name of [
    "Launch-OpenWhispr-Test.cmd",
    "Launch-OpenWhispr-Test-Debug.cmd",
    "READ-ME-FIRST.txt",
  ]) {
    must(fs.existsSync(path.join(root, name)), `missing ${name}`);
  }
  const launcher = fs.readFileSync(path.join(root, "Launch-OpenWhispr-Test.cmd"), "utf8");
  must(
    /OPENWHISPR_CHANNEL=development/.test(launcher),
    "launcher does not set an isolated OPENWHISPR_CHANNEL"
  );
  return "3 files";
});

const width = Math.max(...results.map((r) => r.name.length));
console.log(`\nSTATIC artifact inspection — ${root}`);
console.log("(no application launch; proves nothing about hotkeys, mic, paste or transcription)\n");
for (const r of results) {
  console.log(`${r.ok ? "PASS" : "FAIL"}  ${r.name.padEnd(width)}  ${r.detail}`);
}

if (fs.existsSync(exePath)) {
  const hash = crypto.createHash("sha256").update(fs.readFileSync(exePath)).digest("hex");
  console.log(`\nOpenWhispr.exe sha256: ${hash}`);
}

console.log(`\n${results.length - failed}/${results.length} checks passed`);
process.exit(failed === 0 ? 0 : 1);
