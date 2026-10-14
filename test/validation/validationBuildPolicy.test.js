// TEST-ONLY — lives on the `validation/*` branch. See VALIDATION_BUILD.md.
//
// Pins the two invariants the handed-out Windows test artifact depends on:
// it never resolves to the production channel, and the auto-updater is off.
// The marker-off cases are the regression guard: with no extraMetadata marker
// every decision must be byte-identical to upstream main.

const test = require("node:test");
const assert = require("node:assert/strict");
const Module = require("node:module");

const {
  IS_VALIDATION_BUILD,
  resolveValidationChannel,
  areUpdatesDisabled,
} = require("../../src/helpers/validationBuildPolicy");

test("an ordinary checkout is not a validation build", () => {
  assert.equal(
    IS_VALIDATION_BUILD,
    false,
    "the marker is injected by electron-builder.validation-win.json at package time only; a true value here means it leaked into package.json"
  );
});

test("an ordinary build keeps its own channel resolution", () => {
  for (const requestedChannel of ["", "production", "development", "staging", "nonsense"]) {
    assert.equal(
      resolveValidationChannel({ isValidationBuild: false, requestedChannel }),
      null,
      `channel ${JSON.stringify(requestedChannel)}`
    );
  }
  assert.equal(resolveValidationChannel(), null, "no arguments");
});

test("a validation build never resolves to the production channel", () => {
  for (const requestedChannel of [
    undefined,
    "",
    "   ",
    "production",
    "PRODUCTION",
    " Production ",
    "development",
    "nonsense",
    null,
    42,
  ]) {
    const channel = resolveValidationChannel({ isValidationBuild: true, requestedChannel });
    assert.notEqual(channel, "production", `requested ${JSON.stringify(requestedChannel)}`);
    assert.equal(channel, "development", `requested ${JSON.stringify(requestedChannel)}`);
  }
});

test("a validation build honours an explicit staging request", () => {
  assert.equal(
    resolveValidationChannel({ isValidationBuild: true, requestedChannel: "staging" }),
    "staging"
  );
  assert.equal(
    resolveValidationChannel({ isValidationBuild: true, requestedChannel: " STAGING " }),
    "staging"
  );
});

test("updates stay disabled for a validation build regardless of NODE_ENV", () => {
  for (const nodeEnv of [undefined, "", "production", "test", "development"]) {
    assert.equal(
      areUpdatesDisabled({ nodeEnv, isValidationBuild: true }),
      true,
      `NODE_ENV=${JSON.stringify(nodeEnv)}`
    );
  }
});

test("an ordinary build keeps the existing NODE_ENV-only update gate", () => {
  assert.equal(areUpdatesDisabled({ nodeEnv: "development", isValidationBuild: false }), true);
  for (const nodeEnv of [undefined, "", "production", "test", "staging"]) {
    assert.equal(
      areUpdatesDisabled({ nodeEnv, isValidationBuild: false }),
      false,
      `NODE_ENV=${JSON.stringify(nodeEnv)}`
    );
  }
  assert.equal(areUpdatesDisabled(), false, "no arguments");
});

// --- integration: does src/updater.js actually consult the policy? ----------

const updaterModulePath = require.resolve("../../src/updater.js");
const policyModulePath = require.resolve("../../src/helpers/validationBuildPolicy.js");
const originalLoad = Module._load;
const originalPlatform = process.platform;

function makeAutoUpdater() {
  const autoUpdater = {
    calls: 0,
    feedUrls: 0,
    listeners: {},
    setFeedURL() {
      autoUpdater.feedUrls += 1;
    },
    on(event, handler) {
      autoUpdater.listeners[event] = handler;
    },
    removeListener() {},
    checkForUpdates() {
      autoUpdater.calls += 1;
      return Promise.resolve({ isUpdateAvailable: false });
    },
    downloadUpdate() {
      return Promise.resolve();
    },
  };
  return autoUpdater;
}

