#!/usr/bin/env node
// TEST-ONLY — lives on the `validation/*` branch. See VALIDATION_BUILD.md.
//
//   node scripts/validation/compare-artifact-sources.js <unpacked-root> <git-ref>
//
// Proves the shipped artifact really carries the reviewed tree, file by file.
//
// This is NOT evidence/validation-9d4bd794/verify-artifact-matches-head.js,
// which is pinned to the superseded Raw/Cleaned design and is deliberately
// left unchanged, and it is NOT verify-revision-artifact.js, which asserts
// compiled markers, the bridge contract and the anti-markers. This one
// asserts BYTES: every source file the revision ships, every file the
// isolation patch touches, every locale, and the three standalone files
// beside the EXE.
//
// Why bytes and not markers: validation/PACKAGING_PATHS lets this branch
// differ from the feature SHA inside main.js and src/helpers/ipcHandlers.js,
// so path allowlisting ALONE would permit an arbitrary application change in
// those files. Comparing the artifact against the exact reviewed commit
// closes that: whatever was reviewed is what shipped. The companion gate,
// check-isolation-diff.js, pins what those app-file hunks may contain.
//
// Normalization: a difference is accepted ONLY when it is exclusively CRLF vs
// LF, and every such case is LABELLED as CRLF-ONLY with both raw hashes
// printed. Nothing else is normalized — no trimming, no whitespace folding,
// no JSON re-serialization — so any real byte change still fails.
//
// Source is included in that allowance on purpose. .gitattributes forces CRLF
// for validation/*.cmd and validation/*.txt and says nothing about source, so
// a Windows checkout can legitimately present a source file with CRLF, and a
// previous Windows artifact did. Rejecting that outright would fail a correct
// build; hiding it would lose the signal. Labelling it does neither.

const fs = require("fs");
const path = require("path");
const crypto = require("crypto");
const { execFileSync } = require("child_process");
const { toAsarPath } = require("./asarPaths");

// Shipped as SOURCE inside the asar. The renderer is bundled into src/dist and
// is covered by the compiled markers instead, so no component is listed here.
const FEATURE_SOURCES = [
  "main.js",
  "preload.js",
  "src/helpers/dictationHotkeyConfig.js",
  "src/helpers/environment.js",
  "src/helpers/gnomeGlobalShortcutsPortal.js",
  "src/helpers/gnomeShortcut.js",
  "src/helpers/hotkeyBindingId.js",
  "src/helpers/hotkeyCanonical.js",
  "src/helpers/hotkeyManager.js",
  "src/helpers/hyprlandShortcut.js",
  "src/helpers/ipcHandlers.js",
  "src/helpers/kdeShortcut.js",
  "src/helpers/windowManager.js",
  // electron-builder ships src/hooks/** and src/types/**, and the revision
  // changed all three of these; they are the renderer side of the mode
  // contract and must match too.
  "src/hooks/useAudioRecording.js",
  "src/hooks/useHotkeyModeInfo.ts",
  "src/types/electron.ts",
  // Unchanged by the revision, and listed for exactly that reason: these two
  // decide which route a recording takes and whether cleanup runs, so a
  // silent edit here would change behaviour without touching anything above.
  "src/helpers/audioManager.js",
  "src/helpers/dictationRouting.js",
];

// Every application file the isolation patch is allowed to touch.
const ISOLATION_SOURCES = [
  "main.js",
  "src/updater.js",
  "src/helpers/cliBridge.js",
  "src/helpers/cloudApiRequest.js",
  "src/helpers/ipcHandlers.js",
  "src/helpers/modelDirUtils.js",
  "src/helpers/qdrantManager.js",
  "src/helpers/secretCrypto.js",
  "src/helpers/validationBuildPolicy.js",
];

const LOCALES = ["ar", "de", "en", "es", "fr", "it", "ja", "pt", "ru", "zh-CN", "zh-TW"];
const LOCALE_SOURCES = LOCALES.map((l) => `src/locales/${l}/translation.json`);

// Beside the EXE, not in the asar. Authored CRLF.
const EXTRA_FILES = [
  ["Launch-OpenWhispr-Test.cmd", "validation/Launch-OpenWhispr-Test.cmd"],
  ["Launch-OpenWhispr-Test-Debug.cmd", "validation/Launch-OpenWhispr-Test-Debug.cmd"],
  ["READ-ME-FIRST.txt", "validation/READ-ME-FIRST.txt"],
];

const sha = (buf) => crypto.createHash("sha256").update(buf).digest("hex");
const crlfToLf = (buf) => Buffer.from(buf.toString("binary").replace(/\r\n/g, "\n"), "binary");

