// TEST-ONLY — lives on the `validation/*` branch. See VALIDATION_BUILD.md.
//
// Regression guard for a Windows-only bug the Linux fixture suite could not
// reproduce: the first real windows-latest run of the artifact verifier failed
// two checks because @electron/asar resolves lookups by splitting on
// path.sep, so "src/helpers/cliBridge.js" missed while "src/updater.js"
// passed, and listPackage() returned "\main.js" instead of "/main.js".
// These helpers are therefore tested against both separators explicitly.

const test = require("node:test");
const assert = require("node:assert/strict");
const path = require("node:path");

const { toAsarPath, fromAsarEntry, asarBasename } = require("../../scripts/validation/asarPaths");

const LOOKUPS = [
  "package.json",
  "main.js",
  "preload.js",
  "src/updater.js",
  "src/helpers/cliBridge.js",
  "src/helpers/qdrantManager.js",
  "src/helpers/secretCrypto.js",
  "src/helpers/ipcHandlers.js",
  "src/helpers/modelDirUtils.js",
  "src/locales/zh-CN/translation.json",
];

test("a repo path becomes a native asar lookup on Windows", () => {
  assert.equal(toAsarPath("main.js", path.win32.sep), "main.js");
  assert.equal(toAsarPath("src/updater.js", path.win32.sep), "src\\updater.js");
  assert.equal(
    toAsarPath("src/helpers/cliBridge.js", path.win32.sep),
    "src\\helpers\\cliBridge.js",
    "the two-segment path is what missed on the first real Windows run"
  );
});

test("a repo path is unchanged under POSIX", () => {
  for (const lookup of LOOKUPS) {
    assert.equal(toAsarPath(lookup, path.posix.sep), lookup);
  }
});

test("every lookup the verifier uses keeps all its segments", () => {
  for (const sep of [path.win32.sep, path.posix.sep]) {
    for (const lookup of LOOKUPS) {
      const converted = toAsarPath(lookup, sep);
      assert.equal(
        converted.split(sep).length,
        lookup.split("/").length,
        `${lookup} lost a segment under ${JSON.stringify(sep)}`
      );
      assert.doesNotMatch(
        converted.split(sep).slice(0, -1).join(""),
        /[/]/,
        `${lookup} left a forward slash inside a directory segment under ${JSON.stringify(sep)}`
      );
    }
  }
});

test("a Windows asar listing entry normalises to a leading-slash posix path", () => {
  assert.equal(fromAsarEntry("\\main.js", path.win32.sep), "/main.js");
  assert.equal(fromAsarEntry("\\src\\updater.js", path.win32.sep), "/src/updater.js");
  assert.equal(
    fromAsarEntry("\\src\\locales\\zh-CN\\translation.json", path.win32.sep),
    "/src/locales/zh-CN/translation.json"
  );
});

test("a POSIX asar listing entry is already normal", () => {
  assert.equal(fromAsarEntry("/main.js", path.posix.sep), "/main.js");
  assert.equal(
    fromAsarEntry("/src/locales/en/translation.json", path.posix.sep),
    "/src/locales/en/translation.json"
  );
});

test("a listing entry without a leading separator still gains one", () => {
  assert.equal(fromAsarEntry("main.js", path.win32.sep), "/main.js");
  assert.equal(fromAsarEntry("main.js", path.posix.sep), "/main.js");
});

test("the locale and entry-point patterns the verifier matches survive both separators", () => {
  const windowsListing = [
    "\\main.js",
    "\\preload.js",
    "\\package.json",
    "\\src\\updater.js",
    ...["ar", "de", "en", "es", "fr", "it", "ja", "pt", "ru", "zh-CN", "zh-TW"].map(
      (locale) => `\\src\\locales\\${locale}\\translation.json`
    ),
  ];
  const normalized = windowsListing.map((entry) => fromAsarEntry(entry, path.win32.sep));

  for (const expected of ["/main.js", "/preload.js", "/package.json", "/src/updater.js"]) {
    assert.ok(normalized.includes(expected), `missing ${expected}`);
  }
  const locales = normalized.filter((entry) =>
    /^\/src\/locales\/[^/]+\/translation\.json$/.test(entry)
  );
  assert.equal(locales.length, 11, "all 11 locales must match the verifier's pattern");
});

test("asarBasename reads the last segment of a normalised entry", () => {
  assert.equal(asarBasename("/src/helpers/cliBridge.js"), "cliBridge.js");
  assert.equal(asarBasename("/.env"), ".env");
  assert.equal(asarBasename("/.env.example"), ".env.example");
  assert.equal(asarBasename("main.js"), "main.js");
});
