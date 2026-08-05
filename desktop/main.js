// Electron main process.
//
// This is a SHELL, not a reimplementation. It spawns the existing CLI
// (mvp/src/index.ts) exactly as a terminal would and streams its output to
// the window. No scraping/filtering/tailoring/filling logic lives here or
// is duplicated here - if this file were deleted, the CLI would still work
// identically.
const { app, BrowserWindow, ipcMain, dialog, shell } = require("electron");
const { spawn, execFile } = require("node:child_process");
const path = require("node:path");
const os = require("node:os");
const fs = require("node:fs");

const MVP_DIR = path.resolve(__dirname, "..", "mvp");

// The resume template is configuration, not a per-run input: the whole
// point of a template is that it's chosen once and reused for every
// application. Persisted outside the repo, in Electron's userData dir.
const DEFAULT_TEMPLATE = path.resolve(__dirname, "..", "Seekr Resume Template.docx");
let settingsPath = null;
let settings = { resume: "" };

function loadSettings() {
  settingsPath = path.join(app.getPath("userData"), "settings.json");
  try {
    settings = { ...settings, ...JSON.parse(fs.readFileSync(settingsPath, "utf-8")) };
  } catch {
    /* first run - fall through to the default below */
  }
  if (!settings.resume || !fs.existsSync(settings.resume)) {
    settings.resume = fs.existsSync(DEFAULT_TEMPLATE) ? DEFAULT_TEMPLATE : "";
  }
}

function saveSettings() {
  try {
    fs.writeFileSync(settingsPath, JSON.stringify(settings, null, 2));
  } catch {
    /* non-fatal: the app still works, it just won't remember next launch */
  }
}

let win = null;
let child = null;

const PROFILE_DIR = path.resolve(MVP_DIR, ".browser-profile");

