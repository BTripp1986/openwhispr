// TEST-ONLY — lives on the `validation/*` branch and must never reach the
// upstream feature PR. See VALIDATION_BUILD.md.
//
// A validation build is an unsigned, unpacked Windows artifact handed to a
// tester. It carries the `openwhisprValidationBuild` marker that
// electron-builder.validation-win.json injects through `extraMetadata`, the
// same mechanism `windowsTrayIdentity` already uses (src/helpers/tray.js).
//
// The marker, not an environment variable, is what makes the artifact safe:
// a launcher's `set OPENWHISPR_CHANNEL=...` is lost the moment someone
// double-clicks the executable instead, and a packaged build that resolves to
// the production channel would share the production profile, the production
// `openwhispr://` handler, the production AppUserModelId and its
// launch-at-login registry value name.
//
// Pure module so both decisions are unit-testable without Electron
// (test/validation/validationBuildPolicy.test.js).

const { openwhisprValidationBuild } = require("../../package.json");

const IS_VALIDATION_BUILD = openwhisprValidationBuild === true;

// Returns the channel a validation build must run on, or null when this is an
// ordinary build and the caller should keep its existing resolution.
//
// `production` is refused rather than honoured: the marker is only ever set on
// a throwaway test artifact, so an explicit production request can only be a
// mistake, and honouring it would put the test build on the tester's real
// profile. `staging` is allowed through because it is already an isolated
// channel in main.js.
function resolveValidationChannel({ isValidationBuild, requestedChannel } = {}) {
  if (!isValidationBuild) return null;
  const requested =
    typeof requestedChannel === "string" ? requestedChannel.trim().toLowerCase() : "";
  return requested === "staging" ? "staging" : "development";
}

// electron-updater must stay off in a validation build. `NODE_ENV=development`
// is the existing kill switch, but setting it on a packaged build also
// switches every window to the Vite dev server (windowManager.loadWindowContent),
// so the artifact would not run offline. Without a kill switch the build
// checks GitHub on startup and every 4 hours, and a fresh profile defaults
// `autoUpdatesEnabled` to true (settingsStore.ts initializeAutoUpdatesDefault),
// so it would download the latest release's NSIS installer and run it from the
// quit handler (`autoInstallOnAppQuit`), installing over the tester's
// production copy.
function areUpdatesDisabled({ nodeEnv, isValidationBuild } = {}) {
  return nodeEnv === "development" || isValidationBuild === true;
}

// The OAuth scheme must follow the pinned channel, not the environment.
// main.js getOAuthProtocol() honours VITE_OPENWHISPR_PROTOCOL /
// OPENWHISPR_PROTOCOL ahead of the per-channel default, so an inherited
// `OPENWHISPR_PROTOCOL=openwhispr` (a stray shell export, a parent process, a
// leftover launcher) would make the test artifact claim the production
// `openwhispr://` handler and point it at the throwaway executable. In a
// validation build the env override is refused outright: the artifact is never
// the machine's real OAuth target, so there is no legitimate reason to override
// it, and failing closed is cheaper than guessing which overrides are safe.
function shouldIgnoreProtocolOverride({ isValidationBuild } = {}) {
  return isValidationBuild === true;
}

// `~/.openwhispr/cli-bridge.json` (cliBridge.js) is the one piece of app state
// that lives outside userData and carries no channel in its name. Every launch
// overwrites it with that instance's port and bearer token, and every quit
// deletes it, so an unscoped test build would redirect the tester's `openwhispr`
// CLI at the test app and then remove the entry. Scoped by channel in a
// validation build; untouched everywhere else.
function resolveCliBridgeFileName({ isValidationBuild, channel } = {}) {
  if (!isValidationBuild) return "cli-bridge.json";
  const suffix = typeof channel === "string" ? channel.trim().toLowerCase() : "";
  if (!suffix || suffix === "production") return "cli-bridge-validation.json";
  return `cli-bridge-${suffix.replace(/[^a-z0-9-]/g, "")}.json`;
}

// Qdrant's storage directory (qdrantManager.js) lives under
// ~/.cache/openwhispr and is keyed on NODE_ENV, not on the channel, so a
// packaged validation build would open the production `qdrant-data` even with
// userData isolated. Unlike the model downloads beside it this directory is
// mutable, written by a sidecar, and two processes must not open it at once.
// Its sidecar PID file already lives under userData, so the channel pin covers
// that part.
function resolveQdrantDataDirName({ isValidationBuild, nodeEnv } = {}) {
  if (isValidationBuild === true) return "qdrant-data-validation";
  return nodeEnv === "development" ? "qdrant-data-dev" : "qdrant-data";
}

// The OS credential vault entry (secretCrypto.js) is one constant
// service/account pair for every channel, so a validation build would read —
// and, if production had never created one, define — the production master
// key. Nothing deletes that entry (clearAllPersistedData only removes
// userData/.env and userData/secure-keys), so this is about not touching
// someone else's vault rather than about losing it.
function resolveKeyringService({ isValidationBuild, baseService } = {}) {
  const base = typeof baseService === "string" && baseService ? baseService : "OpenWhispr";
  return isValidationBuild === true ? `${base}-validation` : base;
}

// The device-erasure path (ipcHandlers.js `cleanup-app` and
// `delete-account-data` with `erasingDevice`) deletes the whisper, Parakeet,
// diarization, LLM, embedding and yt-dlp caches under ~/.cache/openwhispr.
// Those are deliberately SHARED with the production install so a tester does
// not re-download gigabytes, which means a validation build must never erase
// them — a stray "Reset app data" click would otherwise wipe the production
// app's models. The validation build's own Qdrant directory is still removed.
function shouldSkipSharedDeviceCaches({ isValidationBuild } = {}) {
  return isValidationBuild === true;
}

