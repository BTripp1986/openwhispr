// TEST-ONLY — lives on the `validation/*` branch. See VALIDATION_BUILD.md.
//
// Behavioural test of modelDirUtils.getCacheRoot(). The destructive path is
// migrateLegacyModelDirs(), which renameSync's the production install's model
// directories into a different cache root. It is reachable at startup under an
// inherited OPENWHISPR_CACHE_ROOT and under the automatic Windows non-ASCII
// fallback, so guarding the delete IPC routes does not close it.
//
// Runs against the real module with an in-memory fs; no real file is touched.

const test = require("node:test");
const assert = require("node:assert/strict");
const Module = require("node:module");
const path = require("node:path");

const modulePath = require.resolve("../../src/helpers/modelDirUtils.js");
const policyPath = require.resolve("../../src/helpers/validationBuildPolicy.js");
const originalLoad = Module._load;
const originalPlatform = process.platform;
const MANAGED_ENV = ["OPENWHISPR_CACHE_ROOT", "USERPROFILE", "ProgramData", "SystemDrive"];
const savedEnv = {};

const POSIX_HOME = "/home/tester";
// path.isAbsolute("C:\\...") is false under POSIX, so a win32 case has to run
// on path.win32 or getPreferredCacheRoot's USERPROFILE branch never fires and
// the non-ASCII fallback is never reached.
const WIN_HOME =
  "C:\\Users\\\u041f\u043e\u043b\u044c\u0437\u043e\u0432\u0430\u0442\u0435\u043b\u044c";
const RELOCATED = ["whisper-models", "parakeet-models", "diarization-models", "models"];

// Minimal fs stand-in: every production model directory exists, nothing else.
function makeFakeFs(pathImpl, home) {
  const calls = { renameSync: [], rmSync: [], mkdirSync: [] };
  const existing = new Set(
    RELOCATED.map((dir) => pathImpl.join(home, ".cache", "openwhispr", dir))
  );
  return {
    calls,
    existing,
    api: {
      existsSync: (p) => existing.has(p),
      mkdirSync: (p) => {
        calls.mkdirSync.push(p);
        existing.add(p);
        return p;
      },
      renameSync: (from, to) => {
        calls.renameSync.push([from, to]);
        existing.delete(from);
        existing.add(to);
      },
      rmSync: (p) => calls.rmSync.push(p),
      readdirSync: () => [],
      statSync: () => ({ isDirectory: () => true }),
    },
  };
}

function loadModelDirUtils({ isValidationBuild, platform, env }) {
  const win = platform === "win32";
  const pathImpl = win ? path.win32 : path.posix;
  const home = win ? WIN_HOME : POSIX_HOME;

  Object.defineProperty(process, "platform", { value: platform, configurable: true });
  for (const key of MANAGED_ENV) delete process.env[key];
  Object.assign(process.env, env);

  const fake = makeFakeFs(pathImpl, home);
  delete require.cache[modulePath];
  Module._load = function loadWithMocks(request, parent, isMain) {
    if (request === "electron") return { app: { getPath: () => home } };
    if (request === "fs") return fake.api;
    if (request === "path") return pathImpl;
    if (request === "./validationBuildPolicy") {
      const real = originalLoad.call(this, policyPath, parent, isMain);
      return { ...real, IS_VALIDATION_BUILD: isValidationBuild };
    }
    return originalLoad.call(this, request, parent, isMain);
  };
  const mod = require(modulePath);
  return { mod, fake, pathImpl, home };
}

test.beforeEach(() => {
  for (const key of MANAGED_ENV) savedEnv[key] = process.env[key];
});

test.afterEach(() => {
  Module._load = originalLoad;
  Object.defineProperty(process, "platform", { value: originalPlatform, configurable: true });
  for (const key of MANAGED_ENV) {
    if (savedEnv[key] === undefined) delete process.env[key];
    else process.env[key] = savedEnv[key];
  }
  delete require.cache[modulePath];
});

// --- condition 1: inherited OPENWHISPR_CACHE_ROOT ---------------------------

test("an ordinary build still honours OPENWHISPR_CACHE_ROOT and migrates", () => {
  const { mod, fake } = loadModelDirUtils({
    isValidationBuild: false,
    platform: "linux",
    env: { OPENWHISPR_CACHE_ROOT: "/elsewhere/cache" },
  });

  assert.equal(mod.getCacheRoot(), "/elsewhere/cache", "upstream behaviour preserved");
  assert.equal(
    fake.calls.renameSync.length,
    RELOCATED.length,
    "upstream migrates every relocated subdirectory"
  );
});

test("a validation build refuses OPENWHISPR_CACHE_ROOT and renames nothing", () => {
  const { mod, fake } = loadModelDirUtils({
    isValidationBuild: true,
    platform: "linux",
    env: { OPENWHISPR_CACHE_ROOT: "/elsewhere/cache" },
  });

  assert.equal(
    mod.getCacheRoot(),
    path.posix.join(POSIX_HOME, ".cache", "openwhispr"),
    "the override is ignored, so it resolves the shared home cache"
  );
  assert.deepEqual(fake.calls.renameSync, [], "no production model directory was renamed");
  for (const dir of RELOCATED) {
    assert.ok(
      fake.existing.has(path.posix.join(POSIX_HOME, ".cache", "openwhispr", dir)),
      `${dir} is still in the production cache`
    );
  }
});

