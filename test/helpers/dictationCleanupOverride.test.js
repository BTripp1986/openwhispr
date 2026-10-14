const test = require("node:test");
const assert = require("node:assert/strict");

const load = () => import("../../src/helpers/dictationRouting.js");

// The raw and cleaned dictation hotkeys replace the global cleanup preference
// for one recording and nothing else — they never make an unconfigured cleanup
// reachable, and they never write the preference.

test("no override follows the global cleanup preference", async () => {
  const { resolveCleanupSelection } = await load();

  assert.deepEqual(
    resolveCleanupSelection({
      cleanupOverride: null,
      useCleanupPreference: true,
      cleanupConfigured: true,
    }),
    { selected: true, reachable: true, unavailable: false }
  );
  assert.deepEqual(
    resolveCleanupSelection({
      cleanupOverride: null,
      useCleanupPreference: false,
      cleanupConfigured: true,
    }),
    { selected: false, reachable: false, unavailable: false }
  );
});

test("raw skips cleanup whether the preference is on or off", async () => {
  const { resolveCleanupSelection } = await load();

  for (const useCleanupPreference of [true, false]) {
    assert.deepEqual(
      resolveCleanupSelection({
        cleanupOverride: "raw",
        useCleanupPreference,
        cleanupConfigured: true,
      }),
      { selected: false, reachable: false, unavailable: false },
      `preference ${useCleanupPreference}`
    );
  }
});

test("cleaned runs cleanup whether the preference is on or off", async () => {
  const { resolveCleanupSelection } = await load();

  for (const useCleanupPreference of [true, false]) {
    assert.deepEqual(
      resolveCleanupSelection({
        cleanupOverride: "cleaned",
        useCleanupPreference,
        cleanupConfigured: true,
      }),
      { selected: true, reachable: true, unavailable: false },
      `preference ${useCleanupPreference}`
    );
  }
});

// The cleaned hotkey cannot manufacture missing configuration: it reports the
// gap so the transcript can still paste without passing as cleaned.
test("cleaned with no cleanup model configured is unreachable and reported", async () => {
  const { resolveCleanupSelection } = await load();

  assert.deepEqual(
    resolveCleanupSelection({
      cleanupOverride: "cleaned",
      useCleanupPreference: false,
      cleanupConfigured: false,
    }),
    { selected: true, reachable: false, unavailable: true }
  );
});

// Raw asked for no cleanup, so an unconfigured model is not a problem to report.
test("raw and the plain preference never report cleanup as unavailable", async () => {
  const { resolveCleanupSelection } = await load();

  assert.equal(
    resolveCleanupSelection({
      cleanupOverride: "raw",
      useCleanupPreference: true,
      cleanupConfigured: false,
    }).unavailable,
    false
  );
  assert.equal(
    resolveCleanupSelection({
      cleanupOverride: null,
      useCleanupPreference: true,
      cleanupConfigured: false,
    }).unavailable,
    false
  );
});

test("an unknown override value falls back to the preference", async () => {
  const { resolveCleanupSelection, isExplicitCleanupMode } = await load();

  assert.equal(
    resolveCleanupSelection({
      cleanupOverride: "sparkling",
      useCleanupPreference: true,
      cleanupConfigured: true,
    }).selected,
    true
  );
  assert.equal(isExplicitCleanupMode("sparkling"), false);
  assert.equal(isExplicitCleanupMode(null), false);
  assert.equal(isExplicitCleanupMode("raw"), true);
  assert.equal(isExplicitCleanupMode("cleaned"), true);
});

test("raw routes to skip and cleaned to cleanup", async () => {
  const { resolveDictationRouteKind } = await load();

  assert.equal(
    resolveDictationRouteKind({
      cleanupReachable: false,
      agentReachable: false,
      agentInvoked: false,
      cleanupOverride: "raw",
    }),
    "skip"
  );
  assert.equal(
    resolveDictationRouteKind({
      cleanupReachable: true,
      agentReachable: false,
      agentInvoked: false,
      cleanupOverride: "cleaned",
    }),
    "cleanup"
  );
});

// Explicit raw/cleaned dictation stays dictation even when the transcript
// happens to contain the wake phrase.
test("an explicit mode never takes the wake-word agent route", async () => {
  const { resolveDictationRouteKind } = await load();

  assert.equal(
    resolveDictationRouteKind({
      cleanupReachable: false,
      agentReachable: true,
      agentInvoked: true,
      cleanupOverride: "raw",
    }),
    "skip"
  );
  assert.equal(
    resolveDictationRouteKind({
      cleanupReachable: true,
      agentReachable: true,
      agentInvoked: true,
      cleanupOverride: "cleaned",
    }),
    "cleanup"
  );
});

// A cleaned recording whose configured model is unreachable pastes the raw
// transcript rather than silently borrowing the dictation agent.
test("cleaned with an unreachable cleanup model skips rather than falling back", async () => {
  const { resolveDictationRouteKind } = await load();

  assert.equal(
    resolveDictationRouteKind({
      cleanupReachable: false,
      agentReachable: true,
      agentInvoked: false,
      cleanupOverride: "cleaned",
    }),
    "skip"
  );
});

// Neither hotkey can start an assistant or translation recording, but the
// precedence is pinned so a stale flag can never be resolved by the override.
test("the voice assistant and translation requests still outrank an override", async () => {
  const { resolveDictationRouteKind } = await load();

  assert.equal(
    resolveDictationRouteKind({
      cleanupReachable: false,
      agentReachable: false,
      agentInvoked: false,
      voiceAgentRequested: true,
      cleanupOverride: "raw",
    }),
    "agent"
  );
  assert.equal(
    resolveDictationRouteKind({
      cleanupReachable: false,
      agentReachable: false,
      agentInvoked: false,
      translationRequested: true,
      translationReachable: true,
      cleanupOverride: "raw",
    }),
    "translation"
  );
});

// Default dictation must behave exactly as it did before the overrides existed.
test("without an override the existing priority order is unchanged", async () => {
  const { resolveDictationRouteKind } = await load();

  assert.equal(
    resolveDictationRouteKind({
      cleanupReachable: true,
      agentReachable: true,
      agentInvoked: true,
    }),
    "agent"
  );
  assert.equal(
    resolveDictationRouteKind({
      cleanupReachable: true,
      agentReachable: true,
      agentInvoked: false,
    }),
    "cleanup"
  );
  assert.equal(
    resolveDictationRouteKind({
      cleanupReachable: false,
      agentReachable: false,
      agentInvoked: false,
    }),
    "skip"
  );
});