// The model/binary delete IPC routes (ipcHandlers.js: delete-whisper-model,
// delete-all-whisper-models, delete-parakeet-model,
// delete-all-parakeet-models, delete-diarization-models, model-delete,
// model-delete-all) all remove files from the SHARED ~/.cache/openwhispr
// downloads, individual variants included. Guarding only the device-erasure
// path would still leave a tester one click in the model manager away from
// deleting the production install's models, so a validation build refuses
// every one of them and says why.
//
// Rejected alternative: isolating the cache with OPENWHISPR_CACHE_ROOT.
// modelDirUtils.getCacheRoot() calls migrateLegacyModelDirs(homeCache,
// targetRoot) whenever the resolved root differs from ~/.cache/openwhispr,
// which `renameSync`s the production model subdirectories into the new root —
// so pointing a test build at its own cache root would MOVE the production
// install's models rather than isolate them. The GPU binary packs need no
// guard: GpuBinaryManager installs them under userData/bin, which the channel
// pin already isolates.
const SHARED_DOWNLOAD_DELETE_REFUSAL = Object.freeze({
  success: false,
  code: "VALIDATION_BUILD_SHARED_DOWNLOADS",
  error:
    "This is a validation test build. Its downloaded speech and AI models are shared with the installed OpenWhispr, so it will not delete them. Remove them from your normal OpenWhispr install instead.",
});

// Returns the refusal to hand straight back from a delete route, or null when
// the route should run as it always has.
function refuseSharedDownloadDelete({ isValidationBuild } = {}) {
  return isValidationBuild === true ? SHARED_DOWNLOAD_DELETE_REFUSAL : null;
}

// modelDirUtils.getCacheRoot() resolves a cache root and then, whenever that
// root differs from ~/.cache/openwhispr, calls migrateLegacyModelDirs(), which
// `renameSync`s the production install's whisper-models, parakeet-models,
// diarization-models and models directories into it. That runs at startup, on
// the first model path lookup, and reaches the production directories under
// two conditions a handed-out artifact does not control:
//
//   1. an inherited OPENWHISPR_CACHE_ROOT (the same class of leak as
//      OPENWHISPR_PROTOCOL), and
//   2. the automatic Windows non-ASCII fallback, when the profile path is not
//      printable ASCII and the root becomes C:\ProgramData\OpenWhispr\cache.
//
// Guarding the delete routes does not close this: a migration is a rename, not
// a delete. So a validation build refuses the env override and never performs
// the migration. It still resolves the same root production would, so it finds
// models production already moved; if production has not migrated yet, the
// test build simply re-downloads into that root rather than moving anything.
function shouldIgnoreCacheRootOverride({ isValidationBuild } = {}) {
  return isValidationBuild === true;
}

function shouldSkipLegacyCacheMigration({ isValidationBuild } = {}) {
  return isValidationBuild === true;
}

// Local isolation says nothing about the cloud. executeAccountDeletion
// (src/lib/accountDeletionFlow.ts) calls deleteRemoteAccount() FIRST, and
// src/lib/accountDeletionRequest.ts issues a real DELETE
// /api/auth/delete-account — so "Delete account" in a test build would destroy
// the tester's live OpenWhispr account, and the isolated profile would not save
// them. Acceptance for a BYOK OpenAI setup runs signed out (the onboarding
// flow supports authPath "guest" with setupMode "byok"), which keeps the button
// out of reach, but "do not press that" is weak protection for something
// irreversible.
//
// Renderer cloud calls all travel through main's `cloud-api-request` IPC
// (src/helpers/cloudApiRequest.js), which is a marker-exact chokepoint needing
// no renderer change and no new IPC contract. Only the account-destroying call
// is refused: sync, transcription and the rest stay usable if a tester does
// sign in.
const VALIDATION_BLOCKED_CLOUD_CALLS = Object.freeze([
  Object.freeze({ method: "DELETE", path: "/api/auth/delete-account" }),
]);

const VALIDATION_BLOCKED_CLOUD_CALL_REFUSAL = Object.freeze({
  success: false,
  code: "VALIDATION_BUILD_BLOCKED_CLOUD_CALL",
  error:
    "This is a validation test build and will not delete your OpenWhispr account. Deleting an account is permanent and affects the real cloud account, not just this test profile. Use your normal OpenWhispr install if you actually mean to delete it.",
});

function refuseValidationDestructiveCloudCall({ isValidationBuild, method, path } = {}) {
  if (isValidationBuild !== true) return null;
  const normalizedMethod = String(method || "GET").toUpperCase();
  // Compare the path alone: a query string or a trailing slash must not slip
  // the same call past the list.
  const normalizedPath =
    String(path || "")
      .split(/[?#]/)[0]
      .replace(/\/+$/, "") || "/";
  const blocked = VALIDATION_BLOCKED_CLOUD_CALLS.some(
    (call) => call.method === normalizedMethod && call.path === normalizedPath
  );
  return blocked ? VALIDATION_BLOCKED_CLOUD_CALL_REFUSAL : null;
}

module.exports = {
  IS_VALIDATION_BUILD,
  resolveValidationChannel,
  areUpdatesDisabled,
  shouldIgnoreProtocolOverride,
  resolveCliBridgeFileName,
  resolveQdrantDataDirName,
  resolveKeyringService,
  shouldSkipSharedDeviceCaches,
  refuseSharedDownloadDelete,
  SHARED_DOWNLOAD_DELETE_REFUSAL,
  shouldIgnoreCacheRootOverride,
  shouldSkipLegacyCacheMigration,
  refuseValidationDestructiveCloudCall,
  VALIDATION_BLOCKED_CLOUD_CALLS,
  VALIDATION_BLOCKED_CLOUD_CALL_REFUSAL,
};
