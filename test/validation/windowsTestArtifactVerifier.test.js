// TEST-ONLY — lives on the `validation/*` branch. See VALIDATION_BUILD.md.
//
// Exercises scripts/validation/verify-windows-test-artifact.js against a
// synthetic win-unpacked tree, so the artifact gate is known to fail closed
// before it is pointed at a real Windows build. This is a test of the checker,
// not of any real artifact, and like the checker it launches nothing.

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { execFileSync } = require("node:child_process");

const REPO_ROOT = path.resolve(__dirname, "..", "..");
const LOCALES = ["ar", "de", "en", "es", "fr", "it", "ja", "pt", "ru", "zh-CN", "zh-TW"];
const SIDECARS = [
  "windows-key-listener.exe",
  "windows-fast-paste.exe",
  "windows-mic-listener.exe",
  "nircmd.exe",
];
const UNPACKED_NATIVE = [
  "better-sqlite3/build/Release/better_sqlite3.node",
  "ffmpeg-static/ffmpeg.exe",
  "onnxruntime-node/bin/napi-v6/win32/x64/onnxruntime_binding.node",
];
const VERIFIER = path.join(REPO_ROOT, "scripts", "validation", "verify-windows-test-artifact.js");

// Smallest PE64 image the verifier's certificate-table read accepts, with the
// Certificate Table data directory left zeroed (i.e. unsigned).
function makeUnsignedPe({ certTableSize = 0 } = {}) {
  const buf = Buffer.alloc(0x400);
  buf.write("MZ", 0, "ascii");
  const peOffset = 0x100;
  buf.writeUInt32LE(peOffset, 0x3c);
  buf.write("PE\0\0", peOffset, "ascii");
  const optionalHeaderOffset = peOffset + 24;
  buf.writeUInt16LE(0x20b, optionalHeaderOffset); // PE32+
  const dataDirOffset = optionalHeaderOffset + 112;
  const certTableOffset = dataDirOffset + 4 * 8;
  buf.writeUInt32LE(certTableSize === 0 ? 0 : 0x5000, certTableOffset); // RVA
  buf.writeUInt32LE(certTableSize, certTableOffset + 4);
  return buf;
}

function buildFixture(mutate = () => {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "ow-validation-fixture-"));
  const unpacked = path.join(root, "win-unpacked");
  const resources = path.join(unpacked, "resources");
  const bin = path.join(resources, "bin");
  fs.mkdirSync(bin, { recursive: true });

  const appSrc = path.join(root, "app");
  fs.mkdirSync(path.join(appSrc, "src"), { recursive: true });
  const app = {
    "package.json": JSON.stringify(
      {
        name: "open-whispr",
        version: "1.10.3",
        windowsTrayIdentity: false,
        openwhisprValidationBuild: true,
      },
      null,
      2
    ),
    "main.js":
      "const { resolveValidationChannel, shouldIgnoreProtocolOverride } = require('./src/helpers/validationBuildPolicy');\n" +
      'const DEFAULT_OAUTH_PROTOCOL_BY_CHANNEL = { development: "openwhispr-dev" };\n' +
      "resolveValidationChannel({});\nshouldIgnoreProtocolOverride({});\n",
    "preload.js": "// stub\n",
    "src/updater.js": "const updatesDisabled = () => true;\nif (updatesDisabled()) {}\n",
    "src/helpers/cliBridge.js":
      "const { resolveCliBridgeFileName } = require('./validationBuildPolicy');\n" +
      "const name = resolveCliBridgeFileName({});\n",
  };
  for (const locale of LOCALES) {
    app[`src/locales/${locale}/translation.json`] = "{}\n";
  }

  fs.writeFileSync(path.join(unpacked, "OpenWhispr.exe"), makeUnsignedPe());
  fs.writeFileSync(path.join(bin, "ow-onnxrt.dll"), "stub");
  for (const name of SIDECARS) fs.writeFileSync(path.join(bin, name), "stub");

  const unpackedModules = path.join(resources, "app.asar.unpacked", "node_modules");
  for (const rel of UNPACKED_NATIVE) {
    const dest = path.join(unpackedModules, rel);
    fs.mkdirSync(path.dirname(dest), { recursive: true });
    fs.writeFileSync(dest, "stub");
  }
  const workerPath = path.join(resources, "app.asar.unpacked", "src", "workers", "onnxWorker.js");
  fs.mkdirSync(path.dirname(workerPath), { recursive: true });
  fs.writeFileSync(workerPath, "// stub\n");
  for (const name of [
    "Launch-OpenWhispr-Test.cmd",
    "Launch-OpenWhispr-Test-Debug.cmd",
    "READ-ME-FIRST.txt",
  ]) {
    fs.copyFileSync(path.join(REPO_ROOT, "validation", name), path.join(unpacked, name));
  }

  mutate({ root, unpacked, resources, bin, app, appSrc });

  for (const [rel, body] of Object.entries(app)) {
    const dest = path.join(appSrc, rel);
    fs.mkdirSync(path.dirname(dest), { recursive: true });
    fs.writeFileSync(dest, body);
  }
  // createPackage is async; the sync API is createPackageWithOptions' callback
  // form, so drive it through the module's promise and await at the call site.
  return { root, unpacked, appSrc, resources, bin };
}

