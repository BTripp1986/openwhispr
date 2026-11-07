// Rendered UI evidence for the per-shortcut cleanup revision.
//
// This mounts the REAL production component — `SettingsPage activeSection="hotkeys"`
// — in a real Chrome, over a Vite dev server, with a synthetic window.electronAPI
// and seeded localStorage. No app, no credentials, no user data, no app settings
// touched. Nothing here duplicates the feature's JSX: every pixel comes from
// src/components/SettingsPage.tsx, src/components/ui/HotkeyListInput.tsx and
// src/components/settings/DictationCleanupControl.tsx.
//
// Interactions are driven as real input through CDP (Input.dispatchMouseEvent at
// the element's own coordinates), so the disclosure and the Radix Select open the
// way they do for a user; no menu is faked open.
//
// Usage: node render-dictation-ui-evidence.js <out-dir>

const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { spawn } = require("node:child_process");
const WebSocket = require(
  path.join(
    "/home/ec2-user/.openclaw/workspace/work/openwhispr-contribution/repo",
    "node_modules/ws",
  ),
);

const REPO =
  "/home/ec2-user/.openclaw/workspace/work/openwhispr-contribution/repo";
const OUT = process.argv[2];
if (!OUT)
  throw new Error("usage: node render-dictation-ui-evidence.js <out-dir>");
const CHROME = "/usr/bin/google-chrome";

// The built stylesheet this page injects points at the fingerprinted files
// beside it. Served from the build output, or the dev server answers its SPA
// fallback and the browser decodes HTML as a font ("invalid sfntVersion
// 1008813135" is "<!DO" read as a number).
const ASSET_TYPES = {
  ".woff2": "font/woff2",
  ".woff": "font/woff",
  ".ttf": "font/ttf",
  ".otf": "font/otf",
  ".png": "image/png",
  ".webp": "image/webp",
  ".svg": "image/svg+xml",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".gif": "image/gif",
};

// ---------------------------------------------------------------- harness page

// Runs before the store modules load, so the seeded rows are what the store
// reads at init and every IPC the page makes has an answer.
const SETUP = `
const answers = {
  // SYNCHRONOUS, like the real bridge: getPlatform() is read inline by
  // utils/platform.ts and cached. A promise here reads as "not a platform" and
  // the page silently falls back to the Linux user agent, which is not the
  // platform this candidate is reviewed on.
  getPlatform: () => "win32",
  getHotkeyModeInfo: async () => ({
    isUsingGnome: false,
    isUsingHyprland: false,
    isUsingKDE: false,
    isUsingNativeShortcut: false,
    supportsPushToTalk: true,
    pushToTalkUnavailableReason: null,
    blockingHotkey: null,
    linuxInputAccessDenied: false,
  }),
  getHyprlandConfigStatus: async () => null,
  setHotkeyListeningMode: async () => ({ success: true }),
  getDefaultHotkey: async () => "Control+Super",
  getEffectiveDefaultHotkey: async () => "Control+Super",
  getActivationMode: async () => "tap",
  getDictationHotkeyConfig: async () => ({ rows: window.__evidence.rows }),
  applyDictationHotkeys: async (request) => window.__evidence.apply(request),
};

window.__evidenceUnanswered = new Set();
window.__evidence = {
  rows: JSON.parse(document.documentElement.dataset.rows || "[]"),
  // Replaced per screenshot: the commit outcome is the only thing a scenario
  // changes about main.
  apply: (request) => ({ success: true, rows: request.rows }),
};

localStorage.clear();
localStorage.setItem("dictationHotkeyConfig", JSON.stringify(window.__evidence.rows));
localStorage.setItem(
  "dictationKey",
  window.__evidence.rows.map((row) => row.key).join(",")
);
localStorage.setItem("hasCompletedOnboarding", "true");
localStorage.setItem("activationMode", "tap");

// Anything the page asks for that this harness has no opinion about answers
// undefined; listeners hand back an unsubscribe. The point is to exercise the
// real component, not to simulate the whole main process.
window.electronAPI = new Proxy(answers, {
  get(target, property) {
    if (property in target) return target[property];
    if (typeof property === "string" && property.startsWith("on")) {
      return () => () => {};
    }
    window.__evidenceUnanswered.add(String(property));
    // A key reader answers with the empty string (the page splits those into
    // hotkey lists); everything else answers with an empty object, because the
    // page reads fields off most answers and "nothing" must not throw.
    if (/^get.*(Key|Hotkey)$/.test(String(property))) return async () => "";
    return async () => ({});
  },
  has: () => true,
});
export default true;
`;

