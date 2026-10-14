const test = require("node:test");
const assert = require("node:assert/strict");
const path = require("node:path");
const { createRendererServer, installBrowserGlobals } = require("../lib/rendererTestHarness");

async function loadStore(t, electronAPI) {
  installBrowserGlobals(t, {
    initialStorage: {
      voiceAgentKey: "F9",
      translationKey: "F10",
      rawDictationKey: "F11",
      cleanedDictationKey: "F12",
    },
    window: { electronAPI },
  });
  const vite = await createRendererServer(t, {
    cachePrefix: "openwhispr-registered-hotkey-setter-test-",
    resolveAlias: { "@": path.resolve(__dirname, "../../src") },
  });
  return vite.ssrLoadModule("/stores/settingsStore.ts");
}

// Settings and onboarding show main's reason for a refused Voice Assistant or
// Translation hotkey (e.g. a missing Windows key listener), not a generic retry.
test("a refused assistant or translation hotkey reports main's reason and keeps the old key", async (t) => {
  const reason = '"Control+Super" needs the Windows key listener.';
  const { useSettingsStore } = await loadStore(t, {
    updateVoiceAgentHotkey: async () => ({ success: false, message: reason }),
    updateTranslationHotkey: async () => ({ success: false }),
  });
  const store = useSettingsStore.getState();

  assert.deepEqual(await store.setVoiceAgentKey("Control+Super"), {
    success: false,
    message: reason,
  });
  assert.deepEqual(await store.setTranslationKey("RightControl"), {
    success: false,
    message: undefined,
  });
  assert.equal(useSettingsStore.getState().voiceAgentKey, "F9");
  assert.equal(useSettingsStore.getState().translationKey, "F10");
});

test("an accepted assistant hotkey is saved", async (t) => {
  const { useSettingsStore } = await loadStore(t, {
    updateVoiceAgentHotkey: async () => ({ success: true }),
  });

  assert.deepEqual(await useSettingsStore.getState().setVoiceAgentKey("Alt+Space"), {
    success: true,
  });
  assert.equal(useSettingsStore.getState().voiceAgentKey, "Alt+Space");
  assert.equal(globalThis.localStorage.getItem("voiceAgentKey"), "Alt+Space");
});

// The raw and cleaned dictation hotkeys go through the same setter, so a
// refusal must roll the stored key back rather than leave Settings showing a
// shortcut main never registered.
test("a refused raw or cleaned dictation hotkey keeps the old key", async (t) => {
  const reason = '"Control+Super" needs the Windows key listener.';
  const { useSettingsStore } = await loadStore(t, {
    updateRawDictationHotkey: async () => ({ success: false, message: reason }),
    updateCleanedDictationHotkey: async () => ({ success: false }),
  });
  const store = useSettingsStore.getState();

  assert.deepEqual(await store.setRawDictationKey("Control+Super"), {
    success: false,
    message: reason,
  });
  assert.deepEqual(await store.setCleanedDictationKey("RightControl"), {
    success: false,
    message: undefined,
  });
  assert.equal(useSettingsStore.getState().rawDictationKey, "F11");
  assert.equal(useSettingsStore.getState().cleanedDictationKey, "F12");
  assert.equal(globalThis.localStorage.getItem("rawDictationKey"), "F11");
  assert.equal(globalThis.localStorage.getItem("cleanedDictationKey"), "F12");
});

test("accepted raw and cleaned dictation hotkeys are saved and clearable", async (t) => {
  const { useSettingsStore } = await loadStore(t, {
    updateRawDictationHotkey: async () => ({ success: true }),
    updateCleanedDictationHotkey: async () => ({ success: true }),
  });

  assert.deepEqual(await useSettingsStore.getState().setRawDictationKey("Alt+R"), {
    success: true,
  });
  assert.equal(useSettingsStore.getState().rawDictationKey, "Alt+R");
  assert.equal(globalThis.localStorage.getItem("rawDictationKey"), "Alt+R");

  assert.deepEqual(await useSettingsStore.getState().setCleanedDictationKey(""), {
    success: true,
  });
  assert.equal(useSettingsStore.getState().cleanedDictationKey, "");
  assert.equal(globalThis.localStorage.getItem("cleanedDictationKey"), "");
});
