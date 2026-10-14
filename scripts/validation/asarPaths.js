// TEST-ONLY — lives on the `validation/*` branch. See VALIDATION_BUILD.md.
//
// @electron/asar is not separator-agnostic, in both directions:
//
//   * a lookup resolves through `searchNodeFromDirectory(path.dirname(p))`,
//     which splits on `path.sep`. On Windows a forward-slash path with more
//     than one directory segment ("src/helpers/cliBridge.js") therefore splits
//     into a single bogus key and misses, while one segment
//     ("src/updater.js") happens to work — so a check can pass and its
//     neighbour fail for no visible reason.
//   * `listFiles()` builds entries with `path.join("/", ...)`, so on Windows
//     they come back as "\main.js" rather than "/main.js".
//
// Both directions are normalised here and unit-tested against path.win32 and
// path.posix, because a Linux-only fixture cannot reproduce either.

const path = require("path");

// Repo-style forward-slash path -> the separator this platform's asar expects.
function toAsarPath(filePath, sep = path.sep) {
  return filePath.split("/").join(sep);
}

// An asar listing entry -> a leading-slash, forward-slash path.
function fromAsarEntry(entry, sep = path.sep) {
  const normalized = entry.split(sep).join("/");
  return normalized.startsWith("/") ? normalized : `/${normalized}`;
}

function asarBasename(entry) {
  return entry.slice(entry.lastIndexOf("/") + 1);
}

module.exports = { toAsarPath, fromAsarEntry, asarBasename };
