# OpenWhispr: per-shortcut text cleanup

Approved by Ben, Telegram OpenWhspr topic 3323, message 3563, 2026-10-21.
This supersedes the original handoff's three separate dictation shortcut groups.
Claude Code owns implementation. Jarvis coordinates design, review and delivery.
Ben will acceptance-test a new isolated Windows 11 build. Do not open a PR yet.

### Newer scope clarification — October 21, 19:21–19:24 UTC

In the original implementation Claude session, Ben explicitly dropped migration of old beta raw/cleaned bindings: he is the only beta tester and his configuration will not carry between tests. This supersedes the original migration requirement, including older scheduler wording. Do not wipe any existing profile. Ordinary saved shortcut lists and new per-row settings still require correct persistence.

Ben also requested increasing the Linux shortcut limit if it is only an implementation gap. Source inspection confirmed single-binding backend implementations; Jarvis selected inclusion of GNOME/KDE/Hyprland dictation multi-binding support on that basis. Plan per-binding identity, native dispatch, stale cleanup and transactional rollback. Tests on this host do not establish physical Linux desktop acceptance. The direct-human excerpts and supervisor decision are recorded in the parent STATUS.md and evidence/ux-revision-20261021/HUMAN_SCOPE_UPDATES.json.

## Repository and starting point

- Upstream: https://github.com/OpenWhispr/openwhispr
- Fork: https://github.com/BTripp1986/openwhispr
- Issue: https://github.com/OpenWhispr/openwhispr/issues/2407 (open; no maintainer reply as of October 21).
- Feature branch: `feature/dictation-cleanup-hotkeys`, current tested tip `5d17ed47db832f1e21d1928c15f1baa3da77c67c`.
- Separate Windows-validation branch: `validation/dictation-cleanup-hotkeys`, previous build `9d4bd79498076c94bfaf4958cc6944feb3031ff2`.
- Coordination branch: `coordination/dictation-cleanup-hotkeys`. Never merge its briefs or mockups into the feature branch.
- Continue the existing feature history; do not reset or force-push, or fold unrelated new upstream work into this UX revision.
- Original architecture/contribution brief: `OPENWHISPR_IMPLEMENTATION_HANDOFF.md` on this coordination branch. Inspect current source and instructions before choosing a design.

## Why the UX is changing

Ben reports the previous build works well. Its default dictation shortcut plus separate Raw and Cleaned shortcut groups create confusing redundancy. He wants his existing Ctrl+Shift+Space to be the cleaned shortcut, not a third binding alongside it.

The proposed alternative of an opposite-mode shortcut was explicitly rejected: changing the global cleanup preference would invert the bindings and break muscle memory. A warning dialog does not fix that. Do not implement inversion.

## Approved UX

Keep one **Dictation Hotkey** section at the top of Hotkeys settings. Each configurable shortcut is a row/block within that section, with an optional **Customize cleanup** disclosure and a **Text cleanup** selector:

1. **Use app setting**: preserve the existing preference-following behavior. Default for existing ordinary shortcuts and newly added shortcuts.
2. **Always on**: run the configured Dictation Cleanup for recordings started by this shortcut, regardless of the global cleanup preference. This is not Voice Assistant routing.
3. **Always off**: bypass the additional AI cleanup step, regardless of the global preference. STT itself may still normalize speech.

Retain the existing **Add another hotkey** pattern. Replace the separate Raw Dictation and Cleaned Dictation UI groups; do not leave redundant visible slots or require a dummy binding. Do not introduce a new app-wide basic/advanced mode.

Ben's example:

- Ctrl+Shift+Space: Always on.
- Ctrl+Alt+Shift: Always off.

Both assignments remain unchanged if cleanup is later toggled globally. Only a deliberate change to a shortcut's selector changes its override. Ordinary Use app setting shortcuts continue to follow the app setting.

For new users: one familiar default shortcut, customization collapsed, Use app setting selected. Keep the new UI restrained. When customization is collapsed for an explicit override, a compact selected-mode summary is preferable to hiding what the shortcut does. Use existing components and visual conventions, not an unrelated redesign.

The approved concept image is `HOTKEY_UX_MOCKUP.png` beside this brief. It shows expanded controls and one open menu to illustrate choices, not a requirement that all disclosures or menus open by default. It is a generated concept, not implementation evidence. Keep existing activation controls and the other hotkey sections consistent with the real app. Translation, Voice Assistant and Meetings remain distinct and unchanged.

## Behavioral and compatibility requirements