const ENTRY = `
import "/__evidenceSetup";
import React from "react";
import ReactDOM from "react-dom/client";
import { I18nextProvider } from "react-i18next";
import i18n from "/i18n";
import { ToastProvider } from "/components/ui/Toast.tsx";
import { SettingsProvider } from "/hooks/useSettings";
import SettingsPage from "/components/SettingsPage.tsx";

const locale = document.documentElement.lang || "en";
await i18n.changeLanguage(locale);

ReactDOM.createRoot(document.getElementById("root")).render(
  React.createElement(
    I18nextProvider,
    { i18n },
    React.createElement(
      SettingsProvider,
      null,
      React.createElement(
        ToastProvider,
        null,
        // The production component, with the section under review selected.
        React.createElement(SettingsPage, { activeSection: "hotkeys" })
      )
    )
  )
);
window.__evidenceMounted = true;
`;

function page({ locale, rows, css }) {
  return `<!doctype html>
<html lang="${locale}" data-theme="light" data-rows='${JSON.stringify(rows)}'>
<head><meta charset="utf-8"><title>dictation hotkey evidence</title>
<style>${css}</style>
<style>
  body { margin: 0; background: #f6f6f7; }
  #shell { width: 760px; padding: 28px; }
</style>
</head>
<body><div id="shell"><div id="root"></div></div>
<script type="module" src="/__evidenceEntry"></script>
</body></html>`;
}

// ------------------------------------------------------------------ CDP client

class Cdp {
  constructor(socket) {
    this.socket = socket;
    this.nextId = 1;
    this.pending = new Map();
    this.sessionId = null;
    // A screenshot of a page that threw is not evidence of anything.
    this.pageExceptions = [];
    // Browser-level failures (a module the dev server would not serve, a 500)
    // reach neither of the Runtime channels above.
    this.browserLogs = [];
    socket.on("message", (data) => {
      const message = JSON.parse(data.toString());
      if (message.method === "Runtime.exceptionThrown") {
        const details = message.params?.exceptionDetails;
        const text = details?.exception?.description || details?.text;
        console.error("PAGE EXCEPTION:", text);
        this.pageExceptions.push(text);
      }
      if (
        message.method === "Runtime.consoleAPICalled" &&
        message.params?.type === "error"
      ) {
        console.error(
          "PAGE CONSOLE:",
          message.params.args
            .map((arg) => arg.description || arg.value)
            .join(" "),
        );
      }
      if (message.method === "Log.entryAdded") {
        const log = message.params?.entry || {};
        if (log.level === "error" || log.level === "warning") {
          console.error(
            `PAGE LOG [${log.level}] ${log.source}:`,
            log.text,
            log.url || "",
          );
          if (log.level === "error")
            this.browserLogs.push(`${log.text} ${log.url || ""}`.trim());
        }
      }
      if (message.method === "Network.loadingFailed") {
        console.error(
          "REQUEST FAILED:",
          message.params?.errorText,
          message.params?.requestId,
        );
      }
      if (message.method === "Network.responseReceived") {
        const response = message.params?.response || {};
        if (response.status >= 400) {
          console.error("REQUEST", response.status, response.url);
          this.browserLogs.push(`HTTP ${response.status} ${response.url}`);
        }
      }
      const entry = this.pending.get(message.id);
      if (!entry) return;
      this.pending.delete(message.id);
      if (message.error)
        entry.reject(new Error(`${message.method}: ${message.error.message}`));
      else entry.resolve(message.result);
    });
  }

