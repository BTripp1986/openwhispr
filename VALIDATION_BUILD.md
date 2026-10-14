# Windows validation build (test-only, fork-only)

**This file and everything it enumerates live only on `validation/*` branches.
None of it belongs in the upstream feature PR.** The feature branch is
`feature/dictation-cleanup-hotkeys`; this branch is `feature SHA + packaging`,
and CI refuses to build if that is not literally true
(`scripts/validation/check-packaging-only-diff.js`).

The goal is one downloadable thing a tester can unzip and run on Windows 11
with no Node, npm, git, Vite or build tools, that cannot touch their installed
OpenWhispr.

## Why a packaging patch is needed at all

Three facts about the base (`a27f9fba`) make a plain unsigned build unsafe to
hand over:

1. **A packaged executable resolves to the production channel.**
   `inferDefaultChannel()` in `main.js` returns `production` unless `NODE_ENV`
   is `development`, `process.defaultApp` is set, or the executable is bare
   Electron — none of which hold for `dist\win-unpacked\OpenWhispr.exe`. The
   production channel means the production `%APPDATA%\OpenWhispr` profile, the
   production `openwhispr://` handler, the production AppUserModelId and the
   same launch-at-login registry value name. A launcher that exports
   `OPENWHISPR_CHANNEL` fixes this only while the launcher is used; a
   double-click of the executable does not.

2. **A non-production channel does not disable the updater.** `src/updater.js`
   gates on `NODE_ENV === "development"` alone. On a fresh profile
   `initializeAutoUpdatesDefault()` (`src/stores/settingsStore.ts`) defaults
   `autoUpdatesEnabled` to **true**, `checkForUpdatesOnStartup()` runs 3s after
   launch and every 4 hours, `update-available` then calls
   `_autoDownloadIfEnabled()`, and `autoInstallOnAppQuit` is true — so the test
   build would download the newest release's NSIS installer and run it from its
   own quit handler, installing over the tester's production copy.

3. **`NODE_ENV=development` is not an option on a packaged build.**
   `windowManager.loadWindowContent()` and four sibling load paths send every
   window to the Vite dev server in that mode, so the artifact would need a
   running `npm run dev:renderer` and would not be self-contained.

Two further leaks only showed up once the channel was pinned:

4. **`getOAuthProtocol()` honours `VITE_OPENWHISPR_PROTOCOL` /
   `OPENWHISPR_PROTOCOL` ahead of the per-channel default**, so an inherited
   export (stray shell variable, parent process, leftover launcher) would make
   the pinned-channel test build register the production `openwhispr://`
   handler and point it at the throwaway executable.

5. **`~/.openwhispr/cli-bridge.json`** (`src/helpers/cliBridge.js`) is app
   state outside userData with no channel in its name. The bridge starts
   unconditionally on every launch, overwrites that file with its own port and
   bearer token, and **deletes it on quit** — so an unscoped test build would
   redirect the tester's `openwhispr` CLI at itself and then remove the
   production entry.

6. **Qdrant's storage directory** (`src/helpers/qdrantManager.js`) is
   `~/.cache/openwhispr/qdrant-data`, keyed on `NODE_ENV` rather than on the
   channel, so a packaged test build opens the production index even with
   userData isolated. Unlike the read-only model downloads beside it, this one
   is mutable and written by a sidecar two processes must not share.

7. **The OS credential vault entry** (`src/helpers/secretCrypto.js`) is one
   constant service/account pair for every channel, so a test build would read
   the production master key — and define it if production had never created
   one. Nothing deletes that entry (`clearAllPersistedData()` only removes
   `userData/.env` and `userData/secure-keys`), so this is about not reaching
   into someone else's vault, not about losing it.

8. **Every model-delete route** (`src/helpers/ipcHandlers.js`) removes files
   from the shared `~/.cache/openwhispr` downloads: the device-erasure path
   (`cleanup-app`, `delete-account-data` with `erasingDevice`) and also the
   ordinary per-model buttons — `delete-whisper-model`,
   `delete-all-whisper-models`, `delete-parakeet-model`,
   `delete-all-parakeet-models`, `delete-diarization-models`, `model-delete`
   and `model-delete-all`. Guarding only the erasure path would still leave a
   tester one click in the model manager away from deleting the production
   install's models. (The GPU binary packs need no guard: `GpuBinaryManager`
   installs them under `userData/bin`, which the channel pin already isolates.)

