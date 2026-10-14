const test = require("node:test");
const assert = require("node:assert/strict");

const registered = new Map();
require.cache[require.resolve("electron")] = {
  exports: {
    globalShortcut: {
      register(accelerator, callback) {
        if (registered.has(accelerator)) return false;
        registered.set(accelerator, callback);
        return true;
      },
      unregister(accelerator) {
        registered.delete(accelerator);
      },
      isRegistered(accelerator) {
        return registered.has(accelerator);
      },
      unregisterAll() {
        registered.clear();
      },
    },
    BrowserWindow: class {},
  },
};

const HotkeyManager = require("../../src/helpers/hotkeyManager.js");

// The raw and cleaned dictation hotkeys are two more named slots, so they must
// reach every hotkey backend the existing tap-only slots reach.
const CLEANUP_MODE_SLOTS = ["rawDictation", "cleanedDictation"];

// Same shape as nativeListenerKeys.test.js: explicit slots, so the assertions
// hold on every platform.
const makeManager = (slots) => {
  const mgr = new HotkeyManager();
  mgr.slots.clear();
  for (const [name, value] of Object.entries(slots)) {
    const hotkeys = Array.isArray(value) ? value : value ? [value] : [];
    mgr.slots.set(name, { hotkeys, callback: null, accelerators: [] });
  }
  return mgr;
};

test("a conflict with a cleanup-mode slot names it as Settings does", () => {
  const mgr = makeManager({
    dictation: "F8",
    rawDictation: "Control+Shift+R",
    cleanedDictation: "Control+Shift+C",
  });

  const rawConflict = mgr._findSlotConflict("dictation", "Control+Shift+R");
  assert.equal(rawConflict?.reason, "slot_conflict");
  assert.equal(rawConflict?.conflictSlot, "rawDictation");
  assert.equal(rawConflict?.error, "This hotkey is already used for Raw Dictation Hotkey.");

  const cleanedConflict = mgr._findSlotConflict("voiceAgent", "Control+Shift+C");
  assert.equal(cleanedConflict?.conflictSlot, "cleanedDictation");
  assert.equal(cleanedConflict?.error, "This hotkey is already used for Cleaned Dictation Hotkey.");
});

test("the cleanup-mode slots are conflict-checked against every other slot", () => {
  const mgr = makeManager({
    dictation: "F8",
    meeting: "F9",
    voiceAgent: "F10",
    translation: "F11",
    rawDictation: "F12",
    cleanedDictation: "Pause",
  });

  for (const slot of CLEANUP_MODE_SLOTS) {
    for (const [other, hotkey] of [
      ["dictation", "F8"],
      ["meeting", "F9"],
      ["voiceAgent", "F10"],
      ["translation", "F11"],
    ]) {
      assert.equal(mgr._findSlotConflict(slot, hotkey)?.conflictSlot, other, `${slot} vs ${other}`);
    }
    // Its own hotkey is not a conflict, and a free key is fine.
    assert.equal(mgr._findSlotConflict(slot, mgr.getSlotHotkey(slot)), null);
    assert.equal(mgr._findSlotConflict(slot, "ScrollLock"), null);
  }
  // The two new slots conflict with each other too.
  assert.equal(mgr._findSlotConflict("rawDictation", "Pause")?.conflictSlot, "cleanedDictation");
  assert.equal(mgr._findSlotConflict("cleanedDictation", "F12")?.conflictSlot, "rawDictation");
});

// Only dictation holds to speak; the cleanup-mode slots are tap-to-toggle, so
// push mode must not put their keys on the native listener.
test("the cleanup-mode slots are never push-enabled", () => {
  const mgr = makeManager({
    dictation: "F8",
    rawDictation: "F12",
    cleanedDictation: "Pause",
  });
  assert.deepEqual(mgr.getNativeListenerKeys("push"), ["F8"]);
  assert.deepEqual(mgr.getNativeListenerKeys("tap"), []);
});

test("modifier-only and right-side cleanup-mode hotkeys use the native listener", () => {
  const mgr = makeManager({
    rawDictation: "Control+Alt",
    cleanedDictation: "RightControl",
  });
  assert.deepEqual(mgr.getNativeListenerKeys("tap").sort(), ["Control+Alt", "RightControl"]);
});