- Preserve existing ordinary dictation, recording, transcription, paste and history behavior. Reuse the current recording-specific cleanup override and pipeline where practical.
- Never temporarily toggle, persist, or mutate the global cleanup preference to process an individual recording.
- Bind the chosen behavior to the recording lifecycle. Later shortcut presses, preference edits, cancellation, retry, async cleanup and streaming fallback must not overwrite another recording's mode. Preserve existing start/stop ownership and overlap guards.
- Preserve existing activation modes and platform/backend limitations. The activation control must accurately describe behavior of the shortcuts it governs; do not silently render Hold support that routes through a tap-only path. Evaluate the most maintainable way to preserve support, and call out any unavoidable limitation before implementation.
- Preserve Windows modifier-only shortcuts, including Ctrl+Alt+Shift; existing native listeners, OS conflict handling and key-repeat protection remain necessary.
- Cross-action conflicts and duplicate detection must cover every row, normalized key aliases, and Voice Assistant/Translation/Meeting shortcuts. Changing a row's cleanup mode must not create a second competing registration of the same key combination.
- Registration failure must leave UI, persisted shortcuts/modes and actual active bindings consistent. Add/edit/remove/reset and restart must retain each shortcut's intended mode, without attaching a removed row's override to another row.
- Preserve existing stored ordinary shortcut lists as Use app setting; do not pin them based on today's global preference.
- No import of the earlier beta raw/cleaned configuration is required, per Ben's newer explicit correction. Remove obsolete runtime registrations and UI paths; do not delete or reset an existing profile. Handle missing, stale or malformed new per-row metadata defensively.
- Cleaned mode uses the configured provider/model and existing clear unavailable/error handling; never silently claim cleanup succeeded when it did not.
- Preserve recording cancellation, Voice Assistant/wake-word routing, translation, meetings and regular button/tray-started dictation. Avoid unrelated architecture changes.
- Localize new/changed strings in all repository locales (11 at the previous baseline); follow current localization checks. Keep keyboard navigation, accessible labels, focus and disclosure state correct.

## Implementation process and review

Start with a concise plan based on current code: storage/backward compatibility for ordinary lists, registration routing, activation-mode support, settings UI and regression tests. Jarvis will review the plan before implementation; routine choices do not require Ben to repeat his approval.

Likely starting points: `src/components/SettingsPage.tsx`, `src/components/ui/HotkeyListInput.tsx`, `HotkeyInput.tsx`, settings store/persistence, hotkey manager/native listener registrations, IPC/preload/window callbacks, recording hooks, audio manager and route helpers. Inspect actual files rather than relying on old line numbers.

Implementation owner works only in `repo/` and pushes the feature branch to the fork. Independent reviewer/build owner works in `validation-repo/`, reviews exact pushed feature commits and owns test-only packaging. Do not edit each other's checkout or push each other's branch. Reviewer sends concrete source defects to the implementation owner. Jarvis does not implement application code.

## Verification

Use Node 24 per `.nvmrc`. Run focused tests for per-shortcut modes, ordinary-list compatibility/restart, conflicts/rollback, add/edit/remove/reset, global-setting changes, cancellation/overlap, activation modes and routing regressions. Retain existing meaningful pipeline tests. Run supported lint, typecheck, formatting, localization, renderer build and full test suite. Preserve native SQLite ABI handling from the previous validated workflow; never mask failing exit codes with pipes. Report pre-existing failures and skipped tests explicitly.

Produce actual rendered settings evidence with synthetic data: beginner/collapsed state, Ben's configured two-row state, dropdown open, relevant validation/error state. The concept image is not evidence of implementation. Prefer real application/component screenshots over hand-built facsimiles. Include compact controls and no secrets or user transcripts.

Previous build: 7,884 passed, zero failures, 35 skipped, one todo (7,920 total). These are historical numbers, not a substitute for testing this revision.

## New Windows candidate

Reuse the reviewed fork-only native Windows Actions build and its isolated unpacked unsigned distribution/launchers. Update pins, content checks, manifests and checklist for this new design. Keep all packaging-only changes out of the upstream feature diff.

The previous isolation protections must remain: separate profile from production, automatic updates disabled even if the EXE is opened directly, no production install overwrite, no production autostart/protocol/CLI-bridge mutation, protected shared model assets and separate mutable indexes. See `REVIEW_AND_BUILD_HANDOFF.md` in the prior validation evidence for the complete policy and checks. Do not package real `.env`, credentials, settings, history or transcripts.

Ben should only need to download, extract and run a safe launcher; no Node/npm/git/build tools. An unused isolated revision profile is permitted by Ben's migration correction. Do not wipe or mutate his prior test or production profile; state any one-time profile steps explicitly.

Build only after the exact feature candidate has passed review/checks. Verify the downloaded artifact's digest, inner ZIP/EXE hashes, exact feature and validation pins, packaged UI/logic content and static isolation checks. Keep evidence separate from real Windows/OpenAI acceptance.

Deliver the new URL, expiration, exact SHAs, concise setup and acceptance checklist: both fixed bindings with global cleanup ON then OFF; Use app setting behavior; unchanged global preference; persistence/restart; key changes/conflicts; cancellation; existing recording modes. Ben uses his actual OpenAI STT and cleanup configuration, entered only through the app's masked field. No credentials in chat or logs.

No upstream PR (including draft), merge, release publication or production configuration changes. Ben must accept the revised exact Windows candidate before Jarvis opens a PR.