async function packAsar(appSrc, resources) {
  const { createPackage } = require("@electron/asar");
  await createPackage(appSrc, path.join(resources, "app.asar"));
}

function run(unpacked) {
  try {
    const stdout = execFileSync(process.execPath, [VERIFIER, unpacked], { encoding: "utf8" });
    return { code: 0, stdout };
  } catch (error) {
    return { code: error.status ?? 1, stdout: `${error.stdout || ""}${error.stderr || ""}` };
  }
}

async function verify(mutate) {
  const fixture = buildFixture(mutate);
  await packAsar(fixture.appSrc, fixture.resources);
  const result = run(fixture.unpacked);
  fs.rmSync(fixture.root, { recursive: true, force: true });
  return result;
}

test("a well-formed validation artifact passes every static check", async () => {
  const { code, stdout } = await verify();
  assert.equal(code, 0, stdout);
  assert.match(stdout, /18\/18 checks passed/);
  assert.match(stdout, /OpenWhispr\.exe sha256: [0-9a-f]{64}/);
  assert.doesNotMatch(stdout, /^FAIL/m);
});

test("a missing validation marker fails the gate", async () => {
  const { code, stdout } = await verify(({ app }) => {
    app["package.json"] = JSON.stringify({
      name: "open-whispr",
      version: "1.10.3",
      windowsTrayIdentity: false,
    });
  });
  assert.equal(code, 1);
  assert.match(stdout, /FAIL {2}packaged package\.json carries the validation marker/);
  assert.match(stdout, /would resolve to the production channel/);
});

test("a production tray identity fails the gate", async () => {
  const { code, stdout } = await verify(({ app }) => {
    app["package.json"] = JSON.stringify({
      name: "open-whispr",
      version: "1.10.3",
      windowsTrayIdentity: true,
      openwhisprValidationBuild: true,
    });
  });
  assert.equal(code, 1);
  assert.match(stdout, /must not claim the production tray GUID/);
});

test("an updater left on the NODE_ENV-only gate fails", async () => {
  const { code, stdout } = await verify(({ app }) => {
    app["src/updater.js"] = 'if (process.env.NODE_ENV === "development") {}\n';
  });
  assert.equal(code, 1);
  assert.match(stdout, /FAIL {2}packaged updater\.js gates on the validation marker/);
});

test("a packaged .env fails the gate", async () => {
  const { code, stdout } = await verify(({ resources }) => {
    fs.writeFileSync(path.join(resources, ".env"), "GOOGLE_CALENDAR_CLIENT_ID=x\n");
  });
  assert.equal(code, 1);
  assert.match(stdout, /FAIL {2}no real \.env packaged anywhere in the artifact/);
});

test("a credential-shaped string in packaged config fails the gate", async () => {
  const { code, stdout } = await verify(({ resources }) => {
    fs.writeFileSync(
      path.join(resources, "leaked.json"),
      JSON.stringify({ key: `sk-${"a".repeat(40)}` })
    );
  });
  assert.equal(code, 1);
  assert.match(stdout, /FAIL {2}no credential-shaped strings/);
});

