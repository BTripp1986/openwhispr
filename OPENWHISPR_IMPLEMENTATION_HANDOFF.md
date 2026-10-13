# OpenWhispr: raw and cleaned dictation hotkeys

Prepared for Claude Code on 2026-10-13. Ben Tripp is the contributor and will perform final acceptance testing on Windows 11. Jarvis coordinates the contribution; Claude Code owns application implementation.

## Repository and scope

- Upstream: https://github.com/OpenWhispr/openwhispr
- Fork: https://github.com/BTripp1986/openwhispr
- Implementation branch: `feature/dictation-cleanup-hotkeys`
- Base: upstream `main`, commit `fac11281261862efa62c5af4e673d851d92fb4d2` (version 1.10.3).
- Existing feature request: https://github.com/OpenWhispr/openwhispr/issues/2407
- Contribution intent and acceptance criteria: https://github.com/OpenWhispr/openwhispr/issues/2407#issuecomment-6148652274
- This brief lives on `coordination/dictation-cleanup-hotkeys`. Do not merge that branch into the implementation branch or include this orchestration document in the upstream PR.

Implement the feature, test it, commit only related changes, and push to the fork's implementation branch. Do not push upstream, open a PR, enable auto-merge, publish a release, or merge anything. Jarvis will open the upstream PR only after Ben explicitly confirms Windows acceptance. Return the commit SHA, diff summary, actual test results, remaining limitations, and a reproducible Windows test-build procedure.

First inspect the current code and repository instructions before selecting a design. This brief records findings, not a prescribed architecture. Re-read the issue and comments for new maintainer feedback, fetch upstream, and check whether relevant work has landed since the base above. Do not overwrite another contributor's commits or copy old PRs wholesale.

## Portable setup

Use a new working directory; the Linux orchestration checkout is not assumed to exist on your machine.

```sh
git clone https://github.com/BTripp1986/openwhispr.git
cd openwhispr
git remote add upstream https://github.com/OpenWhispr/openwhispr.git
git fetch upstream
git switch feature/dictation-cleanup-hotkeys
git status --short --branch
git log --oneline --left-right upstream/main...HEAD
```

If reusing a checkout, inspect existing remotes and local changes instead of blindly repeating those commands. The prepared branch had zero commits beyond upstream at handoff preparation. Fast-forward to a newer upstream main if the branch is still unchanged; once implementation starts, integrate upstream deliberately without force-pushing someone else's work.

Use Node **24**, matching `.nvmrc`, not merely any version accepted by `engines.node >=24`. Verify `node --version` and `npm --version`, then `npm ci` and `npm run dev` as needed. Do not regenerate the lockfile with another Node major. On Windows, install/use Node 24 with the machine's normal toolchain; Unix `nvm` commands are not Windows instructions. Native Windows helper compilation needs Visual Studio Build Tools or MinGW-w64; supported download fallbacks are in the repository's scripts. If modifying native helper source, compile the changed helper rather than testing an older downloaded binary.

Read `README.md`, `.github/CONTRIBUTING.md`, `CLAUDE.md`, `.nvmrc`, `package.json`, `.github/workflows/build-and-notarize.yml`, and any newly added scoped instructions. The canonical contribution guide is https://docs.openwhispr.com/contributing. Desktop work is at the repository root; do not modify `openwhispr-mobile/`.

## Problem and required behavior

Ben alternates between fast dictation of prompts into coding agents and cleaned dictation for email/documents. The global cleanup toggle adds a settings detour, and cleanup adds latency where only a transcript is needed.

Provide two independently configurable global shortcuts in the existing hotkey settings:

1. **Raw dictation:** transcribe and paste without the additional AI cleanup pass, regardless of the global cleanup preference.
2. **Cleaned dictation:** transcribe, run the configured Dictation Cleanup provider/model/prompt, and paste, regardless of that preference.

Preserve the existing dictation shortcut and its preference-following behavior, existing saved bindings, and button/tray/onboarding behavior unless a narrowly justified change is necessary. New shortcuts should be optional and should not reserve surprise default combinations. This is not a request to route either shortcut through the Voice Assistant or create a generic multi-workflow editor.