test("the cleanup-mode slots reach the macOS native listener config", () => {
  const macSlots = ["dictation", "voiceAgent", "translation", ...CLEANUP_MODE_SLOTS];
  for (const slot of CLEANUP_MODE_SLOTS) {
    assert.equal(
      makeManager({ [slot]: "GLOBE" }).getMacNativeListenerConfig(macSlots).suppressGlobeAction,
      true,
      `slot "${slot}" should request Globe suppression`
    );
    assert.deepEqual(
      makeManager({ [slot]: "MouseButton5" }).getMacNativeListenerConfig(macSlots).mouseButtons,
      ["MouseButton5"],
      `slot "${slot}" should claim its mouse button`
    );
  }
});

// On GNOME a slot that is not routed natively falls through to globalShortcut,
// which cannot see these keys under Wayland. Each slot must also carry its own
// gsettings entry and its own D-Bus callback, or two slots would share one.
test("GNOME registers each cleanup-mode slot natively, by name", async (t) => {
  for (const slot of CLEANUP_MODE_SLOTS) {
    await t.test(slot, async () => {
      registered.clear();
      const calls = [];
      const callbacks = {};
      const mgr = new HotkeyManager();
      mgr.useGnome = true;
      mgr.gnomeManager = {
        async registerKeybinding(shortcut, slotName) {
          calls.push({ shortcut, slotName });
          return true;
        },
        async unregisterKeybinding() {},
        setMeetingCallback: (cb) => (callbacks.meeting = cb),
        setVoiceAgentCallback: (cb) => (callbacks.voiceAgent = cb),
        setTranslationCallback: (cb) => (callbacks.translation = cb),
        setRawDictationCallback: (cb) => (callbacks.rawDictation = cb),
        setCleanedDictationCallback: (cb) => (callbacks.cleanedDictation = cb),
      };

      const callback = () => {};
      const result = await mgr.registerSlot(slot, "Control+Shift+F7", callback);

      assert.equal(result.success, true);
      assert.deepEqual(calls, [{ shortcut: "<Control><Shift>F7", slotName: slot }]);
      assert.equal(callbacks[slot], callback, "the slot's own GNOME callback must be set");
      assert.deepEqual(Object.keys(callbacks), [slot], "no other slot's callback may be touched");
      assert.equal(registered.size, 0, "GNOME slots never go through globalShortcut");
      assert.deepEqual(mgr.getSlotHotkeys(slot), ["Control+Shift+F7"]);
    });
  }
});

// KDE routes every persistent slot through KGlobalAccel generically (the slot
// name is the action id and the callback is passed in), so the new slots need
// no per-slot map there — but they must still reach it rather than
// globalShortcut, and they must never be registered as push-to-talk.
test("KDE registers each cleanup-mode slot natively, never as push-to-talk", async (t) => {
  for (const slot of CLEANUP_MODE_SLOTS) {
    await t.test(slot, async () => {
      registered.clear();
      const calls = [];
      const mgr = new HotkeyManager();
      mgr.useKDE = true;
      mgr.activationMode = "push";
      mgr.kdeManager = {
        async registerKeybinding(hotkey, slotName, callback, isPushToTalk) {
          calls.push({ hotkey, slotName, callback, isPushToTalk });
          return true;
        },
        unregisterKeybinding() {
          return Promise.resolve();
        },
      };
      const callback = () => {};

      const result = await mgr.registerSlot(slot, "Control+Shift+F7", callback);

      assert.equal(result.success, true);
      assert.deepEqual(
        calls.map(({ hotkey, slotName, isPushToTalk }) => ({ hotkey, slotName, isPushToTalk })),
        [{ hotkey: "Control+Shift+F7", slotName: slot, isPushToTalk: false }]
      );
      assert.equal(calls[0].callback, callback);
      assert.equal(registered.size, 0, "KDE slots never go through globalShortcut");
      assert.deepEqual(mgr.getSlotHotkeys(slot), ["Control+Shift+F7"]);
    });
  }
});