  send(method, params = {}, useSession = true) {
    const id = this.nextId++;
    const payload = { id, method, params };
    if (useSession && this.sessionId) payload.sessionId = this.sessionId;
    this.socket.send(JSON.stringify(payload));
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject, method });
      setTimeout(() => {
        if (this.pending.delete(id)) reject(new Error(`${method} timed out`));
      }, 30000).unref?.();
    });
  }

  async evaluate(expression) {
    const result = await this.send("Runtime.evaluate", {
      expression,
      awaitPromise: true,
      returnByValue: true,
    });
    if (result.exceptionDetails) {
      throw new Error(
        `evaluate failed: ${result.exceptionDetails.exception?.description || result.exceptionDetails.text}`,
      );
    }
    return result.result.value;
  }

  // A real click at the element's own coordinates, through the browser's input
  // pipeline: Radix opens its Select on pointerdown, so a synthetic
  // element.click() would not be the same interaction.
  async clickSelector(selector, { index = 0 } = {}) {
    const box = await this.evaluate(`(() => {
      const nodes = document.querySelectorAll(${JSON.stringify(selector)});
      const node = nodes[${index}];
      if (!node) return null;
      node.scrollIntoView({ block: "center" });
      const rect = node.getBoundingClientRect();
      return { x: rect.x + rect.width / 2, y: rect.y + rect.height / 2 };
    })()`);
    if (!box) throw new Error(`no element for ${selector}[${index}]`);
    const base = {
      x: box.x,
      y: box.y,
      button: "left",
      clickCount: 1,
      buttons: 1,
    };
    await this.send("Input.dispatchMouseEvent", {
      ...base,
      type: "mouseMoved",
      buttons: 0,
    });
    await this.send("Input.dispatchMouseEvent", {
      ...base,
      type: "mousePressed",
    });
    await this.send("Input.dispatchMouseEvent", {
      ...base,
      type: "mouseReleased",
      buttons: 0,
    });
    await settle(this);
  }

  // Radix opens its Select from the keyboard as well as the pointer, and the
  // keyboard path also demonstrates that the trigger is reachable and named.
  async pressKey(key) {
    const codes = { Enter: 13, ArrowDown: 40, Escape: 27 };
    const base = {
      key,
      code: key,
      windowsVirtualKeyCode: codes[key],
      nativeVirtualKeyCode: codes[key],
    };
    await this.send("Input.dispatchKeyEvent", { ...base, type: "rawKeyDown" });
    await this.send("Input.dispatchKeyEvent", { ...base, type: "keyUp" });
    await settle(this);
  }

  async openSelect(selector, index) {
    await this.clickSelector(selector, { index });
    const opened = await this.evaluate(
      "document.querySelectorAll('[role=\"option\"]').length > 0",
    );
    if (opened) return;
    // The pointer press focused the trigger; Enter is the documented way to
    // open it, and it is how a keyboard user gets there.
    await this.pressKey("Enter");
    const openedByKeyboard = await this.evaluate(
      "document.querySelectorAll('[role=\"option\"]').length > 0",
    );
    if (!openedByKeyboard)
      throw new Error(`the selector at ${selector}[${index}] did not open`);
  }

  async chooseOption(label) {
    const point = await this.evaluate(`(() => {
      const option = [...document.querySelectorAll('[role="option"]')].find((node) =>
        node.textContent.includes(${JSON.stringify(label)})
      );
      if (!option) return null;
      option.scrollIntoView({ block: "center" });
      const rect = option.getBoundingClientRect();
      return { x: rect.x + rect.width / 2, y: rect.y + rect.height / 2 };
    })()`);
    if (!point) {
      const labels = await this.evaluate(
        "JSON.stringify([...document.querySelectorAll('[role=\"option\"]')].map((n) => n.textContent))",
      );
      throw new Error(`no option ${label}: ${labels}`);
    }
    for (const type of ["mouseMoved", "mousePressed", "mouseReleased"]) {
      await this.send("Input.dispatchMouseEvent", {
        type,
        x: point.x,
        y: point.y,
        button: "left",
        clickCount: 1,
        buttons: type === "mousePressed" ? 1 : 0,
      });
    }
    await settle(this, 6);
  }

  async shot(
    file,
    { selector = "#shell", padding = 0, beyondViewport = true, include } = {},
  ) {
    // `include` takes in anything Radix portals outside the group — an open
    // menu is a child of <body>, not of the section it belongs to.
    const clip = await this.evaluate(`(() => {
      const node = document.querySelector(${JSON.stringify(selector)});
      if (!node) return null;
      const rect = node.getBoundingClientRect();
      const box = { left: rect.left, top: rect.top, right: rect.right, bottom: rect.bottom };
      ${
        include
          ? `for (const extra of document.querySelectorAll(${JSON.stringify(include)})) {
        const r = extra.getBoundingClientRect();
        if (r.width === 0 || r.height === 0) continue;
        box.left = Math.min(box.left, r.left);
        box.top = Math.min(box.top, r.top);
        box.right = Math.max(box.right, r.right);
        box.bottom = Math.max(box.bottom, r.bottom);
      }`
          : ""
      }
      return {
        x: Math.max(0, box.left - ${padding}),
        y: Math.max(0, box.top - ${padding}),
        width: box.right - box.left + ${padding * 2},
        height: box.bottom - box.top + ${padding * 2},
      };
    })()`);
    if (!clip) throw new Error(`nothing to capture for ${selector}`);
    // captureBeyondViewport resizes the viewport, and an open Radix popper
    // closes on resize — so a shot of an open menu stays inside the viewport.
    const { data } = await this.send("Page.captureScreenshot", {
      format: "png",
      captureBeyondViewport: beyondViewport,
      clip: { ...clip, scale: 2 },
    });
    fs.writeFileSync(path.join(OUT, file), Buffer.from(data, "base64"));
    console.log("wrote", file);
  }
}