Use a recording-specific override or another equally safe scoped design. Do not temporarily change `useCleanupModel`, write localStorage, persist environment settings, or broadcast global preference changes to choose an individual recording's behavior. Hotkey settings themselves should persist normally.

Here, raw means bypassing the extra AI post-processing step, not promising byte-for-byte spoken output from the STT model or removing existing dictionary/snippet/paste behavior. Explicit raw/cleaned dictation must stay dictation even if its text resembles an assistant wake phrase; the existing default and Voice Assistant entry points retain their established routing.

Local cleanup prewarming was suggested by the original issue author. It is not required for this contribution. Do not add model lifecycle changes, threshold-based cleanup, per-app profiles, or a broader hotkey refactor to deliver this feature.

### Acceptance criteria

- Both shortcuts are configurable, clearable, persisted across restart, and conflict-checked against each other and every existing action. Normal registration failure/rollback behavior remains intact; no saved shortcut falsely appears active.
- With global cleanup ON, raw bypasses cleanup and cleaned uses it. With it OFF, raw still bypasses and cleaned still uses the configured model. The existing dictation shortcut continues to follow the preference.
- Explicit raw dictation makes no additional cleanup/assistant inference request. Explicit cleaned dictation invokes the configured cleanup path once, not an unrelated agent or a duplicate cleanup after a fallback.
- The recording's selected mode survives asynchronous stop/transcription/stream finalization. Repeated keydown, opposite-mode key presses during capture or processing, and quick consecutive recordings cannot change an in-flight recording's mode or leak it to the next one. Define deterministic behavior consistent with existing recording guards.
- Cancellation, microphone/start errors, no audio, provider failures, retries, force-stop, discarded-recording recovery, and normal completion leave the next recording's mode correct. Cancelled work must not paste late output.
- A missing/unreachable cleanup model or failed cleanup follows the project's appropriate user-visible failure/fallback behavior; do not lose the transcript or claim cleanup succeeded. The cleaned shortcut cannot manufacture missing configuration or bypass organization/provider policy. See related pending PR #2634 before changing this area.
- Preserve ordinary dictation, existing Tap/Hold behavior, translation, meeting/note recording, Voice Assistant, selection edits, clipboard/history, preview states, and policy checks. If new shortcuts have a platform/activation limitation, make it explicit, follow existing UX, and document it; do not silently disable existing Hold support.
- Cover supported desktop hotkey backends using existing abstractions. Ben's required hands-on acceptance platform is Windows 11. Report untested macOS/Linux behavior honestly.
- All new user-facing text uses the i18n system and is added to every current locale. Keep the UI consistent and the change focused.

## Research and maintainer context