function compareArtifactSources({
  root,
  ref,
  gitDir = process.cwd(),
  featureSources = FEATURE_SOURCES,
  isolationSources = ISOLATION_SOURCES,
  localeSources = LOCALE_SOURCES,
  extraFiles = EXTRA_FILES,
  log = console.log,
} = {}) {
  const asarPath = path.join(root, "resources", "app.asar");
  const results = [];
  let failures = 0;

  const add = (ok, kind, name, detail) => {
    results.push({ ok, kind, name, detail });
    if (!ok) failures += 1;
  };

  const fromRef = (filePath) =>
    execFileSync("git", ["show", `${ref}:${filePath}`], { cwd: gitDir, maxBuffer: 1 << 28 });
  const fromAsar = (filePath) =>
    require("@electron/asar").extractFile(asarPath, toAsarPath(filePath));

  const compareSource = (kind, filePath) => {
    let shipped;
    let reviewed;
    try {
      shipped = fromAsar(filePath);
    } catch (err) {
      add(false, kind, filePath, `NOT IN THE ASAR: ${err.message}`);
      return;
    }
    try {
      reviewed = fromRef(filePath);
    } catch (err) {
      add(false, kind, filePath, `not at ${ref}: ${err.message}`);
      return;
    }
    const hashes = `shipped ${sha(shipped)} reviewed ${sha(reviewed)}`;
    if (shipped.equals(reviewed)) {
      add(true, kind, filePath, `EXACT ${shipped.length} B — ${hashes}`);
      return;
    }
    if (crlfToLf(shipped).equals(crlfToLf(reviewed))) {
      add(true, kind, filePath, `CRLF-ONLY (text identical) — ${hashes}`);
      return;
    }
    add(false, kind, filePath, `CONTENT DIFFERS — ${hashes}`);
  };

  if (!fs.existsSync(asarPath)) {
    add(false, "ASAR", "resources/app.asar", `missing at ${asarPath}`);
  } else {
    const seen = new Set();
    for (const [kind, list] of [
      ["FEATURE", featureSources],
      ["ISOLATION", isolationSources],
      ["LOCALE", localeSources],
    ]) {
      for (const filePath of list) {
        if (seen.has(filePath)) continue;
        seen.add(filePath);
        compareSource(kind, filePath);
      }
    }
  }

  for (const [shippedName, repoPath] of extraFiles) {
    const shippedPath = path.join(root, shippedName);
    if (!fs.existsSync(shippedPath)) {
      add(false, "EXTRA", shippedName, `missing beside the EXE at ${shippedPath}`);
      continue;
    }
    const shipped = fs.readFileSync(shippedPath);
    let reviewed;
    try {
      reviewed = fromRef(repoPath);
    } catch (err) {
      add(false, "EXTRA", shippedName, `not at ${ref}: ${err.message}`);
      continue;
    }
    const hashes = `shipped ${sha(shipped)} reviewed ${sha(reviewed)}`;
    if (shipped.equals(reviewed)) {
      add(true, "EXTRA", shippedName, `EXACT ${shipped.length} B — ${hashes}`);
    } else if (crlfToLf(shipped).equals(crlfToLf(reviewed))) {
      add(true, "EXTRA", shippedName, `CRLF-ONLY (text identical) — ${hashes}`);
    } else {
      add(false, "EXTRA", shippedName, `CONTENT DIFFERS — ${hashes}`);
    }
  }

  for (const { ok, kind, name, detail } of results) {
    log(`  ${ok ? "ok    " : "FAIL  "} ${kind.padEnd(9)} ${name} — ${detail}`);
  }
  const crlf = results.filter((r) => r.ok && r.detail.startsWith("CRLF-ONLY")).length;
  log(
    failures === 0
      ? `\nPASS: all ${results.length} shipped files match ${ref}` +
          (crlf ? ` (${crlf} by CRLF-only normalization, labelled above).` : " exactly.")
      : `\nFAIL: ${failures} of ${results.length} shipped files do not match ${ref}.`
  );
  return { failures, results };
}

module.exports = {
  compareArtifactSources,
  FEATURE_SOURCES,
  ISOLATION_SOURCES,
  LOCALE_SOURCES,
  EXTRA_FILES,
};

if (require.main === module) {
  const [, , rootArg, refArg] = process.argv;
  if (!rootArg || !refArg) {
    console.error("usage: compare-artifact-sources.js <unpacked-root> <git-ref>");
    process.exit(2);
  }
  const { failures } = compareArtifactSources({ root: path.resolve(rootArg), ref: refArg });
  process.exit(failures === 0 ? 0 : 1);
}
