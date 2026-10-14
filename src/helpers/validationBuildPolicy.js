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

module.exports = {
  IS_VALIDATION_BUILD,
  resolveValidationChannel,
  areUpdatesDisabled,
  shouldIgnoreProtocolOverride,
  resolveCliBridgeFileName,
};
