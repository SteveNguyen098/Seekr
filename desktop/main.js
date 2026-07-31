// Electron main process.
//
// This is a SHELL, not a reimplementation. It spawns the existing CLI
// (mvp/src/index.ts) exactly as a terminal would and streams its output to
// the window. No scraping/filtering/tailoring/filling logic lives here or
// is duplicated here - if this file were deleted, the CLI would still work
// identically.
const { app, BrowserWindow, ipcMain, dialog, shell } = require("electron");
const { spawn } = require("node:child_process");
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
  if (child) child.kill();
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

  const onChunk = (buf) => {
    const text = buf.toString();
    send("run-output", text);
    if (PAUSE_PROMPT_RE.test(text)) send("run-awaiting-input", text.trim().split("\n").pop());
  };
  child.stdout.on("data", onChunk);
  child.stderr.on("data", onChunk);

  child.on("close", (code) => {
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
  if (child) {
    child.kill();
    child = null;
    return true;
  }
  return false;
});

function send(channel, payload) {
  if (win && !win.isDestroyed()) win.webContents.send(channel, payload);
}
