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

app.whenReady().then(createWindow);
app.on("window-all-closed", () => {
  if (child) child.kill();
  if (process.platform !== "darwin") app.quit();
});

// ---- dialogs -------------------------------------------------------------

ipcMain.handle("pick-resume", async () => {
  const r = await dialog.showOpenDialog(win, {
    title: "Select your resume",
    filters: [{ name: "Resume", extensions: ["docx", "txt"] }],
    properties: ["openFile"],
  });
  return r.canceled ? null : r.filePaths[0];
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

  const args = ["tsx", "src/index.ts"];
  if (opts.urlKind === "job") {
    args.push("--job-url", opts.url);
  } else {
    args.push("--career-url", opts.url, "--criteria", "./criteria.json");
  }
  args.push("--resume", opts.resume, "--out", outDir, "--json-out", jsonOut);
  if (opts.headed !== false) args.push("--headed");

  send("run-started", { command: `npx ${args.join(" ")}` });

  child = spawn("npx", args, {
    cwd: MVP_DIR,
    shell: true, // needed for npx resolution on Windows
    env: { ...process.env, FORCE_COLOR: "0" },
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