function createUpdateManager(autoUpdater, { isValidationBuild }) {
  delete require.cache[updaterModulePath];
  Module._load = function loadWithMocks(request, parent, isMain) {
    if (request === "electron-updater") return { autoUpdater };
    if (request === "electron") return { autoUpdater: { on() {}, removeListener() {} } };
    if (request === "child_process") return { execSync: () => "0" };
    if (request === "./helpers/validationBuildPolicy") {
      const real = originalLoad.call(this, policyModulePath, parent, isMain);
      return { ...real, IS_VALIDATION_BUILD: isValidationBuild };
    }
    return originalLoad.call(this, request, parent, isMain);
  };
  const UpdateManager = require(updaterModulePath);
  return new UpdateManager();
}

test.afterEach(() => {
  Module._load = originalLoad;
  Object.defineProperty(process, "platform", { value: originalPlatform, configurable: true });
  delete require.cache[updaterModulePath];
});

test("a validation build never wires or runs an update check", (t) => {
  // darwin: the updater is unsupported on a non-AppImage Linux runner, so the
  // platform has to be one where it would otherwise run.
  Object.defineProperty(process, "platform", { value: "darwin", configurable: true });
  t.mock.method(console, "log", () => {});
  t.mock.timers.enable({ apis: ["setTimeout", "setInterval"] });

  const autoUpdater = makeAutoUpdater();
  const manager = createUpdateManager(autoUpdater, { isValidationBuild: true });

  assert.equal(autoUpdater.feedUrls, 0, "setupAutoUpdater must not reach setFeedURL");

  manager.checkForUpdatesOnStartup();
  t.mock.timers.tick(3000);
  t.mock.timers.tick(4 * 60 * 60 * 1000);
  assert.equal(autoUpdater.calls, 0, "no startup or periodic check");

  // Even a renderer that syncs automatic updates on cannot start a download:
  // the event handlers were never registered.
  manager.setAutoUpdatesEnabled(true);
  assert.deepEqual(Object.keys(autoUpdater.listeners), [], "no event handlers registered");

  manager.cleanup();
  t.mock.timers.reset();
});

test("an ordinary build still wires and runs update checks", (t) => {
  Object.defineProperty(process, "platform", { value: "darwin", configurable: true });
  t.mock.method(console, "log", () => {});
  t.mock.timers.enable({ apis: ["setTimeout", "setInterval"] });

  const autoUpdater = makeAutoUpdater();
  const manager = createUpdateManager(autoUpdater, { isValidationBuild: false });

  assert.equal(autoUpdater.feedUrls, 1, "setFeedURL still called");
  manager.checkForUpdatesOnStartup();
  t.mock.timers.tick(3000);
  assert.equal(autoUpdater.calls, 1, "startup check still runs");

  manager.cleanup();
  t.mock.timers.reset();
});

// --- protocol isolation -----------------------------------------------------

const {
  shouldIgnoreProtocolOverride,
  resolveCliBridgeFileName,
} = require("../../src/helpers/validationBuildPolicy");

test("an ordinary build keeps honouring an explicit protocol override", () => {
  assert.equal(shouldIgnoreProtocolOverride({ isValidationBuild: false }), false);
  assert.equal(shouldIgnoreProtocolOverride({}), false);
  assert.equal(shouldIgnoreProtocolOverride(), false);
});

test("a validation build refuses every inherited protocol override", () => {
  assert.equal(shouldIgnoreProtocolOverride({ isValidationBuild: true }), true);
});