9. **`modelDirUtils.getCacheRoot()` can rename the production install's model
   directories at startup.** Whenever the root it resolves differs from
   `~/.cache/openwhispr` it calls `migrateLegacyModelDirs()`, which
   `renameSync`s `whisper-models`, `parakeet-models`, `diarization-models` and
   `models` into the new root. Two conditions reach that without anyone asking:
   an inherited `OPENWHISPR_CACHE_ROOT`, and the automatic Windows fallback
   when the profile path is not printable ASCII (the root then becomes
   `C:\ProgramData\OpenWhispr\cache`). A migration is a rename, not a delete,
   so the delete guards above do not close it.

   This is also why the cache is **not** isolated by pointing the test build at
   its own `OPENWHISPR_CACHE_ROOT`: doing that would _move_ the production
   install's models rather than isolate them.

## The approach: a build-time marker, not an environment variable

`electron-builder.validation-win.json` injects `openwhisprValidationBuild: true`
into the packaged `package.json` through `extraMetadata`, exactly the mechanism
`windowsTrayIdentity` already uses (`src/helpers/tray.js`). Nothing depends on
the launcher: the artifact is safe when double-clicked, and the launchers only
make the isolation visible.

`src/helpers/validationBuildPolicy.js` is the only place that reads the marker.
Every decision in it is a pure function, and **every one of them returns the
upstream answer when the marker is absent** — which is the case in every normal
build, every dev run and every CI job other than this one. That is what the
`isValidationBuild: false` half of each test pins.

## Enumerated test-only changes

