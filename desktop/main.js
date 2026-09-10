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
const net = require("node:net");

// One CDP port per batch, so every link's browser lands in the same window
// as tabs. Asking the OS for a free port beats a fixed 9222: that would
// collide with the user's own Chrome remote-debugging session, or with a
// browser left over from a previous batch, and the new job would silently
// attach to the wrong browser instead of its own.
function freePort() {
  return new Promise((resolve) => {
    const srv = net.createServer();
    srv.listen(0, "127.0.0.1", () => {
      const { port } = srv.address();
      srv.close(() => resolve(port));
    });
    srv.on("error", () => resolve(0)); // fall back to one window per link
  });
}

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

// A batch is up to MAX_QUEUE links, filled strictly one at a time. `jobs`
// holds one record per link for the whole batch; `activeIndex` is the link
// currently being filled. Earlier jobs are not finished - they're parked
// (see advance()), each still holding its browser window open for review.
const MAX_QUEUE = 5;
let jobs = [];
let activeIndex = -1;
let batch = null;

const PROFILE_DIR = path.resolve(MVP_DIR, ".browser-profile");

// Each queued job needs its OWN browser profile, because finished windows
// stay open while later links are still being filled. Chromium holds a
// SingletonLock on its user-data-dir for the window's entire lifetime, so
// launching a second persistent context against a directory whose window is
// still open does not yield a fresh browser - it fails with "Opening in
// existing browser session", the same breakage killProfileBrowsers() below
// exists to clean up after.
//
// Slot 0 deliberately keeps the original path, so a single-link run - still
// the common case - uses the same profile it always has and loses no stored
// verification. Slots 1..4 only come into play once a batch is queued.
//
// Cost worth knowing: verification state does not follow a job across
// slots. Two roles at the same employer in one batch can each ask for their
// own emailed code, and a slot's first-ever use is a genuinely fresh
// profile with no cookie history at all.
function profileForSlot(i) {
  return i === 0 ? PROFILE_DIR : `${PROFILE_DIR}-${i + 1}`;
}

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
//
// The -like '*<PROFILE_DIR>*' match is a substring test, so it also catches
// every queued slot: ".browser-profile-3" contains ".browser-profile".
// That's exactly what's wanted here - Stop/New run/quit should clear the
// whole batch, including review windows parked from earlier links - so no
// per-slot variant is needed. Anything that ever wants to close ONE slot
// would need an exact match instead.
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