// The real GNOME manager must know both slots: an unknown one throws before it
// touches gsettings, so a missing SLOT_CONFIG entry is caught here.
test("the real GNOME manager resolves a keybinding path for each cleanup-mode slot", async () => {
  const GnomeShortcutManager = require("../../src/helpers/gnomeShortcut.js");
  const manager = new GnomeShortcutManager();
  let reads = 0;
  // Stops the call before any gsettings write; the slot lookup has already run.
  manager.getExistingKeybindings = () => {
    reads += 1;
    throw new Error("probe");
  };

  for (const slot of CLEANUP_MODE_SLOTS) {
    reads = 0;
    await manager.unregisterKeybinding(slot);
    assert.equal(reads, 1, `${slot} must resolve to a gsettings path`);
  }
  reads = 0;
  await assert.rejects(manager.unregisterKeybinding("nope"), /Unknown slot/);
  assert.equal(reads, 0);
});

test("each cleanup-mode slot gets its own GNOME D-Bus callback", () => {
  const GnomeShortcutManager = require("../../src/helpers/gnomeShortcut.js");
  const manager = new GnomeShortcutManager();
  const raw = () => {};
  const cleaned = () => {};

  manager.setRawDictationCallback(raw);
  manager.setCleanedDictationCallback(cleaned);

  assert.equal(manager.rawDictationCallback, raw);
  assert.equal(manager.cleanedDictationCallback, cleaned);
  // The slots that existed before must not have been reused for either.
  assert.equal(manager.dictationCallback, null);
  assert.equal(manager.translationCallback, null);
  assert.equal(manager.voiceAgentCallback, null);
  assert.equal(manager.meetingCallback, null);
});

// Hyprland binds through one D-Bus method per slot, looked up before it reads
// the compositor config; an unknown slot never gets that far.
test("Hyprland knows a toggle method for each cleanup-mode slot", async (t) => {
  const HyprlandShortcutManager = require("../../src/helpers/hyprlandShortcut.js");
  const manager = new HyprlandShortcutManager();
  let configReads = 0;
  manager._getConfig = () => {
    configReads += 1;
    throw new Error("probe");
  };
  const originalIsHyprland = HyprlandShortcutManager.isHyprland;
  HyprlandShortcutManager.isHyprland = () => true;
  t.after(() => {
    HyprlandShortcutManager.isHyprland = originalIsHyprland;
  });

  for (const slot of CLEANUP_MODE_SLOTS) {
    configReads = 0;
    assert.equal(await manager.registerSlotKeybinding("Control+Shift+F7", slot, () => {}), false);
    assert.equal(configReads, 1, `${slot} must have a Hyprland toggle method`);
  }
  configReads = 0;
  assert.equal(await manager.registerSlotKeybinding("Control+Shift+F7", "nope", () => {}), false);
  assert.equal(configReads, 0, "an unknown slot is refused at the method lookup");
});

// hotkeyManager must route the slots to Hyprland rather than globalShortcut,
// which cannot see them under Wayland.
const hyprlandTest = process.platform === "linux" ? test : test.skip;
hyprlandTest("Hyprland registers each cleanup-mode slot natively, by name", async (t) => {
  for (const slot of CLEANUP_MODE_SLOTS) {
    await t.test(slot, async () => {
      registered.clear();
      const calls = [];
      const mgr = new HotkeyManager();
      mgr.useHyprland = true;
      mgr.hyprlandManager = {
        async registerSlotKeybinding(hotkey, slotName, callback) {
          calls.push({ hotkey, slotName, callback });
          return true;
        },
        async unregisterKeybinding() {},
      };
      const callback = () => {};

      const result = await mgr.registerSlot(slot, "Control+Shift+F7", callback);

      assert.equal(result.success, true);
      assert.deepEqual(
        calls.map(({ hotkey, slotName }) => ({ hotkey, slotName })),
        [{ hotkey: "Control+Shift+F7", slotName: slot }]
      );
      assert.equal(calls[0].callback, callback);
      assert.equal(registered.size, 0, "Hyprland slots never go through globalShortcut");
      assert.deepEqual(mgr.getSlotHotkeys(slot), ["Control+Shift+F7"]);
    });
  }
});
