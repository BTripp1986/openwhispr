// TEST-ONLY harness launcher. It is copied to the candidate's repo root as an
// UNTRACKED file purely so Electron resolves app.getAppPath() to that root
// (DevServerManager.getAppFilePath joins appPath + src/dist/index.html), and
// it is deleted again afterwards. It adds nothing to the app and changes no
// tracked file.
//
// Why a launcher at all: main.js derives userData from appData at module load
// (configureChannelUserDataPath), so `--user-data-dir` cannot isolate this
// app - the channel logic calls app.setPath("userData", ...) and overrides it.
// appData must therefore be redirected BEFORE main.js is required. HOME is
// left alone.
const path = require("node:path");
const { app } = require("electron");

const isolated = process.env.XPLAT_APPDATA;
if (!isolated) {
  console.error("XPLAT_SMOKE_FATAL XPLAT_APPDATA is required");
  app.exit(64);
} else {
  app.setPath("appData", isolated);
  const atLaunch = { appData: app.getPath("appData"), appPath: app.getAppPath() };
  require(path.join(__dirname, "main.js"));
  app.whenReady().then(() => {
    // Reported, not asserted here: the driver decides whether these paths are
    // really inside the isolated directory.
    console.log(
      "XPLAT_PATHS " +
        JSON.stringify({
          appPathAtLaunch: atLaunch.appPath,
          appDataAtLaunch: atLaunch.appData,
          appData: app.getPath("appData"),
          userData: app.getPath("userData"),
          appPath: app.getAppPath(),
          home: app.getPath("home"),
          channel: process.env.OPENWHISPR_CHANNEL,
          platform: process.platform,
          arch: process.arch,
          electron: process.versions.electron,
          chrome: process.versions.chrome,
          node: process.versions.node,
        })
    );
  });
}