// Kills every CLI process in the batch - the one actively filling plus any
// parked on the review prompt - and separately sweeps for the actual
// browsers via killProfileBrowsers(). Used for "Stop"/"New run" and on app
// quit, since all three can end a batch while several persistent-profile
// browsers are still open.
async function killActiveRun() {
  const procs = jobs.map((j) => j.proc).filter(Boolean);
  // Marked before killing so the close handlers these kills are about to
  // fire can't advance the queue and start the very next link we're trying
  // to tear down.
  for (const j of jobs) j.advanced = true;
  jobs = [];
  activeIndex = -1;
  batch = null;

  for (const p of procs) {
    if (process.platform === "win32") {
      await new Promise((resolve) => execFile("taskkill", ["/pid", String(p.pid), "/T", "/F"], () => resolve()));
    } else {
      try {
        process.kill(p.pid, "SIGKILL");
      } catch {
        /* already gone */
      }
    }
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

// The CLI blocks on stdin at two different points and this matches both, so
// the UI can surface a Continue button. Answered by writing a newline to
// the child's stdin - exactly what pressing Enter in a terminal does.
const PAUSE_PROMPT_RE = /Press Enter once you've entered it|Press Enter to close the browser/i;

// ...but only the FINAL prompt means "this link is done being filled". The
// other half of the match above is the mid-run verification pause, which
// genuinely needs a human at that moment and must NOT advance the queue.
// (It can't hang the batch forever regardless - the CLI races that prompt
// against a timeout.)
const FINAL_PAUSE_RE = /Press Enter to close the browser/i;

ipcMain.handle("run", async (_e, opts) => {
  if (jobs.length) return { ok: false, error: "A run is already in progress." };

  const urls = (opts.urls || [opts.url])
    .map((u) => String(u || "").trim())
    .filter(Boolean)
    .slice(0, MAX_QUEUE);
  if (!urls.length) return { ok: false, error: "Paste at least one link." };

  const resume = settings.resume;
  if (!resume || !fs.existsSync(resume)) {
    return { ok: false, error: "No resume template set. Use Change… to pick one." };
  }

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

  const batchStartedAt = Date.now();
  batch = {
    resume,
    tsxCli,
    // Where tailored resumes and the preview screenshot land. Renaming this
    // folder on disk does NOT move the output: index.ts mkdir -p's whatever
    // path it's given, so a rename silently starts a second history in a
    // freshly recreated folder. That already happened once - "out/desktop"
    // was renamed to this, and the next run recreated "out/desktop" and put
    // 8 resumes there while 24 sat in the renamed one. Change the string
    // here, not the folder on disk.
    outDir: opts.outDir || path.join(MVP_DIR, "out", "Electron App Stuff"),
    headed: opts.headed !== false,
    cdpPort: await freePort(),
    startedAt: batchStartedAt,
  };
  jobs = urls.map((url, index) => ({ index, url, proc: null, jsonOut: null, advanced: false }));

  send("queue-started", { total: jobs.length, urls });
  startJob(0);
  return { ok: true };
});

function startJob(i) {
  const job = jobs[i];
  if (!job) return;

  const jsonOut = path.join(os.tmpdir(), `seekr-run-${Date.now()}-${i}.json`);
  job.jsonOut = jsonOut;
  activeIndex = i;

  // --url lets the CLI classify the link itself, so the UI doesn't have to
  // ask which kind it is. --criteria is harmless when the link turns out to
  // be a single posting (it's only consulted for board runs). --profile is
  // the only flag this feature added, and it already existed on the CLI.
  const args = ["src/index.ts", "--url", job.url, "--criteria", "./criteria.json"];
  args.push("--resume", batch.resume, "--out", batch.outDir, "--json-out", jsonOut);
  args.push("--profile", profileForSlot(i));
  // Shared across the whole batch: the first link to launch hosts the
  // browser on this port, and every link after it attaches as a new tab.
  // --profile above is then only consulted by a job that fails to attach
  // and has to open its own window.
  if (batch.cdpPort) args.push("--cdp-port", String(batch.cdpPort));
  // Freeze the opened form into the regression corpus on every run. Always
  // on rather than a UI toggle: the cost is disk (gitignored, prunable),
  // and a capture you forgot to enable is worth nothing - the runs most
  // worth having frozen are the ones that surprised you, which is exactly
  // when you weren't thinking about test fixtures. The CLI captures before
  // filling anything, so these hold the blank form and none of your data,
  // and a capture failure only warns rather than failing the application.
  args.push("--snapshot", path.join(MVP_DIR, "snapshots"));
  if (batch.headed) args.push("--headed");

  send("job-started", { index: i, total: jobs.length, url: job.url, command: `npx tsx ${args.join(" ")}` });

  const proc = spawn(process.execPath, [batch.tsxCli, ...args], {
    cwd: MVP_DIR,
    shell: false,
    env: { ...process.env, FORCE_COLOR: "0", ELECTRON_RUN_AS_NODE: "1" },
  });
  job.proc = proc;

  const onChunk = (buf) => {
    const text = buf.toString();
    send("run-output", { index: i, text });
    if (FINAL_PAUSE_RE.test(text)) {
      advance(job, "review");
    } else if (PAUSE_PROMPT_RE.test(text)) {
      send("run-awaiting-input", { index: i, line: text.trim().split("\n").pop() });
    }
  };
  proc.stdout.on("data", onChunk);
  proc.stderr.on("data", onChunk);

  // Reached when a link fails early enough to never print the review prompt
  // (an unclassifiable URL, no posting over the score threshold, a crash),
  // and much later for parked jobs when Stop/New run/quit kills them.
  // advance() is idempotent, so the second case is a no-op.
  proc.on("close", (code) => advance(job, code === 0 ? "done" : "failed", code));
}

// Retires one link from the queue and starts the next.
//
// The "review" path is the interesting one, and it is deliberately NOT
// triggered by answering the CLI's final prompt. Sending Enter there would
// unblock index.ts, which immediately runs `finally { await
// browser.close() }` - closing the very window the user wanted kept. So the
// queue advances on *detecting* that prompt and never answers it: the CLI
// process stays parked on stdin, costing no CPU, and that parked process is
// precisely what holds its Chromium window open for review.
//
// The report is also read here rather than on process exit. index.ts writes
// --json-out before printing the review prompt, but a parked process never
// exits, so waiting for 'close' would mean a batch's results never rendered
// at all until the user tore everything down.
function advance(job, status, code) {
  if (job.advanced) return;
  job.advanced = true;

  let report = null;
  try {
    if (job.jsonOut && fs.existsSync(job.jsonOut)) {
      report = JSON.parse(fs.readFileSync(job.jsonOut, "utf-8"));
      fs.unlinkSync(job.jsonOut);
    }
  } catch (err) {
    send("run-output", { index: job.index, text: `\n[shell] could not read structured results: ${err.message}\n` });
  }
  // url is sent separately rather than left to be read out of the report,
  // because the cases with no report are exactly the ones that most need a
  // label - a link that failed before producing a form has nothing else to
  // identify it by.
  send("job-finished", { index: job.index, url: job.url, status, code, report });

  const next = job.index + 1;
  if (next < jobs.length) {
    startJob(next);
  } else {
    activeIndex = -1;
    send("queue-finished", { total: jobs.length });
  }
}

// Answers the CLI's stdin prompt - the same thing pressing Enter does. Only
// ever aimed at the link currently being filled; parked jobs are left
// blocked on purpose (see advance()).
ipcMain.handle("send-enter", async () => {
  const job = jobs[activeIndex];
  if (job && job.proc && job.proc.stdin.writable) {
    job.proc.stdin.write("\n");
    return true;
  }
  return false;
});

ipcMain.handle("stop", async () => {
  const wasRunning = jobs.length > 0;
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

// ---- problem reports ----------------------------------------------------
//
// Packages everything needed to diagnose a broken application into one
// folder: what the user saw, what the tool logged, the structured per-link
// results, and the actual pages captured during the batch.
//
// Written as SEPARATE FILES rather than one blob on purpose. These reports
// carry the candidate's name, email, phone and every answer given, so
// sharing one means choosing what to share - which is a file-picking
// problem if the parts are separate and a redaction problem if they are
// not. Kept local; nothing is uploaded anywhere.
//
// The captured pages are the point. A snapshot replays through the
// regression harness, so a report can become a permanent test rather than
// a folder nobody opens again.
ipcMain.handle('save-report', async (_e, payload) => {
  try {
    const stamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
    const slug = (payload.label || '').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 40);
    const root = path.join(MVP_DIR, 'out', 'reports', slug ? stamp + '-' + slug : stamp);
    fs.mkdirSync(root, { recursive: true });

    const urls = payload.urls || [];
    const md = [
      '# Seekr problem report',
      '',
      payload.label ? `**Scope:** ${payload.label}` : '**Scope:** the whole batch',
      '',
      `- **When:** ${new Date().toISOString()}`,
      `- **Links:**`,
      ...urls.map((u) => `  - ${u}`),
      '',
      '## What I expected',
      '',
      (payload.expected || '_(not filled in)_').trim(),
      '',
      '## What actually happened',
      '',
      (payload.actual || '_(not filled in)_').trim(),
      '',
      '## What the page looks like',
      '',
      (payload.page || '_(not filled in)_').trim(),
      '',
      '## Files in this report',
      '',
      '- `output.log` - full terminal output of the run',
      '- `results/` - the structured per-link results the UI rendered',
      '- `snapshots/` - pages captured during this batch, replayable via `npm run test:snapshots`',
      '',
    ].join(String.fromCharCode(10));
    fs.writeFileSync(path.join(root, 'report.md'), md, 'utf-8');
    fs.writeFileSync(path.join(root, 'output.log'), payload.log || '', 'utf-8');

    // Structured results, one file per link.
    const results = payload.results || [];
    if (results.length) {
      const dir = path.join(root, 'results');
      fs.mkdirSync(dir, { recursive: true });
      results.forEach((r, i) => {
        fs.writeFileSync(path.join(dir, `link-${i + 1}.json`), JSON.stringify(r, null, 2), 'utf-8');
      });
    }

    // Snapshots. A PER-LINK report knows exactly which directories the CLI
    // announced for that link (the shell scrapes the '-> snapshot saved'
    // lines out of its output), so it copies those and nothing else. A
    // whole-batch report has no such list and falls back to mtime, which is
    // right for all-or-nothing but useless for picking one link out of five:
    // a failure snapshot is slugged from the page TITLE, which need not
    // resemble the link that produced it.
    const since = payload.startedAt || 0;
    const snapRoot = path.join(MVP_DIR, 'snapshots');
    let copied = 0;
    const copySnapshot = (dirName) => {
      const dst = path.join(root, 'snapshots', dirName);
      fs.mkdirSync(dst, { recursive: true });
      for (const f of ['page.mhtml', 'meta.json', 'expected.json']) {
        const from = path.join(snapRoot, dirName, f);
        if (fs.existsSync(from)) fs.copyFileSync(from, path.join(dst, f));
      }
      copied++;
    };

    const named = (payload.snapshotPaths || []).map((sp) => path.basename(sp));
    if (named.length) {
      for (const name of new Set(named)) {
        if (fs.existsSync(path.join(snapRoot, name, 'page.mhtml'))) copySnapshot(name);
      }
    } else if (fs.existsSync(snapRoot)) {
      for (const name of fs.readdirSync(snapRoot)) {
        const src = path.join(snapRoot, name, 'page.mhtml');
        if (!fs.existsSync(src)) continue;
        if (fs.statSync(src).mtimeMs < since) continue;
        copySnapshot(name);
      }
    }

    // Screenshots come from the results themselves, never from a fixed
    // filename. Each run records the path it actually wrote, so a per-link
    // report copies that link's own image - the same principle as the
    // snapshot handling above.
    //
    // The old code copied out/<outDir>/application-preview.png by mtime.
    // That name used to be shared by every link in a batch, so all five
    // reports from one real run carried a byte-identical screenshot of the
    // LAST application, silently mislabelling four of them.
    let shots = 0;
    for (const r of results) {
      for (const sp of (r && r.report && r.report.screenshots) || []) {
        if (!sp || !fs.existsSync(sp)) continue;
        fs.copyFileSync(sp, path.join(root, path.basename(sp)));
        shots++;
      }
    }

    return { ok: true, path: root, snapshots: copied, screenshots: shots };
  } catch (err) {
    return { ok: false, error: err.message };
  }
});

function send(channel, payload) {
  if (win && !win.isDestroyed()) win.webContents.send(channel, payload);
}