test("a shadowing onnxruntime.dll fails the gate", async () => {
  const { code, stdout } = await verify(({ bin }) => {
    fs.writeFileSync(path.join(bin, "onnxruntime.dll"), "stub");
  });
  assert.equal(code, 1);
  assert.match(stdout, /System32 shadowing fix was skipped/);
});

test("a missing Windows key listener fails the gate", async () => {
  const { code, stdout } = await verify(({ bin }) => {
    fs.rmSync(path.join(bin, "windows-key-listener.exe"));
  });
  assert.equal(code, 1);
  assert.match(stdout, /Hold would be unavailable/);
});

test("a signed executable fails the gate", async () => {
  const { code, stdout } = await verify(({ unpacked }) => {
    fs.writeFileSync(
      path.join(unpacked, "OpenWhispr.exe"),
      makeUnsignedPe({ certTableSize: 0x1000 })
    );
  });
  assert.equal(code, 1);
  assert.match(stdout, /carries an Authenticode signature/);
});

test("a missing test launcher fails the gate", async () => {
  const { code, stdout } = await verify(({ unpacked }) => {
    fs.rmSync(path.join(unpacked, "Launch-OpenWhispr-Test.cmd"));
  });
  assert.equal(code, 1);
  assert.match(stdout, /missing Launch-OpenWhispr-Test\.cmd/);
});

test("an unguarded protocol override in the packaged main.js fails the gate", async () => {
  const { code, stdout } = await verify(({ app }) => {
    app["main.js"] =
      "const { resolveValidationChannel } = require('./src/helpers/validationBuildPolicy');\n" +
      'const DEFAULT_OAUTH_PROTOCOL_BY_CHANNEL = { development: "openwhispr-dev" };\n' +
      "resolveValidationChannel({});\n";
  });
  assert.equal(code, 1);
  assert.match(stdout, /could claim the production openwhispr:\/\/ handler/);
});

test("a hardcoded CLI bridge path in the packaged asar fails the gate", async () => {
  const { code, stdout } = await verify(({ app }) => {
    app["src/helpers/cliBridge.js"] =
      'const p = path.join(os.homedir(), ".openwhispr", "cli-bridge.json");\n';
  });
  assert.equal(code, 1);
  assert.match(stdout, /rewrites on launch and deletes on quit/);
});

test("a missing better-sqlite3 binding fails the gate", async () => {
  const { code, stdout } = await verify(({ resources }) => {
    fs.rmSync(path.join(resources, "app.asar.unpacked", "node_modules", "better-sqlite3"), {
      recursive: true,
      force: true,
    });
  });
  assert.equal(code, 1);
  assert.match(stdout, /missing unpacked native modules: better-sqlite3/);
  assert.match(stdout, /history, notes and settings database/);
});

test("a dropped locale fails the gate", async () => {
  const { code, stdout } = await verify(({ app }) => {
    delete app["src/locales/ja/translation.json"];
  });
  assert.equal(code, 1);
  assert.match(stdout, /only 10 locale files in the asar, expected 11/);
});

test("an absent non-blocking sidecar is reported but still passes", async () => {
  const { code, stdout } = await verify(({ bin }) => {
    fs.rmSync(path.join(bin, "nircmd.exe"));
  });
  assert.equal(code, 0, stdout);
  assert.match(stdout, /ABSENT \(non-blocking\): nircmd\.exe/);
});

test("a tracked .env template is ignored, a real .env beside it is not", async () => {
  const passing = await verify(({ resources }) => {
    fs.writeFileSync(path.join(resources, ".env.example"), "OPENAI_API_KEY=\n");
  });
  assert.equal(passing.code, 0, passing.stdout);
  assert.match(passing.stdout, /templates ignored: .*\.env\.example/);

  const failing = await verify(({ resources }) => {
    fs.writeFileSync(path.join(resources, ".env.example"), "OPENAI_API_KEY=\n");
    fs.writeFileSync(path.join(resources, ".env.local"), "OPENAI_API_KEY=real\n");
  });
  assert.equal(failing.code, 1);
  assert.match(failing.stdout, /packaged env files: .*\.env\.local/);
});