// Readiness and the assertions below read the rendered DOM, never the
// harness's own stubs: a synthetic IPC answer proves nothing about the UI.
const READY_PROBE = `(() => {
  const headings = [...document.querySelectorAll("h3, h2")].map((node) => node.textContent);
  const section = [...document.querySelectorAll("div")].find((node) =>
    node.querySelector("h3")?.textContent === "Dictation Hotkey"
  );
  const rows = section
    ? [...section.querySelectorAll('[aria-label^="Customize cleanup"]')].length
    : 0;
  const visible = section ? section.getBoundingClientRect().height > 40 : false;
  return {
    ready: Boolean(section) && rows > 0 && visible,
    mounted: Boolean(window.__evidenceMounted),
    headings,
    rows,
    visible,
  };
})()`;

const SECTION = "#root div:has(> div > h3)";

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const settle = async (cdp, frames = 3) => {
  for (let i = 0; i < frames; i++) {
    await cdp.evaluate(
      "new Promise((r) => requestAnimationFrame(() => r(true)))",
    );
  }
  await sleep(120);
};

// ------------------------------------------------------------------- the runs

// Pins what these screenshots are OF: the commit, and the exact bytes of the
// files that draw the section under review.
function pinSources() {
  const crypto = require("node:crypto");
  const { execFileSync } = require("node:child_process");
  const head = execFileSync("git", ["rev-parse", "HEAD"], {
    cwd: REPO,
    encoding: "utf8",
  }).trim();
  const dirty = execFileSync("git", ["status", "--porcelain"], {
    cwd: REPO,
    encoding: "utf8",
  }).trim();
  console.log(
    "HEAD",
    head,
    dirty ? "(WORKING TREE DIRTY)" : "(clean working tree)",
  );
  for (const file of [
    "src/components/SettingsPage.tsx",
    "src/components/settings/DictationCleanupControl.tsx",
    "src/components/ui/HotkeyListInput.tsx",
    "src/components/ui/HotkeyInput.tsx",
    "src/stores/settingsStore.ts",
  ]) {
    const digest = crypto
      .createHash("sha256")
      .update(fs.readFileSync(path.join(REPO, file)))
      .digest("hex");
    console.log("SOURCE", file, digest);
  }
  if (dirty) console.log("DIRTY\n" + dirty);
}

