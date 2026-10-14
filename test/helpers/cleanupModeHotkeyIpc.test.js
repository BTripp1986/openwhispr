const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");
const Module = require("node:module");

// A typo in one of these channel names only shows up when a user presses the
// key on a real desktop, so pin both halves: what WindowManager pushes and what
// preload listens for, plus the invoke channels the Settings rows call.

const CLEANUP_MODE_CHANNELS = [
  {
    mode: "raw",
    send: "sendToggleRawDictation",
    toggleChannel: "toggle-raw-dictation",
    listener: "onToggleRawDictation",
    update: "updateRawDictationHotkey",
    updateChannel: "update-raw-dictation-hotkey",
    read: "getRawDictationKey",
    readChannel: "get-raw-dictation-key",
  },
  {
    mode: "cleaned",
    send: "sendToggleCleanedDictation",
    toggleChannel: "toggle-cleaned-dictation",
    listener: "onToggleCleanedDictation",
    update: "updateCleanedDictationHotkey",
    updateChannel: "update-cleaned-dictation-hotkey",
    read: "getCleanedDictationKey",
    readChannel: "get-cleaned-dictation-key",
  },
];

// WindowManager pulls in electron and its sibling managers at require time;
// only the pieces the dictation toggle touches need to behave.
const originalLoad = Module._load;
Module._load = function loadWindowManagerWithStubs(request, parent, isMain) {
  if (request === "electron") {
    return {
      app: { on: () => undefined },
      screen: { on: () => undefined, getPrimaryDisplay: () => ({}) },
      BrowserWindow: class {},
      Menu: {},
      shell: {},
      dialog: {},
    };
  }
  if (request === "./debugLogger") {
    return { warn: () => undefined, debug: () => undefined, log: () => undefined };
  }
  if (request === "./hotkeyManager") {
    const FakeHotkeyManager = class {};
    FakeHotkeyManager.isGlobeLikeHotkey = () => false;
    return FakeHotkeyManager;
  }
  if (request === "./dragManager") return class {};
  if (request === "./menuManager") return {};
  if (request === "./devServerManager") {
    return {
      DEV_SERVER_PORT: 5173,
      DEV_SERVER_URL: "http://localhost:5173",
      getAppFilePath: () => ({ path: "/app/index.html", query: {} }),
      waitForDevServer: async () => undefined,
    };
  }
  if (request === "./dockManager") return {};
  if (request === "./i18nMain") return { i18nMain: { t: (key) => key } };
  if (request === "./windowConfig") {
    return {
      MAIN_WINDOW_CONFIG: {},
      CONTROL_PANEL_CONFIG: {},
      NOTIFICATION_WINDOW_CONFIG: {},
      WINDOW_SIZES: { BASE: { width: 96, height: 96 } },
      ONBOARDING_WINDOW_SIZES: { COMPACT: {}, EXPANDED: {} },
      WindowPositionUtil: {
        setupAlwaysOnTop: () => undefined,
        clampToWorkArea: (b) => b,
        getMainWindowPosition: () => ({ x: 0, y: 0 }),
        getNotificationPosition: () => ({ x: 0, y: 0 }),
      },
      fitAssistantWindowToWorkArea: (s) => s,
      fitAssistantContentWindowToWorkArea: (h) => ({ width: 466, height: h }),
      fitDictationErrorWindowToWorkArea: (s) => s,
      fitDictationErrorContentWindowToWorkArea: (h) => ({ width: 466, height: h }),
      resolveHorizontalWindowDirection: () => "right",
    };
  }
  return originalLoad.call(this, request, parent, isMain);
};
const WindowManager = require("../../src/helpers/windowManager");
Module._load = originalLoad;

function makeManager() {
  const sent = [];
  const manager = new WindowManager();
  manager.hotkeyManager = { isInListeningMode: () => false };
  manager.setOnboardingActive(false);
  manager.mainWindow = {
    isDestroyed: () => false,
    webContents: { send: (channel, payload) => sent.push({ channel, payload }) },
  };
  manager.showDictationPanel = () => undefined;
  manager.isDictationProcessing = () => false;
  return { manager, sent, channels: () => sent.map((entry) => entry.channel) };
}

function loadPreloadApi() {
  let exposedApi;
  const listeners = new Map();
  const invocations = [];
  const ipcRenderer = {
    invoke: async (...args) => {
      invocations.push(args);
      return undefined;
    },
    on: (channel, listener) => listeners.set(channel, listener),
    removeListener: (channel, listener) => {
      if (listeners.get(channel) === listener) listeners.delete(channel);
    },
    send: () => undefined,
    sendSync: () => undefined,
  };
  const source = fs.readFileSync(path.join(__dirname, "../../preload.js"), "utf8");
  vm.runInNewContext(source, {
    require: (specifier) => {
      if (specifier === "electron") {
        return {
          contextBridge: {
            exposeInMainWorld: (_name, api) => {
              exposedApi = api;
            },
          },
          ipcRenderer,
          webUtils: {},
        };
      }
      throw new Error(`Unexpected preload dependency: ${specifier}`);
    },
    process,
  });
  return { api: exposedApi, listeners, invocations };
}

test("each cleanup-mode hotkey pushes the channel its preload listener subscribes to", () => {
  const { api, listeners } = loadPreloadApi();

  for (const entry of CLEANUP_MODE_CHANNELS) {
    const { manager, channels } = makeManager();

    manager[entry.send]();

    // Pre-warms the mic one message ahead of the toggle, like every other
    // dictation hotkey.
    assert.deepEqual(
      channels(),
      ["prepare-dictation", entry.toggleChannel],
      `${entry.mode} must push ${entry.toggleChannel}`
    );

    const received = [];
    const dispose = api[entry.listener]((...args) => received.push(args));
    const listener = listeners.get(entry.toggleChannel);
    assert.ok(listener, `preload must subscribe to ${entry.toggleChannel}`);
    // The Electron event object must not reach the renderer callback.
    listener({ sender: "electron-event" });
    assert.deepEqual(received, [[]]);
    dispose();
    assert.equal(listeners.has(entry.toggleChannel), false, "the listener must be removable");
  }
});

test("the prepare message reports an ordinary dictation, not a new input kind", () => {
  for (const entry of CLEANUP_MODE_CHANNELS) {
    const { manager, sent } = makeManager();
    manager[entry.send]();
    assert.deepEqual(sent[0], {
      channel: "prepare-dictation",
      payload: { inputKind: "dictation" },
    });
  }
});

test("the Settings rows invoke the hotkey channels the main process handles", async () => {
  const { api, invocations } = loadPreloadApi();

  for (const entry of CLEANUP_MODE_CHANNELS) {
    invocations.length = 0;
    await api[entry.update]("Control+Shift+F7");
    assert.deepEqual(invocations, [[entry.updateChannel, "Control+Shift+F7"]]);

    invocations.length = 0;
    await api[entry.read]();
    assert.deepEqual(invocations, [[entry.readChannel]]);
  }
});

// The handlers are registered from a list; a missing entry would leave the
// Settings row invoking a channel nobody answers.
test("the main process registers a handler for every cleanup-mode channel", () => {
  const source = fs.readFileSync(path.join(__dirname, "../../src/helpers/ipcHandlers.js"), "utf8");
  for (const entry of CLEANUP_MODE_CHANNELS) {
    assert.match(source, new RegExp(`"${entry.updateChannel}"`), entry.updateChannel);
    assert.match(source, new RegExp(`"${entry.readChannel}"`), entry.readChannel);
  }
});