// main.js calls Electron's app APIs at import time (app.setPath, dotenv on
// userData, requestSingleInstanceLock), so its getOAuthProtocol cannot be
// loaded in-process. This pins the shape of the one branch the pure predicate
// has to guard; the same assertion runs against the PACKAGED main.js in
// scripts/validation/verify-windows-test-artifact.js.
test("main.js guards its protocol env override with the validation predicate", () => {
  const fs = require("node:fs");
  const path = require("node:path");
  const source = fs.readFileSync(path.resolve(__dirname, "..", "..", "main.js"), "utf8");

  // Formatting-insensitive: pull getOAuthProtocol's first `if (...)` condition
  // and require both halves of the guard inside it, so a prettier reflow of the
  // condition cannot break this check while a removed guard still does.
  const fn = source.match(/function getOAuthProtocol\(\)[\s\S]*?\n\}/);
  assert.ok(fn, "getOAuthProtocol() is gone from main.js");
  const condition = fn[0].match(/if \(([\s\S]*?)\)\s*\{/);
  assert.ok(condition, "getOAuthProtocol() no longer branches on the env override");
  assert.match(
    condition[1],
    /test\(fromEnv\)/,
    "the guarded branch is not the env-override branch"
  );
  assert.match(
    condition[1],
    /!\s*shouldIgnoreProtocolOverride\(/,
    "the VITE_OPENWHISPR_PROTOCOL / OPENWHISPR_PROTOCOL branch in getOAuthProtocol() is no longer guarded by shouldIgnoreProtocolOverride — a marked test artifact could claim the production openwhispr:// handler"
  );

  // The channel default must stay the fallback, so a refused override lands on
  // openwhispr-dev:// rather than on the production scheme.
  assert.match(source, /DEFAULT_OAUTH_PROTOCOL_BY_CHANNEL\[APP_CHANNEL\]/);
  assert.match(source, /development: "openwhispr-dev"/);
});

// --- CLI bridge token file --------------------------------------------------

test("an ordinary build keeps the shared CLI bridge file name", () => {
  for (const channel of [undefined, "", "production", "development", "staging"]) {
    assert.equal(
      resolveCliBridgeFileName({ isValidationBuild: false, channel }),
      "cli-bridge.json",
      `channel ${JSON.stringify(channel)}`
    );
  }
  assert.equal(resolveCliBridgeFileName(), "cli-bridge.json");
});

test("a validation build never writes the production CLI bridge file", () => {
  for (const channel of [undefined, "", "production", "development", "staging", "we;rd/../x"]) {
    const name = resolveCliBridgeFileName({ isValidationBuild: true, channel });
    assert.notEqual(name, "cli-bridge.json", `channel ${JSON.stringify(channel)}`);
    assert.match(name, /^cli-bridge-[a-z0-9-]+\.json$/, `channel ${JSON.stringify(channel)}`);
    assert.doesNotMatch(name, /[\\/]|\.\./, "must stay a bare file name");
  }
  assert.equal(
    resolveCliBridgeFileName({ isValidationBuild: true, channel: "development" }),
    "cli-bridge-development.json"
  );
});

test("cliBridge.js resolves its file name through the validation policy", () => {
  const fs = require("node:fs");
  const path = require("node:path");
  const source = fs.readFileSync(
    path.resolve(__dirname, "..", "..", "src", "helpers", "cliBridge.js"),
    "utf8"
  );
  assert.match(source, /resolveCliBridgeFileName\(/);
  assert.doesNotMatch(
    source,
    /path\.join\(os\.homedir\(\), "\.openwhispr", "cli-bridge\.json"\)/,
    "the hardcoded production bridge path is back"
  );
});

// --- shared cache and credential-vault isolation ----------------------------

const {
  resolveQdrantDataDirName,
  resolveKeyringService,
  shouldSkipSharedDeviceCaches,
} = require("../../src/helpers/validationBuildPolicy");

test("an ordinary build keeps the NODE_ENV-keyed Qdrant directory", () => {
  assert.equal(
    resolveQdrantDataDirName({ isValidationBuild: false, nodeEnv: "development" }),
    "qdrant-data-dev"
  );
  for (const nodeEnv of [undefined, "", "production", "test", "staging"]) {
    assert.equal(
      resolveQdrantDataDirName({ isValidationBuild: false, nodeEnv }),
      "qdrant-data",
      `NODE_ENV=${JSON.stringify(nodeEnv)}`
    );
  }
  assert.equal(resolveQdrantDataDirName(), "qdrant-data", "no arguments");
});

test("a validation build never opens the production Qdrant directory", () => {
  for (const nodeEnv of [undefined, "", "production", "test", "development"]) {
    const dir = resolveQdrantDataDirName({ isValidationBuild: true, nodeEnv });
    assert.equal(dir, "qdrant-data-validation", `NODE_ENV=${JSON.stringify(nodeEnv)}`);
    assert.notEqual(dir, "qdrant-data");
    assert.notEqual(dir, "qdrant-data-dev");
  }
});

test("qdrantManager resolves its storage directory through the policy", () => {
  const fs = require("node:fs");
  const path = require("node:path");
  const source = fs.readFileSync(
    path.resolve(__dirname, "..", "..", "src", "helpers", "qdrantManager.js"),
    "utf8"
  );
  assert.match(source, /resolveQdrantDataDirName\(/);
  assert.doesNotMatch(
    source,
    /process\.env\.NODE_ENV === "development" \? "qdrant-data-dev" : "qdrant-data"/,
    "the NODE_ENV-keyed storage directory is back"
  );
});

test("an ordinary build keeps the production keyring service", () => {
  assert.equal(
    resolveKeyringService({ isValidationBuild: false, baseService: "OpenWhispr" }),
    "OpenWhispr"
  );
  assert.equal(resolveKeyringService(), "OpenWhispr", "defaults to the production service");
});

test("a validation build uses its own credential-vault service", () => {
  const service = resolveKeyringService({ isValidationBuild: true, baseService: "OpenWhispr" });
  assert.equal(service, "OpenWhispr-validation");
  assert.notEqual(service, "OpenWhispr");
});

test("secretCrypto derives its keyring service through the policy", () => {
  const fs = require("node:fs");
  const path = require("node:path");
  const source = fs.readFileSync(
    path.resolve(__dirname, "..", "..", "src", "helpers", "secretCrypto.js"),
    "utf8"
  );
  assert.match(source, /resolveKeyringService\(/);
  assert.doesNotMatch(
    source,
    /^const SERVICE = "OpenWhispr";$/m,
    "the hardcoded cross-channel keyring service is back"
  );
});

test("an ordinary build still erases the shared device caches", () => {
  assert.equal(shouldSkipSharedDeviceCaches({ isValidationBuild: false }), false);
  assert.equal(shouldSkipSharedDeviceCaches(), false);
});

test("a validation build keeps the shared device caches", () => {
  assert.equal(shouldSkipSharedDeviceCaches({ isValidationBuild: true }), true);
});

test("the device-erasure path guards every shared cache deletion", () => {
  const fs = require("node:fs");
  const path = require("node:path");
  const source = fs.readFileSync(
    path.resolve(__dirname, "..", "..", "src", "helpers", "ipcHandlers.js"),
    "utf8"
  );

  // The guard is declared once, from the policy, and the user is told the
  // caches were kept rather than it happening silently.
  assert.match(source, /const eraseSharedCaches = !shouldSkipSharedDeviceCaches\(/);
  assert.match(source, /Shared model caches under ~\/\.cache\/openwhispr were kept/);

  // Every shared deletion in that handler sits behind the guard.
  for (const guarded of [
    /if \(eraseSharedCaches && fs\.existsSync\(whisperDir\)\)/,
    /if \(eraseSharedCaches\) await this\.parakeetManager\?\.deleteAllParakeetModels\(\)/,
    /if \(eraseSharedCaches\) await this\.diarizationManager\?\.deleteModels\(\)/,
    /if \(eraseSharedCaches\) await modelManager\.deleteAllModels\(\)/,
  ]) {
    assert.match(source, guarded, `unguarded shared-cache deletion: ${guarded}`);
  }

  // The home-cache loop erases the production names only when allowed, and
  // otherwise still removes the validation build's own Qdrant directory.
  assert.match(
    source,
    /for \(const cacheName of eraseSharedCaches\s*\n?\s*\? \["embedding-models", "qdrant-data", "qdrant-data-dev", "yt-dlp"\]\s*\n?\s*: \[resolveQdrantDataDirName\(/,
    "the ~/.cache/openwhispr deletion loop is no longer guarded"
  );
});