The latest release checked was [v1.10.3](https://github.com/OpenWhispr/openwhispr/releases/tag/v1.10.3), published October 12. Current main still derives ordinary cleanup eligibility from `settings.useCleanupModel`; no separate raw/cleaned action was found. Searches covered open and closed issues/PRs and all 27 current discussions. No equivalent implementing PR was identified or linked to #2407 at preparation time.

- **#2407:** exact open request, by Will-Griffiths-Ireland. Reuse it; do not create another issue. No maintainer design approval or assignment was present when researched. Ben's contribution comment is not maintainer approval.
- **[Discussion #107](https://github.com/OpenWhispr/openwhispr/discussions/107):** the processing-mode hotkey comment proposed voice-only, voice-plus-agent, and voice-plus-screenshot-plus-agent. A maintainer welcomed the direction. The maintainer later closed the broad thread and explicitly directed feature requests to Issues. `.github/CONTRIBUTING.md` agrees. Do not create a new Discussion.
- **[#1484](https://github.com/OpenWhispr/openwhispr/issues/1484):** older equivalent request, closed as completed. A maintainer recommended disabling cleanup on ordinary dictation and using the Voice Assistant for rich dictation. The requester later said it no longer worked as desired and remained a workaround. Current Voice Assistant routes commands into an assistant/selection-edit flow, not the configured cleanup pass. Treat this as important product feedback, not proof the requested feature exists or has been accepted upstream.
- **[#24](https://github.com/OpenWhispr/openwhispr/issues/24) / [merged PR #1017](https://github.com/OpenWhispr/openwhispr/pull/1017):** multiple hotkeys for the *same* action shipped in 1.7.5. Alternate bindings do not independently choose cleanup. The existing comma-separated binding format and per-backend limits must be preserved.
- **[PR #316](https://github.com/OpenWhispr/openwhispr/pull/316):** older flexible multi-hotkey design, closed **without merging**. Its per-binding modes were transcription/agent, not this exact cleanup choice. Do not treat it as current architecture or resurrect the broad refactor.
- **[PR #932](https://github.com/OpenWhispr/openwhispr/pull/932) and [PR #1189](https://github.com/OpenWhispr/openwhispr/pull/1189):** merged Voice Assistant and translation shortcuts provide useful historical precedents. Inspect current files because routing has changed since those PRs.
- Related open work worth rechecking: [#2111](https://github.com/OpenWhispr/openwhispr/pull/2111) per-app voice modes, [#2436](https://github.com/OpenWhispr/openwhispr/pull/2436) combined Orukeet cleanup/provider snapshots, [#2530](https://github.com/OpenWhispr/openwhispr/pull/2530) activation-mode restoration, [#2634](https://github.com/OpenWhispr/openwhispr/pull/2634) missing-cleanup-model warnings. None was merged when researched; do not implement against their APIs as though already on main.

The feature request template has problem, desired solution, alternatives, and additional-context sections. No desktop PR template was found in the repository or accessible organization-wide `.github` repository. Recheck before submission; if none exists, use a concise description of why, what, testing, screenshots, and remaining limitations, linking #2407.

## Architecture map: inspect these seams

This is an Electron main/preload plus shared React renderer application, with a dictation overlay and control panel. The following map is based on the pinned base; names and line numbers may move.

### Hotkeys, native dispatch, and settings

- `src/helpers/hotkeyManager.js`: named slots, multi-binding registration, conflicts, unregister/rollback, backend dispatch, translated slot labels. Current dictation-related slots include `dictation`, `voiceAgent`, `translation`, and `meeting`. Inspect all slots/call sites rather than assuming this list is exhaustive.
- `main.js`: startup restoration, slot callbacks, key repeat guards, native macOS/Windows/Linux event paths, Tap/Hold dispatch, resource teardown. New behavior must reach native events as well as `globalShortcut` callbacks.
- `src/helpers/hotkeyRepeatGate.js`, `src/helpers/hotkeyList.js`: existing repeat and multiple-binding behavior.
- `src/helpers/gnomeShortcut.js`, `src/helpers/hyprlandShortcut.js`, `src/helpers/kdeShortcut.js`: native Wayland registration paths; verify exact current filenames and backend methods. Existing native backends limit each slot to a primary binding, even if multiple are stored.
- `src/helpers/windowsKeyManager.js`, `src/helpers/linuxKeyManager.js`, relevant macOS native-listener helpers, and `resources/windows-key-listener.c`: inspect current native key selection/routing. Avoid changing native binaries unless necessary.
- `src/helpers/windowManager.js`: guarded `_sendDictationToggle`, `sendToggleDictation`, `sendToggleVoiceAgent`, `sendToggleTranslation`, and lifecycle state. Check actual exported names before editing.
- `src/helpers/ipcHandlers.js`, `preload.js`, `src/types/electron.ts`: registration/readback IPC, renderer events, typed Electron bridge. Update all sides of any changed contract.
- `src/helpers/environment.js`: durable hotkey settings such as `DICTATION_KEY`, `VOICE_AGENT_KEY`, `TRANSLATION_KEY`; preserve unrelated persisted settings.
- `src/stores/settingsStore.ts`: settings defaults, cross-window synchronization, `createRegisteredHotkeySetter`, optimistic update rollback, environment hydration and serialization. New hotkeys need complete persistence, not only a component state variable.
- `src/hooks/useSettings.ts`, `src/hooks/useHotkeyRegistration.ts`, `src/hooks/useHotkeyModeInfo.ts`: inspect actual existing settings exposure/registration patterns.
- `src/components/SettingsPage.tsx`: Hotkeys panel (near line 3991 at base), cross-slot validation maps and capture state. Reuse `src/components/ui/HotkeyListInput.tsx` / `HotkeyInput.tsx` and `src/utils/hotkeyValidation.ts`, `hotkeyValidator.ts`, `hotkeys.ts`.

### Per-recording state and processing

- `src/hooks/useAudioRecording.js`: `performStartRecording`, `lastStartOptionsRef`, normal/assistant/translation starts, retry, cancel and error recovery. Existing request flags are reset on each start. Stop triggers should not silently replace the active recording's selected mode.
- `src/helpers/audioManager.js`: per-recording request fields, `resolveReasoningRoute`, `isReasoningAvailable`, batch/BYOK reasoning path, `processWithOpenWhisprCloud`, streaming completion and fallback, preview, cancellation, and recovery. There are several global cleanup gates; changing only one leaves inconsistent providers.
- At base, cleanup preference checks occur near lines 258, 3003, 3184, 3505, 5939, and 5970; route resolution is called near 3216, 3542, and 5611. Re-search `useCleanupModel`, `cleanupReachable`, and `resolveReasoningRoute` rather than relying on those numbers.
- `src/helpers/dictationRouting.js`: pure route/reachability functions. Current priority is explicit assistant, translation, wake-word agent, cleanup, then skip. Think through explicit dictation versus wake-word routing without changing legacy default behavior.
- `src/helpers/dictationStreamingRouting.js`: provider/session options, including OpenAI Realtime, managed Orukeet, and fallbacks. A raw override must survive streaming-to-batch fallback and any future integrated cleanup transport; a cleaned override must not be defeated by a global-preference-based early return or stale availability cache.
- `src/helpers/dictationLifecycle.js`, `recordingSpool*`, `discardedRecording.js`: lifecycle and interrupted/cancelled audio recovery. Inspect whether any preserved recording metadata needs to retain the requested mode.
- `src/helpers/dictationTranslationInference.js`, `dictationAgentInference.js`, inference scope selectors, and existing cleanup services: reuse configured `dictationCleanup` scope and provider behavior; do not create a second reasoning pipeline.
- Keep meeting recording stores/hooks separate from this dictation-only override. Do not let a raw recording affect a meeting or Voice Assistant recording elsewhere.

## Development conventions and tests

### Verified starting point

The orchestrator checked the unchanged base on Linux using Node 24.21.0. `npm ci` completed, Electron 41.10.7's binary was present, and the working tree remained clean. These are baseline checks, not evidence that the new feature works:

- `npm run lint`: exit 0, existing warnings only (four in the root pass, two in the renderer pass).
- `npm run typecheck`: exit 0.
- `npm run i18n:check`: exit 0; locale keys/placeholders consistent.
- `npm run build:renderer`: exit 0; existing dynamic-import/large-chunk warnings.
- Focused Node tests: **132 passed, zero failed/skipped**, across `dictationRouting`, `hotkeyValidation`, `hotkeyList`, `hotkeySlotRollback`, `hotkeySlotUnregister`, `hotkeyActivationMode`, `audioManagerCancelLifecycle`, and `audioManagerCleanupFallback`.

The full suite, native desktop launch, native Windows build and physical hotkey tests were not run in the orchestration phase. No application source, dependency manifest or lockfile was modified.

### Implementation checks

Use TypeScript for new React components, existing helpers/hooks patterns, established IPC boundaries and resource cleanup. Icons come from `src/components/icons`, not new `lucide-react` imports. Avoid unrelated formatting churn. The contribution guide asks for lint and formatting; `npm run format` is broad and mutating, so review its diff and retain only relevant formatting changes.

All locale files, not the outdated count in prose, are authoritative. There were **11** `src/locales/*/translation.json` files at preparation: `ar`, `de`, `en`, `es`, `fr`, `it`, `ja`, `pt`, `ru`, `zh-CN`, `zh-TW`. Use existing interpolation and feature-key conventions. No prompt changes are expected; if necessary, follow the retired/default prompt hash rules in `CLAUDE.md`.

Run and report, at minimum:

```sh
npm run lint
npm run typecheck
npm run i18n:check
npm run format:check
npm test
npm run build:renderer
```

Run focused tests during development, then the relevant/full supported suite before delivery. Tests use Node's test runner plus `tsx`, not Vitest. Example:

```sh
node --import tsx --test test/helpers/dictationRouting.test.js test/helpers/hotkeyValidation.test.js test/helpers/audioManagerCancelLifecycle.test.js
```

Useful existing coverage includes `hotkeyList`, `hotkeySlotRollback`, `hotkeySlotUnregister`, `hotkeyStartup`, `hotkeyActivationMode`, `nativeListenerKeys`, `environmentVoiceAgentHotkey`, `registeredHotkeySetter`, `dictationRouting`, `dictationStreamingMatrix`, `audioManagerBatchRouteGuard`, `audioManagerCleanupFallback`, `audioManagerCancelLifecycle`, `audioManagerStreamingFinalization`, `useAudioRecordingForceStop`, and translation tests. Search actual paths. Prefer behavioral tests for routing, invocation count, lifecycle isolation, registration rollback and persisted settings over source-text assertions alone.

Exercise all combinations of explicit raw/cleaned/default and global cleanup on/off, configured/unconfigured/failed cleanup, representative local/BYOK/cloud and streaming/batch paths, cancellation followed by a different mode, settings changes mid-recording, repeated keys, and recording/processing guards. A mocked assertion that cleanup was not called is stronger evidence for raw-mode latency than punctuation differences in model output.

CI quality jobs use `npm ci --ignore-scripts`, rebuild `better-sqlite3` for the runner's Node, and run tests with `REQUIRE_DB_TESTS=1` and `ELECTRON_OVERRIDE_DIST_PATH=/tmp`. A normal desktop install rebuilds SQLite for Electron instead, so distinguish ABI/tooling setup failures from feature failures. Read the current workflow before emulating CI. Report skipped/platform tests and baseline failures; never count skips as passes. Run the repository's dependency audit gate if applicable, without unrelated dependency upgrades.

## Windows 11 build and acceptance

Build/test on a native Windows host or Windows runner, not Linux and not WSL-only hotkey testing. WSL cannot establish native Windows global-hotkey/clipboard acceptance.

The supported unsigned Windows config is `electron-builder.unsigned-win.json`. The regular builder config requires signing and injects a production tray identity; do not test the `win-unpacked` left by a failed signed build. The 1.10.3 release discontinued the standalone portable EXE. Do not promise that artifact or install an ordinary NSIS build over Ben's production copy.

For an unsigned unpacked artifact, after Node 24 installation and `npm ci`, run on Windows:

```powershell
npm run build:win -- --dir --publish never --config electron-builder.unsigned-win.json
```

That runs the repository's `prebuild:win` helper downloads/compilation, renderer build and directory packaging. Confirm actual output under `dist\win-unpacked`; zip the complete directory, not just the EXE. Include commit SHA, build log, SHA256, and launch instructions. Never package a real `.env`, API key, user profile, transcript, or machine-specific configuration. The builder includes `.env` if present, so inspect the artifact inputs explicitly.

The upstream build workflow's non-PR dispatch/push path attempts signing. Do not dispatch it on the fork assuming it will be an unsigned job, and do not open a premature PR just to obtain a Windows artifact. Use the native Windows build above or a separately scoped fork-only validation job if subsequently needed.

### Isolated test launch

The source already supports `OPENWHISPR_CHANNEL=development` or `staging`, with separate userData (`%APPDATA%\OpenWhispr-development` or `OpenWhispr-staging`), OAuth protocol and Windows AppUserModelId. Verify this remains true in the implemented commit before giving Ben an artifact. Use only a test profile; do not copy production settings/secure-key files or change production autostart.

Recommended first acceptance path is a source development run from this branch:

```powershell
# In a new PowerShell window, from the cloned repository:
$env:OPENWHISPR_CHANNEL = 'development'
npm run dev
```

`dev:main` supplies `NODE_ENV=development`, which disables the auto-updater and uses the Vite renderer. Quit production OpenWhispr from its tray first so its hotkeys do not compete. This does not uninstall or overwrite it. Check the test profile location and configure Ben's actual OpenAI transcription/cleanup choices through the test app's masked settings UI. Ben enters credentials locally; never ask for them in a message, log or shell command.

For the unpacked build, the launcher must set a non-production `OPENWHISPR_CHANNEL` on **every** launch. `OPENWHISPR_CHANNEL` alone does not disable the auto-updater: it checks `NODE_ENV` separately. Setting `NODE_ENV=development` on a packaged binary also switches renderer loading to a running Vite server, so do not describe that as a self-contained offline launcher. Before delivery, verify a safe no-auto-update packaged-test procedure (for example, initialize its own file-origin profile offline, disable automatic updates through its UI, then reconnect; retain the isolated channel for subsequent launches), or use the supported source dev acceptance path. No packaged Windows launch has been validated by the orchestrator. Do not tell Ben to double-click the bare EXE without isolation.

### Ben's acceptance checklist

1. Confirm the branch/commit, isolated profile, production app closed, and Windows microphone/native hotkey helper readiness.
2. Configure the actual OpenAI STT and cleanup model/prompt in the test profile; record model names only, never credentials. Use synthetic dictation, not private work material, for evidence.
3. Assign distinct raw and cleaned shortcuts in Settings. Test while focus is in a plain text editor, an email draft, and Claude Code's input. Do not send the email or submit the coding prompt during testing.
4. With global cleanup ON, raw produces the STT result without cleanup; cleaned applies the configured cleanup. Repeat with it OFF. Verify settings are unchanged after each recording and the original shortcut still follows them.
5. Use an obviously disfluent sample and a sample containing an assistant-like phrase. Confirm explicit shortcuts paste dictation rather than assistant answers. Verify raw bypass by non-sensitive diagnostics/invocation evidence, not solely by apparent text quality.
6. Compare stop-to-paste time for representative short and longer samples; do not promise a fixed latency gain. Test the configured OpenAI realtime route and batch/fallback behavior where practical.
7. Cancel and immediately start the other mode. Try quick repeated key presses, a second shortcut while already recording/processing, no audio, and cleanup failure/unconfigured handling. Confirm no stale or duplicate paste and no mode leak.
8. Test conflicts with existing hotkeys, invalid/OS-reserved combinations, clear/reassign, settings capture mode, restart persistence, and existing Tap/Hold behavior.
9. Smoke-test Voice Assistant, translation and meeting/note recording without changing their established behavior. State any unavailable/unconfigured feature instead of claiming it passed.
10. Capture settings screenshots and concise results with commit SHA. Close the test instance and reopen the production app; verify its bindings/settings/history are unchanged.

Ben must explicitly accept the implemented commit before Jarvis opens the upstream PR. A successful build or automated suite is not his acceptance.

## Handoff back to Jarvis

Return:

- Feature branch URL and pushed commit SHA; clean status and scoped diff.
- Design summary, including recording lifetime, legacy defaults, provider gates and hotkey backends.
- Commands actually run, exit results/counts, baseline failures, skipped tests and platform limitations.
- Synthetic UI screenshots and Windows artifact/build instructions, with isolated-profile and updater verification clearly distinguished from assumptions.
- Any maintainer feedback or decisions needed. Do not claim maintainer approval where only a contribution-intent comment exists.

Jarvis will review scope and evidence, coordinate Ben's Windows testing, and only after acceptance prepare the upstream PR against `main`, link #2407, and include test results. Review fixes go back to Claude Code. No upstream merge is authorized.