// --- condition 2: automatic Windows non-ASCII fallback ----------------------

test("an ordinary build migrates through the Windows non-ASCII fallback", () => {
  const { mod, fake } = loadModelDirUtils({
    isValidationBuild: false,
    platform: "win32",
    env: { USERPROFILE: WIN_HOME, ProgramData: "C:\\ProgramData" },
  });

  const root = mod.getCacheRoot();
  assert.equal(root, "C:\\ProgramData\\OpenWhispr\\cache");
  assert.equal(
    fake.calls.renameSync.length,
    RELOCATED.length,
    "upstream behaviour preserved: the fallback migrates"
  );
});

test("a validation build takes the Windows fallback root without migrating", () => {
  const { mod, fake } = loadModelDirUtils({
    isValidationBuild: true,
    platform: "win32",
    env: { USERPROFILE: WIN_HOME, ProgramData: "C:\\ProgramData" },
  });

  const root = mod.getCacheRoot();
  assert.equal(
    root,
    "C:\\ProgramData\\OpenWhispr\\cache",
    "it still resolves the root production would, so it finds models production moved"
  );
  assert.deepEqual(fake.calls.renameSync, [], "no production model directory was renamed");
  assert.deepEqual(fake.calls.rmSync, [], "nothing was removed");
});

test("getModelsDirForService never migrates in a validation build", () => {
  const { mod, fake } = loadModelDirUtils({
    isValidationBuild: true,
    platform: "win32",
    env: { USERPROFILE: WIN_HOME, ProgramData: "C:\\ProgramData" },
  });

  for (const service of ["whisper", "parakeet", "diarization"]) {
    assert.match(mod.getModelsDirForService(service), new RegExp(`${service}-models$`));
  }
  assert.deepEqual(fake.calls.renameSync, []);
});

// --- the delete routes the migration guard does not cover -------------------

test("a validation build refuses every shared-download delete route", () => {
  const {
    refuseSharedDownloadDelete,
    SHARED_DOWNLOAD_DELETE_REFUSAL,
  } = require("../../src/helpers/validationBuildPolicy");

  assert.equal(refuseSharedDownloadDelete({ isValidationBuild: false }), null);
  assert.equal(refuseSharedDownloadDelete(), null, "no arguments");

  const refusal = refuseSharedDownloadDelete({ isValidationBuild: true });
  assert.equal(refusal, SHARED_DOWNLOAD_DELETE_REFUSAL);
  assert.equal(refusal.success, false);
  assert.equal(refusal.code, "VALIDATION_BUILD_SHARED_DOWNLOADS");
  assert.match(refusal.error, /will not delete them/);
  assert.ok(Object.isFrozen(refusal), "the refusal must not be mutable by a caller");
});

test("every shared-download delete route in ipcHandlers hands back the refusal", () => {
  const fs = require("node:fs");
  const source = fs.readFileSync(
    path.resolve(__dirname, "..", "..", "src", "helpers", "ipcHandlers.js"),
    "utf8"
  );

  assert.match(source, /const sharedDownloadDeleteRefusal = refuseSharedDownloadDelete\(/);

  const routes = [
    "delete-whisper-model",
    "delete-all-whisper-models",
    "delete-parakeet-model",
    "delete-all-parakeet-models",
    "delete-diarization-models",
    "model-delete",
    "model-delete-all",
  ];
  for (const route of routes) {
    // The guard must be the first statement of the handler, before any await.
    const handler = source.match(
      new RegExp(`ipcMain\\.handle\\("${route}",[^\\n]*\\n\\s*([^\\n]*)`)
    );
    assert.ok(handler, `route ${route} is gone`);
    assert.match(
      handler[1],
      /if \(sharedDownloadDeleteRefusal\) return sharedDownloadDeleteRefusal;/,
      `route ${route} does not refuse first: got ${JSON.stringify(handler[1])}`
    );
  }

  // The GPU binary packs live in userData/bin, which the channel pin already
  // isolates, so they are deliberately NOT guarded.
  for (const route of [
    "delete-cuda-whisper-binary",
    "delete-vulkan-whisper-binary",
    "delete-llama-vulkan-binary",
  ]) {
    assert.match(source, new RegExp(`ipcMain\\.handle\\("${route}"`), `route ${route} is gone`);
  }
});

test("modelDirUtils routes both cache decisions through the policy", () => {
  const fs = require("node:fs");
  const source = fs.readFileSync(
    path.resolve(__dirname, "..", "..", "src", "helpers", "modelDirUtils.js"),
    "utf8"
  );
  assert.match(source, /shouldIgnoreCacheRootOverride\(/);
  assert.match(source, /shouldSkipLegacyCacheMigration\(/);
  assert.doesNotMatch(
    source,
    /^\s*if \(process\.env\.OPENWHISPR_CACHE_ROOT\) \{$/m,
    "the unguarded OPENWHISPR_CACHE_ROOT branch is back"
  );
});