| #   | Path                                                                                    | Kind | What it does                                                                                                                                                                                                                                                                                                                                                      |
| --- | --------------------------------------------------------------------------------------- | ---- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1   | `src/helpers/validationBuildPolicy.js`                                                  | new  | Pure policy: channel pin, updater kill switch, protocol-override refusal, CLI-bridge file name. Reads the marker; no Electron.                                                                                                                                                                                                                                    |
| 2   | `main.js` (+19/-1 lines, 2 hunks)                                                       | edit | `resolveAppChannel()` consults `resolveValidationChannel()` first; `getOAuthProtocol()`'s env-override branch is guarded by `shouldIgnoreProtocolOverride()`.                                                                                                                                                                                                     |
| 3   | `src/updater.js` (+16/-6)                                                               | edit | The six `NODE_ENV === "development"` update gates route through one `updatesDisabled()` helper that also honours the marker. Identical behaviour without it.                                                                                                                                                                                                      |
| 4   | `src/helpers/cliBridge.js` (+10/-1)                                                     | edit | `getBridgeFilePath()` takes its file name from `resolveCliBridgeFileName()`, so a validation build writes `cli-bridge-development.json`.                                                                                                                                                                                                                          |
| 4a  | `src/helpers/qdrantManager.js` (+12/-1)                                                 | edit | `STORAGE_DIR` resolves through `resolveQdrantDataDirName()`, so a validation build opens `~/.cache/openwhispr/qdrant-data-validation` instead of the production index.                                                                                                                                                                                            |
| 4b  | `src/helpers/secretCrypto.js` (+9/-1)                                                   | edit | The keyring `SERVICE` resolves through `resolveKeyringService()`, so a validation build uses the `OpenWhispr-validation` vault entry.                                                                                                                                                                                                                             |
| 4c  | `src/helpers/ipcHandlers.js` (+41/-5)                                                   | edit | One `eraseSharedCaches` guard, from `shouldSkipSharedDeviceCaches()`, in front of each shared model/cache deletion in the device-erasure path (the user is told the caches were kept; the validation build's own Qdrant directory is still removed), plus a one-line `sharedDownloadDeleteRefusal` guard as the first statement of all seven model-delete routes. |
| 4d  | `src/helpers/modelDirUtils.js` (+21/-1)                                                 | edit | `getPreferredCacheRoot()` refuses an inherited `OPENWHISPR_CACHE_ROOT` and `getCacheRoot()` skips `migrateLegacyModelDirs()`, so a validation build never renames the production install's model directories. It still resolves the root production would, so it finds models production already moved.                                                           |
| 5   | `electron-builder.validation-win.json`                                                  | new  | Extends `electron-builder.unsigned-win.json`; sets the marker, keeps `windowsTrayIdentity: false`, ships the launchers and readme via `extraFiles`.                                                                                                                                                                                                               |
| 6   | `validation/`                                                                           | new  | `Launch-OpenWhispr-Test.cmd`, `Launch-OpenWhispr-Test-Debug.cmd`, `READ-ME-FIRST.txt` (CRLF), `FEATURE_SHA`, `UPSTREAM_BASE_SHA`, `PACKAGING_PATHS`.                                                                                                                                                                                                              |
| 7   | `scripts/validation/verify-windows-test-artifact.js`, `scripts/validation/asarPaths.js` | new  | 20 static checks on `dist\win-unpacked`, plus separator-safe asar path helpers. Launches nothing.                                                                                                                                                                                                                                                                 |
| 8   | `scripts/validation/check-packaging-only-diff.js`                                       | new  | Refuses to package if the branch differs from the pinned feature SHA outside `validation/PACKAGING_PATHS`.                                                                                                                                                                                                                                                        |
| 9   | `test/validation/*.test.js`                                                             | new  | 60 tests: every policy decision both ways, the updater and cache-root modules exercised behaviourally both ways (in-memory `fs`, no real file touched), the asar path helpers against both separators, and the artifact gate against a synthetic `win-unpacked` tree (16 negative cases).                                                                         |
| 10  | `.github/workflows/validation-windows-build.yml`                                        | new  | Fork-only, push-triggered, unsigned `--dir` build. Never signs, publishes or releases.                                                                                                                                                                                                                                                                            |
| 11  | `.gitattributes` (+2)                                                                   | edit | CRLF for `validation/*.cmd` and `validation/*.txt`.                                                                                                                                                                                                                                                                                                               |

Nothing in 1–11 is reachable from an ordinary build, and nothing changes the
dictation feature's behaviour. Five of the edits (2, 4a, 4b, 4c, 4d) are in
files the feature itself may also touch; the packaging gate compares this
branch against the feature SHA, so only these added lines appear as the
packaging delta.

## Building a candidate

1. Push the reviewed feature commit to the fork's feature branch.
2. On this branch, merge that exact commit, write its full 40-hex SHA into
   `validation/FEATURE_SHA`, and push.
3. The push triggers `Validation Windows Build (fork-only, unsigned)`:
   - **guard** (ubuntu): refuses to run on upstream; asserts the pinned SHA is
     an ancestor of HEAD; asserts the packaging-only diff; publishes that diff
     to the job summary; then `lint`, `typecheck`, `i18n:check` and the full
     suite with `REQUIRE_DB_TESTS=1`.
   - **build-windows** (windows-latest): `npm ci`, the three `--no-save`
     platform binaries, a lockfile-unchanged assertion, a refusal to build if
     any `.env` is present, then
     `npm run build:win -- --dir --publish never --config electron-builder.validation-win.json`.
     It writes `manifest.json` / `BUILD-INFO.txt` (`featureSha`,
     `validationSha`, `buildRun`), runs the artifact verifier, zips the
     complete directory and records SHA256 for the zip and the executable.
     Failure uploads the builder debug config and the verifier log.

`validation/FEATURE_SHA` may hold the literal `BASELINE` instead of a SHA. That
builds this branch's packaging on top of `validation/UPSTREAM_BASE_SHA` with no
feature code at all, and labels the artifact `baseline-only`. It proves the
build infrastructure, never the feature.

The upstream `Build and Notarize` workflow takes the **signing** path on
anything other than a `pull_request`, so it must not be dispatched on the fork
for this. This workflow is separate on purpose and leaves the fork's `main`
untouched.

## What the automated checks do and do not establish

`verify-windows-test-artifact.js` and the test suite read bytes. They establish
that the marker shipped, the channel is pinned, the updater is gated, the OAuth
protocol override is refused, the CLI bridge file and the Qdrant index are
scoped away from production, the credential vault entry is validation-scoped,
every shared-cache deletion is guarded (the erasure path and all seven
model-delete routes), the model cache cannot be migrated, no real
`.env` or credential-shaped string is packaged, the asar carries all 11
locales, the native modules (`better-sqlite3`, `ffmpeg`, `onnxruntime`,
`onnxWorker`) are unpacked, `windows-key-listener.exe` is present, ONNX Runtime
is privatized and the executable is unsigned.

They establish **nothing** about global hotkey registration, the Windows
low-level keyboard hook, microphone capture, clipboard paste, OpenAI
transcription or the cleanup pass. Whether the bundled native bindings match the
bundled Electron's ABI is also only provable by launching. All of that needs a
native Windows 11 run by a human. No Linux result and no WSL result counts.

## Launching it (tester steps)

1. Quit production OpenWhispr from its tray icon. Two copies cannot share global
   hotkeys.
2. Unzip anywhere and double-click **`Launch-OpenWhispr-Test.cmd`** (or
   `Launch-OpenWhispr-Test-Debug.cmd` to also write a debug log, which records
   `ROUTE_RESOLVED` / `REASONING_SKIPPED` per recording — the non-sensitive
   evidence that raw dictation made no cleanup request). Running
   `OpenWhispr.exe` directly is equally safe.
3. SmartScreen will warn: _More info → Run anyway_. It is unsigned on purpose.
4. Grant the microphone permission, then enter the OpenAI key and pick the STT
   and cleanup models in the test app's masked Settings fields. Keys go into the
   app only — never into a chat message, a log or a command line.
5. `BUILD-INFO.txt` beside the executable names the exact commit under test.

### Expected differences from a release

Built with none of the project's secrets, so the Google / Microsoft / Apple
calendar, Slack, Linear and GitHub connectors report "not configured" or hide
their Settings rows; the licensed brand font is absent so text renders in the
bundled Noto Sans; and the build is unsigned so the tray icon keeps no fixed
position. Dictation, transcription and the cleanup pass are unaffected.

### Shared state: what is shared, and what was carved out

`~/.cache/openwhispr/` has no channel in its path. The **download caches** there
(whisper, Parakeet and diarization models, the LLM GGUF models, the embedding
model and `yt-dlp`) stay shared on purpose: they are large immutable downloads,
and isolating them would make a tester re-fetch gigabytes. The test build reads
them, and may add a model the tester downloads in it — which production can then
use too.

Sharing is **not** read-only: a model downloaded inside the test build is
written to that shared cache, and the production install can then use it. What
the test build must never do is remove or relocate what is already there, and
three things in that directory were not safe to leave alone:

- **`qdrant-data`** is a mutable index written by a sidecar, so the validation
  build uses `qdrant-data-validation` instead (change 4a). Without that the two
  copies would open the same index directory.
- **Deletion** — the device-erasure path and all seven per-model delete routes —
  is refused (change 4c), and each refusal says why rather than failing
  silently.
- **Relocation** — `getCacheRoot()`'s legacy migration — is skipped (change 4d).

So the accurate claim is not "fully isolated". The test build's **own data** —
settings, history, notes, API keys, the Qdrant index, the OAuth handler, the CLI
bridge entry and the credential vault entry — is isolated from production. The
downloaded **model files** are shared and may be added to from either side; no
code path in the test build can delete or move them.

### Removing it

Delete the unzipped folder and `%APPDATA%\OpenWhispr-development`. Optionally
also remove `%USERPROFILE%\.cache\openwhispr\qdrant-data-validation`,
`%USERPROFILE%\.openwhispr\cli-bridge-development.json`, the
`OpenWhispr-validation` Windows Credential Manager entry, and the registry key
`HKEY_CURRENT_USER\Software\Classes\openwhispr-dev`. Leave anything named
`OpenWhispr` or `openwhispr` **without** a `-dev`/`-validation` suffix alone —
those belong to the production install, and so do the shared model downloads
under `%USERPROFILE%\.cache\openwhispr\`.