// child.kill() only terminates the tsx/Node process - it does not take down
// the Chromium process Playwright launches underneath it. The obvious fix,
// taskkill /T (kill the whole process tree rooted at the launcher's pid),
// does NOT work here - measured directly: Chromium detaches from its
// launching process during its own startup sequence, so by the time
// anything tries to tear it down, the real long-lived browser process has
// already been re-parented away (observed landing under explorer.exe) and
// taskkill /T killed everything *except* it. This is almost certainly why
// 44 orphaned Chromium processes were found still holding
// .browser-profile's lock this session, each blocking every subsequent
// launchPersistentContext() call with "Opening in existing browser
// session" until manually hunted down.
//
// The reliable signal isn't ancestry, it's what the process was launched
// with: every process belonging to a persistent-context browser carries
// --user-data-dir=<profileDir> on its own command line, regardless of
// who its current OS-level parent is. Confirmed live: this finds and
// kills the browser that taskkill /T left behind.
function killProfileBrowsers() {
  return new Promise((resolve) => {
    if (process.platform !== "win32") return resolve();
    const escaped = PROFILE_DIR.replace(/'/g, "''");
    // Playwright launches a different binary per mode - chrome.exe when
    // headed (what this app always uses today: renderer.js hardcodes
    // headed: true), chrome-headless-shell.exe when headless. Matching
    // both is cheap insurance against that ever changing.
    const script = `Get-CimInstance Win32_Process | Where-Object { ($_.Name -eq 'chrome.exe' -or $_.Name -eq 'chrome-headless-shell.exe') -and $_.CommandLine -like '*${escaped}*' } | ForEach-Object { Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue }`;
    execFile("powershell", ["-NoProfile", "-Command", script], () => resolve());
  });
}

// Kills the CLI process itself (if still alive - it may have already
// exited, e.g. if the browser window was closed by hand) and separately
// sweeps for the actual browser via killProfileBrowsers(). Used for both
// "Stop"/"New run" and on app quit, since all three can end a run while its
// persistent-profile browser is still open.
async function killActiveRun() {
  if (child) {
    if (process.platform === "win32") {
      await new Promise((resolve) => execFile("taskkill", ["/pid", String(child.pid), "/T", "/F"], () => resolve()));
    } else {
      try {
        process.kill(child.pid, "SIGKILL");
      } catch {
        /* already gone */
      }
    }
    child = null;
  }
  await killProfileBrowsers();
}

function createWindow() {
  win = new BrowserWindow({
    width: 1100,
    height: 820,
    title: "Seekr",
    backgroundColor: "#111318",
    webPreferences: { preload: path.join(__dirname, "preload.js"), contextIsolation: true, nodeIntegration: false },
  });
  win.setMenuBarVisibility(false);
  win.loadFile(path.join(__dirname, "renderer", "index.html"));
}

app.whenReady().then(() => {
  loadSettings();
  createWindow();
});
app.on("window-all-closed", () => {
  killActiveRun();
  if (process.platform !== "darwin") app.quit();
});

// ---- dialogs -------------------------------------------------------------

ipcMain.handle("get-settings", async () => ({ ...settings, defaultTemplate: DEFAULT_TEMPLATE }));

ipcMain.handle("pick-resume", async () => {
  const r = await dialog.showOpenDialog(win, {
    title: "Choose your resume template",
    filters: [{ name: "Resume", extensions: ["docx", "txt"] }],
    properties: ["openFile"],
  });
  if (r.canceled) return null;
  settings.resume = r.filePaths[0];
  saveSettings();
  return settings.resume;
});

ipcMain.handle("open-path", async (_e, p) => {
  if (p && fs.existsSync(p)) await shell.openPath(p);
});

// ---- running the pipeline ------------------------------------------------

// The CLI's verification pause prints this and then blocks on stdin. We
// watch for it so the UI can surface a Continue button, and answer it by
// writing a newline to the child's stdin - which is exactly what pressing
// Enter in a terminal does. Nothing in the CLI needed to change for this.
const PAUSE_PROMPT_RE = /Press Enter once you've entered it|Press Enter to close the browser/i;

ipcMain.handle("run", async (_e, opts) => {
  if (child) return { ok: false, error: "A run is already in progress." };

  const jsonOut = path.join(os.tmpdir(), `seekr-run-${Date.now()}.json`);
  const outDir = opts.outDir || path.join(MVP_DIR, "out", "desktop");

  const resume = settings.resume;
  if (!resume || !fs.existsSync(resume)) {
    return { ok: false, error: "No resume template set. Use Change… to pick one." };
  }

  // --url lets the CLI classify the link itself, so the UI doesn't have to
  // ask which kind it is. --criteria is harmless when the link turns out to
  // be a single posting (it's only consulted for board runs).
  const args = ["src/index.ts", "--url", opts.url, "--criteria", "./criteria.json"];
  args.push("--resume", resume, "--out", outDir, "--json-out", jsonOut);
  if (opts.headed !== false) args.push("--headed");

  send("run-started", { command: `npx tsx ${args.join(" ")}` });

  // Run tsx's CLI directly instead of going through `npx` in a shell.
  //
  // shell:true concatenates argv into a command line without escaping, so a
  // resume path containing spaces ("...\Seekr Resume Template.docx") gets
  // split and the CLI receives a truncated path - verified failing before
  // this change. shell:false with "npx.cmd" isn't an option either: Node 24
  // refuses to spawn .cmd files without a shell (EINVAL). Invoking the
  // resolved cli.mjs with no shell at all passes argv through verbatim,
  // which is the only variant measured to deliver the path intact.
  //
  // process.execPath is Electron's own binary, so ELECTRON_RUN_AS_NODE makes
  // it behave as plain Node - meaning this doesn't depend on a system Node
  // being installed or on PATH.
  const tsxCli = path.join(MVP_DIR, "node_modules", "tsx", "dist", "cli.mjs");
  if (!fs.existsSync(tsxCli)) {
    return { ok: false, error: `Could not find tsx at ${tsxCli}. Run "npm install" in the mvp folder.` };
  }

  child = spawn(process.execPath, [tsxCli, ...args], {
    cwd: MVP_DIR,
    shell: false,
    env: { ...process.env, FORCE_COLOR: "0", ELECTRON_RUN_AS_NODE: "1" },
  });
  // Captured so the close handler below can tell "this exact process" apart
  // from "whatever the module-level `child` happens to be by the time the
  // OS gets around to telling Node it exited" - those can diverge now that
  // Reset makes kill-then-immediately-start-another-run a normal flow, not
  // an edge case. Without this, a delayed close event from a run just
  // killed by Reset would null out the *new* run's `child` the moment it
  // arrives and push a stale run-finished at the renderer over top of the
  // new run's live output.
  const thisChild = child;

  const onChunk = (buf) => {
    const text = buf.toString();
    send("run-output", text);
    if (PAUSE_PROMPT_RE.test(text)) send("run-awaiting-input", text.trim().split("\n").pop());
  };
  child.stdout.on("data", onChunk);
  child.stderr.on("data", onChunk);

  child.on("close", (code) => {
    if (child !== thisChild) return; // superseded by a later run - not our state to touch
    child = null;
    let report = null;
    try {
      if (fs.existsSync(jsonOut)) {
        report = JSON.parse(fs.readFileSync(jsonOut, "utf-8"));
        fs.unlinkSync(jsonOut);
      }
    } catch (err) {
      send("run-output", `\n[shell] could not read structured results: ${err.message}\n`);
    }
    send("run-finished", { code, report });
  });

  return { ok: true };
});

// Answers the CLI's stdin prompt - the same thing pressing Enter does.
ipcMain.handle("send-enter", async () => {
  if (child && child.stdin.writable) {
    child.stdin.write("\n");
    return true;
  }
  return false;
});

ipcMain.handle("stop", async () => {
  const wasRunning = !!child;
  await killActiveRun();
  return wasRunning;
});

// Lets a new role start without quitting and relaunching the whole app.
// Tears down whatever's currently running (if anything) the same reliable
// way "stop" does, so the browser-profile lock is actually released rather
// than left behind for the next run to trip over. The renderer clears its
// own UI state (log, results, url field) after this resolves.
ipcMain.handle("reset", async () => {
  await killActiveRun();
  return true;
});

function send(channel, payload) {
  if (win && !win.isDestroyed()) win.webContents.send(channel, payload);
}