async function main() {
  fs.mkdirSync(OUT, { recursive: true });
  pinSources();
  const cssDir = path.join(REPO, "src/dist/assets");
  const css = fs
    .readdirSync(cssDir)
    .filter((file) => file.endsWith(".css"))
    .map((file) => fs.readFileSync(path.join(cssDir, file), "utf8"))
    .join("\n");

  // Whichever fingerprinted woff2 the stylesheet asks for first; the capture
  // is checked against it rather than trusting that it arrived.
  const fontUrl = `/${path.basename((css.match(/url\(["']?([^"')]+\.woff2)["']?\)/) || [])[1] || "")}`;

  let scenarioRows = [];
  const { createServer } = await import(
    path.join(REPO, "node_modules/vite/dist/node/index.js")
  );
  const cacheDir = fs.mkdtempSync(
    path.join(os.tmpdir(), "openwhispr-ui-evidence-vite-"),
  );
  const virtual = { "/__evidenceEntry": ENTRY, "/__evidenceSetup": SETUP };
  const vite = await createServer({
    root: path.join(REPO, "src"),
    cacheDir,
    configFile: path.join(REPO, "src/vite.config.mjs"),
    logLevel: "warn",
    server: { port: 5399, strictPort: true, host: "127.0.0.1" },
    plugins: [
      {
        name: "evidence-entry",
        enforce: "pre",
        resolveId(source) {
          const hit = Object.keys(virtual).find((key) => source.endsWith(key));
          return hit ? `\0evidence${hit}` : null;
        },
        load(id) {
          if (!id.startsWith("\0evidence")) return null;
          return virtual[id.slice("\0evidence".length)];
        },
        configureServer(server) {
          server.middlewares.use((req, res, next) => {
            const name = (req.url || "").split("?")[0].replace(/^\//, "");
            if (!name || name.includes("/")) return next();
            const type = ASSET_TYPES[path.extname(name)];
            const asset = path.join(cssDir, name);
            if (!type || !fs.existsSync(asset) || !fs.statSync(asset).isFile())
              return next();
            res.setHeader("content-type", type);
            res.setHeader("cache-control", "no-store");
            res.end(fs.readFileSync(asset));
          });
          server.middlewares.use((req, res, next) => {
            // Answered so the browser's 404 for it does not land in the page's
            // error log, where it reads like a real failure.
            if (req.url !== "/favicon.ico") return next();
            res.statusCode = 204;
            res.end();
          });
          server.middlewares.use(async (req, res, next) => {
            if (!req.url || !req.url.startsWith("/__evidence.html"))
              return next();
            const html = await server.transformIndexHtml(
              req.url,
              page({ locale: "en", rows: scenarioRows, css }),
            );
            res.setHeader("content-type", "text/html");
            res.end(html);
          });
        },
      },
    ],
  });
  await vite.listen();

  const userDataDir = fs.mkdtempSync(
    path.join(os.tmpdir(), "openwhispr-ui-evidence-chrome-"),
  );
  const chrome = spawn(CHROME, [
    "--headless=new",
    "--remote-debugging-port=0",
    `--user-data-dir=${userDataDir}`,
    "--no-sandbox",
    "--disable-gpu",
    "--hide-scrollbars",
    "--window-size=900,1600",
    "--force-color-profile=srgb",
    "about:blank",
  ]);
  chrome.stderr.on("data", () => {});

  const portFile = path.join(userDataDir, "DevToolsActivePort");
  let endpoint = null;
  // A loaded box can take longer than 10s to get Chrome up, and a Chrome that
  // never reports must not be left running: the run that hit this leaked a
  // headless browser and its profile.
  for (let i = 0; i < 300 && !endpoint; i++) {
    await sleep(100);
    if (!fs.existsSync(portFile)) continue;
    const [port, pathPart] = fs
      .readFileSync(portFile, "utf8")
      .trim()
      .split("\n");
    if (port && pathPart) endpoint = `ws://127.0.0.1:${port}${pathPart}`;
  }
  if (!endpoint) {
    try {
      chrome.kill("SIGKILL");
    } catch {}
    try {
      fs.rmSync(userDataDir, { recursive: true, force: true });
    } catch {}
    throw new Error("Chrome did not report a DevTools endpoint");
  }

  const socket = new WebSocket(endpoint, {
    perMessageDeflate: false,
    maxPayload: 256 * 1024 * 1024,
  });
  await new Promise((resolve, reject) => {
    socket.once("open", resolve);
    socket.once("error", reject);
  });
  const cdp = new Cdp(socket);

  // Teardown runs at the end of main so its outcome can reach the exit code.
  // The "exit" listener is only a safety net for an early exit: an error
  // thrown from there prints after the status is already fixed, which is how
  // a run once reported success while crashing on ENOTEMPTY.
  let cleanupError = null;
  let cleanedUp = false;
  const cleanup = () => {
    if (cleanedUp) return;
    cleanedUp = true;
    try {
      socket.close();
    } catch {}
    try {
      chrome.kill("SIGKILL");
    } catch {}
    void vite.close().catch(() => {});
    for (const dir of [cacheDir, userDataDir]) {
      try {
        // Chrome is still flushing its profile as it dies, so a single pass
        // races it; rmSync retries ENOTEMPTY and EBUSY when asked to.
        fs.rmSync(dir, {
          recursive: true,
          force: true,
          maxRetries: 20,
          retryDelay: 100,
        });
      } catch (error) {
        cleanupError = `${dir}: ${error.message}`;
        console.error("CLEANUP FAILED:", cleanupError);
      }
    }
  };
  process.on("exit", cleanup);

  let fontsVerified = false;
  const open = async (rows, { apply } = {}) => {
    scenarioRows = rows;
    const { targetId } = await cdp.send(
      "Target.createTarget",
      { url: "about:blank" },
      false,
    );
    const { sessionId } = await cdp.send(
      "Target.attachToTarget",
      { targetId, flatten: true },
      false,
    );
    cdp.sessionId = sessionId;
    await cdp.send("Page.enable");
    await cdp.send("Runtime.enable");
    await cdp.send("Log.enable");
    await cdp.send("Network.enable");
    await cdp.send("Emulation.setDeviceMetricsOverride", {
      width: 900,
      height: 1600,
      deviceScaleFactor: 1,
      mobile: false,
    });
    cdp.pageExceptions.length = 0;
    cdp.browserLogs.length = 0;
    await cdp.send("Page.navigate", {
      url: "http://127.0.0.1:5399/__evidence.html",
    });
    // Ready means the section under review is actually on screen with its
    // rows: a mounted root that rendered nothing is exactly the blank page
    // this harness must refuse to photograph.
    // Bounded, but generous: the dev server optimizes this app's dependency
    // graph from a cold cache on the first page of each run.
    let ready = null;
    let reloads = 0;
    for (let i = 0; i < 1200; i++) {
      await sleep(100);
      ready = await cdp.evaluate(READY_PROBE).catch(() => null);
      if (ready?.ready) break;
      if (i > 0 && i % 100 === 0)
        console.log(`  …waiting for the section (${i / 10}s)`);
      // Vite aborts the in-flight module requests when it re-optimizes this
      // app's dependency graph, and the entry does not run again by itself —
      // the page then sits there mounted:false with nothing in the console.
      // Navigating again once the optimizer has settled is what makes a cold
      // run mount. Bounded to two retries, so a page that is genuinely broken
      // still fails rather than being reloaded forever.
      if (!ready?.mounted && reloads < 2 && i > 0 && i % 250 === 0) {
        reloads += 1;
        console.log(
          `  …nothing mounted yet; navigating again (attempt ${reloads + 1})`,
        );
        await cdp.send("Page.navigate", {
          url: "http://127.0.0.1:5399/__evidence.html",
        });
      }
    }
    if (!ready?.ready) {
      const dump = await cdp
        .evaluate(
          "JSON.stringify({ url: location.href, mounted: Boolean(window.__evidenceMounted), root: (document.getElementById('root')||{}).innerHTML?.slice(0, 400), body: document.body.innerHTML.slice(0, 400) })",
        )
        .catch((error) => `dump failed: ${error.message}`);
      throw new Error(
        `the dictation section never rendered: ${JSON.stringify(ready)} ${dump}` +
          (cdp.browserLogs.length
            ? `\nbrowser errors:\n  ${cdp.browserLogs.join("\n  ")}`
            : ""),
      );
    }
    if (apply) {
      await cdp.evaluate(`window.__evidence.apply = ${apply}; true`);
    }
    // The hotkeys panel asks main for its mode info on mount.
    await settle(cdp, 6);
    // Text renders in a fallback face if the font 404s, and the only trace is
    // a log entry — so the bytes and the font set are both read back.
    if (fontUrl !== "/") {
      const fontReport = await cdp.evaluate(`(async () => {
        await document.fonts.ready;
        const response = await fetch(${JSON.stringify(fontUrl)});
        const head = new Uint8Array((await response.arrayBuffer()).slice(0, 4));
        return JSON.stringify({
          status: document.fonts.status,
          contentType: response.headers.get("content-type"),
          magic: String.fromCharCode(...head),
          loadedFaces: [...document.fonts].filter((face) => face.status === "loaded").length,
        });
      })()`);
      const font = JSON.parse(fontReport);
      if (
        font.magic !== "wOF2" ||
        font.status !== "loaded" ||
        font.loadedFaces < 1
      ) {
        throw new Error(
          `the page did not get its real font (${fontUrl}): ${fontReport}`,
        );
      }
      if (!fontsVerified) {
        console.log("FONT", fontUrl, fontReport);
        fontsVerified = true;
      }
    }
    if (cdp.pageExceptions.length > 0) {
      throw new Error(
        `the page threw while rendering: ${cdp.pageExceptions[0]}`,
      );
    }
    if (process.env.EVIDENCE_TRACE) {
      console.log(
        "unanswered IPC:",
        await cdp.evaluate(
          "JSON.stringify([...(window.__evidenceUnanswered || [])])",
        ),
      );
    }
    return targetId;
  };

  const close = async (targetId) => {
    cdp.sessionId = null;
    await cdp.send("Target.closeTarget", { targetId }, false);
  };

  const CLEANUP_TRIGGER = '[aria-label^="Text cleanup"]';
  const CUSTOMIZE = '[aria-label^="Customize cleanup"]';

  // Everything asserted below is read out of the rendered DOM and the page's
  // own localStorage — never out of the harness's stubs.
  const sectionText = () =>
    cdp.evaluate(`(() => {
      const section = [...document.querySelectorAll("div")].find(
        (node) => node.querySelector("h3")?.textContent === "Dictation Hotkey"
      );
      return section ? section.innerText : "";
    })()`);
  const storedRows = () =>
    cdp
      .evaluate('localStorage.getItem("dictationHotkeyConfig")')
      .then((value) => JSON.parse(value));
  // A collapsed disclosure keeps its content in the DOM: it is the wrapper
  // that collapses to zero height and goes inert, so "collapsed" is read from
  // the wrapper and from the toggle's own aria-expanded, not from the text.
  const disclosures = () =>
    cdp.evaluate(`(() => {
      const toggles = [...document.querySelectorAll('[aria-label^="Customize cleanup"]')];
      return toggles.map((toggle) => {
        const wrapper = toggle.parentElement.parentElement.querySelector("div.grid");
        return {
          expanded: toggle.getAttribute("aria-expanded") === "true",
          inert: wrapper ? wrapper.hasAttribute("inert") : null,
          height: wrapper ? Math.round(wrapper.getBoundingClientRect().height) : null,
        };
      });
    })()`);
  const openOptions = () =>
    cdp.evaluate(
      "JSON.stringify([...document.querySelectorAll('[role=\"option\"]')].map((n) => n.textContent))",
    );
  const must = (condition, message) => {
    if (!condition) throw new Error(message);
  };

  // The smallest block that holds the Dictation Hotkey heading AND its rows.
  // Captured instead of #shell, which is a page tall and mostly empty.
  const SECTION_TAG = "[data-evidence-section]";
  const tagSection = async () => {
    const report = await cdp.evaluate(`(() => {
      for (const node of document.querySelectorAll("[data-evidence-section]")) {
        node.removeAttribute("data-evidence-section");
      }
      const heading = [...document.querySelectorAll("h3")].find(
        (node) => node.textContent === "Dictation Hotkey"
      );
      if (!heading) return null;
      let node = heading;
      while (node.parentElement && !node.querySelector('[aria-label^="Customize cleanup"]')) {
        node = node.parentElement;
      }
      if (!node.querySelector('[aria-label^="Customize cleanup"]')) return null;
      const headings = [...node.querySelectorAll("h3")].map((h) => h.textContent);
      if (headings.some((text) => text !== "Dictation Hotkey")) return null;
      node.setAttribute("data-evidence-section", "");
      const rect = node.getBoundingClientRect();
      return JSON.stringify({ height: Math.round(rect.height), headings });
    })()`);
    must(
      report,
      "could not isolate the Dictation Hotkey group for the capture",
    );
    return JSON.parse(report);
  };

  // 1. What a user who never touches cleanup sees: one shortcut, the
  //    disclosure collapsed, nothing pinned.
  let target = await open([{ key: "Control+Super", mode: null }]);
  let text = await sectionText();
  must(
    text.includes("Customize cleanup"),
    "the row offers its cleanup disclosure",
  );
  must(!text.includes("Cleanup always"), `a default row pins nothing: ${text}`);
  let rows = await disclosures();
  must(
    rows.length === 1 &&
      rows[0].expanded === false &&
      rows[0].inert === true &&
      rows[0].height === 0,
    `and the selector stays collapsed: ${JSON.stringify(rows)}`,
  );
  await tagSection();
  await cdp.shot("ui-1-default-collapsed.png", {
    selector: SECTION_TAG,
    padding: 24,
  });
  await close(target);

  // 2. Ben's configuration: two rows, each pinned, summarised while collapsed.
  const BEN_ROWS = [
    { key: "Control+Shift+Space", mode: "cleaned" },
    { key: "Control+Alt+Shift", mode: "raw" },
  ];
  target = await open(BEN_ROWS);
  text = await sectionText();
  must(
    text.includes("Cleanup always on"),
    `row 1 summarises its override: ${text}`,
  );
  must(
    text.includes("Cleanup always off"),
    `row 2 summarises its override: ${text}`,
  );
  await tagSection();
  await cdp.shot("ui-2-two-rows-collapsed.png", {
    selector: SECTION_TAG,
    padding: 24,
  });

  // 3. The first row's customization, opened by a real click on the real
  //    disclosure.
  await cdp.clickSelector(CUSTOMIZE, { index: 0 });
  text = await sectionText();
  rows = await disclosures();
  must(
    rows[0].expanded && rows[0].inert === false && rows[0].height > 0,
    `the disclosure revealed the selector: ${JSON.stringify(rows)}`,
  );
  must(
    rows[1].expanded === false && rows[1].height === 0,
    `and left the other row collapsed: ${JSON.stringify(rows)}`,
  );
  must(
    text.includes("This shortcut always runs AI cleanup, even when it is off."),
    `and the mode's hint: ${text}`,
  );
  await tagSection();
  await cdp.shot("ui-3-customization-open.png", {
    selector: SECTION_TAG,
    padding: 24,
  });

  // 4. The selector itself, open, with its three choices on screen.
  await cdp.openSelect(CLEANUP_TRIGGER, 0);
  const options = JSON.parse(await openOptions());
  must(
    ["Use app setting", "Always on", "Always off"].every((label) =>
      options.includes(label),
    ),
    `the open menu lists every choice: ${JSON.stringify(options)}`,
  );
  await tagSection();
  // The open menu is portalled to <body>, so the clip takes it in beside the
  // group; the capture stays inside the viewport because resizing for a
  // beyond-viewport shot closes the popper.
  await cdp.shot("ui-4-selector-open.png", {
    selector: SECTION_TAG,
    padding: 24,
    beyondViewport: false,
    include: '[role="listbox"]',
  });
  must(
    JSON.parse(await openOptions()).length === 3,
    "the menu is still open in the frame that was captured",
  );

  // 5. Choosing "Always off" from the open menu, and the row committing it.
  await cdp.chooseOption("Always off");
  text = await sectionText();
  must(
    text.includes(
      "This shortcut pastes the transcript as spoken, even when AI cleanup is on.",
    ),
    `the chosen mode's hint replaced the previous one: ${text}`,
  );
  const afterChoice = await storedRows();
  must(
    afterChoice[0]?.key === "Control+Shift+Space" &&
      afterChoice[0]?.mode === "raw",
    `the committed row carries the new mode: ${JSON.stringify(afterChoice)}`,
  );
  must(
    afterChoice[1]?.mode === "raw" &&
      afterChoice[1]?.key === "Control+Alt+Shift",
    `and the other row is untouched: ${JSON.stringify(afterChoice)}`,
  );
  await tagSection();
  await cdp.shot("ui-5-mode-chosen.png", {
    selector: SECTION_TAG,
    padding: 24,
  });
  await close(target);

  // 6. A commit main accepted but could not fully confirm: the new row is
  //    live, and the section says the old binding may still be claimed. The
  //    warning sits outside every row's collapsed disclosure on purpose.
  target = await open(BEN_ROWS, {
    apply:
      "(request) => ({ success: true, rows: request.rows, degraded: true })",
  });
  await cdp.clickSelector(CUSTOMIZE, { index: 1 });
  await cdp.openSelect(CLEANUP_TRIGGER, 1);
  await cdp.chooseOption("Use app setting");
  text = await sectionText();
  must(
    text.includes("did not confirm it released the previous ones"),
    `the section warns about the unconfirmed release: ${text}`,
  );
  const degradedRows = await storedRows();
  must(
    degradedRows[1]?.mode === null,
    `the commit still applied: ${JSON.stringify(degradedRows)}`,
  );
  await tagSection();
  await cdp.shot("ui-6-commit-unconfirmed.png", {
    selector: SECTION_TAG,
    padding: 24,
  });
  await close(target);

  // 7. A refusal: main rolled back, the rows stay as they were committed, and
  //    the user gets both the modal and the persistent section warning.
  target = await open(BEN_ROWS, {
    apply:
      "() => ({ success: false, reason: 'hold_unsupported_row', error: 'To use Hold, add a regular key to the shortcut, such as Control+Alt+Space.' })",
  });
  await cdp.clickSelector(CUSTOMIZE, { index: 0 });
  await cdp.openSelect(CLEANUP_TRIGGER, 0);
  await cdp.chooseOption("Use app setting");
  // The refusal also opens the app's alert dialog, so the page text is read
  // whole: the section warning and the modal are both part of this state.
  text = await cdp.evaluate("document.body.innerText");
  must(
    text.includes("To use Hold, add a regular key to the shortcut"),
    `the refusal is shown: ${JSON.stringify(text)}`,
  );
  must(
    /Text cleanup\nAlways on/.test(text),
    `and the row's selector is back on its committed mode: ${JSON.stringify(text)}`,
  );
  must(
    text.includes("Hotkey Not Registered"),
    "the refusal is also raised as a dialog",
  );
  const refusedRows = await storedRows();
  must(
    refusedRows[0]?.mode === "cleaned",
    `storage kept the committed rows: ${JSON.stringify(refusedRows)}`,
  );
  await tagSection();
  // Both halves of this state, and nothing else: the dialog, and the dimmed
  // group behind it whose selector rolled back to its committed mode.
  await cdp.shot("ui-7-commit-refused.png", {
    selector: SECTION_TAG,
    padding: 24,
    beyondViewport: false,
    include: '[role="dialog"], [role="alertdialog"]',
  });
  await close(target);

  cleanup();
  if (cleanupError) {
    throw new Error(
      `the captures were written but the harness did not tear itself down: ${cleanupError}`,
    );
  }

  console.log("done");
}

main().then(
  () => process.exit(0),
  (error) => {
    console.error("FAILED:", error.stack || error.message);
    process.exit(1);
  },
);
