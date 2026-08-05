const $ = (id) => document.getElementById(id);
const logEl = $("log");

let running = false;

function setRunning(on) {
  running = on;
  $("run").disabled = on;
  $("stop").disabled = !on;
  $("status").textContent = on ? "Running…" : "Idle";
}

function appendLog(text) {
  logEl.textContent += text;
  logEl.scrollTop = logEl.scrollHeight;
}

function showResume(p) {
  const el = $("resume");
  el.textContent = p || "none set — click Change…";
  el.classList.toggle("missing", !p);
  el.title = p || "";
}

// The resume template is remembered between launches, so the link is the
// only thing to fill in per run.
window.seekr.getSettings().then((s) => showResume(s.resume));

$("pick").addEventListener("click", async () => {
  const p = await window.seekr.pickResume();
  if (p) showResume(p);
});

$("run").addEventListener("click", async () => {
  const url = $("url").value.trim();
  if (!url) return alert("Paste a job posting or careers page link.");

  logEl.textContent = "";
  $("results").classList.add("hidden");
  $("pause").classList.add("hidden");
  setRunning(true);

  const res = await window.seekr.run({ url, headed: true });
  if (!res.ok) {
    appendLog(`\n[shell] ${res.error}\n`);
    setRunning(false);
  }
});

$("stop").addEventListener("click", async () => {
  await window.seekr.stop();
  appendLog("\n[shell] Run stopped.\n");
  $("pause").classList.add("hidden");
  setRunning(false);
});

// Tears down anything active (mid-run, or paused waiting on you to close
// the review browser) and returns to a blank slate - so starting the next
// role never requires quitting and relaunching the whole app. Safe to
// click from Idle too; the main process just no-ops if nothing's running.
$("reset").addEventListener("click", async () => {
  await window.seekr.reset();
  setRunning(false);
  $("pause").classList.add("hidden");
  $("results").classList.add("hidden");
  logEl.textContent = "";
  $("url").value = "";
  $("url").focus();
  $("status").textContent = "Idle";
});

$("continue").addEventListener("click", async () => {
  await window.seekr.sendEnter();
  $("pause").classList.add("hidden");
  $("status").textContent = "Running…";
});

window.seekr.on("run-started", ({ command }) => appendLog(`$ ${command}\n\n`));
window.seekr.on("run-output", appendLog);

window.seekr.on("run-awaiting-input", (line) => {
  // The CLI is blocked on stdin. Distinguish the mid-run verification pause
  // (where you must do something in the browser first) from the final
  // "close the browser" prompt, since only the former needs explaining.
  const isFinal = /close the browser/i.test(line || "");
  $("pauseMsg").textContent = isFinal
    ? "The run is finished and the browser is still open for you to review and submit by hand. Click Continue to apply."
    : "The application is asking for a verification code. Enter it in the browser window that's open, then click Continue.";
  $("pause").classList.remove("hidden");
  $("status").textContent = "Waiting for you…";
});

window.seekr.on("run-finished", ({ code, report }) => {
  setRunning(false);
  $("pause").classList.add("hidden");
  appendLog(`\n[shell] Process exited with code ${code}.\n`);
  if (report) renderReport(report);
});

function li(html) {
  const el = document.createElement("li");
  el.innerHTML = html;
  return el;
}
const esc = (s) => String(s ?? "").replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));

function renderReport(r) {
  $("results").classList.remove("hidden");

  $("job").innerHTML =
    `<div class="title">${esc(r.job?.title || "(untitled)")}</div>` +
    `<div class="meta">${esc(r.job?.location || "")}${r.job?.score != null ? ` &middot; match ${Math.round(r.job.score)}` : ""}` +
    `${r.resumeUploaded ? ` &middot; uploaded ${esc(r.resumeUploaded.split(/[\\/]/).pop())}` : ""}</div>` +
    (r.job?.reasoning ? `<div class="meta">${esc(r.job.reasoning)}</div>` : "");

  const filled = r.filled || [];
  const skipped = r.skipped || [];
  $("filledCount").textContent = filled.length;
  $("skippedCount").textContent = skipped.length;

  const fl = $("filled");
  fl.innerHTML = "";
  for (const f of filled) {
    const tags =
      (f.generated ? '<span class="tag ai">AI</span>' : "") +
      (f.lowConfidence ? '<span class="tag low">low confidence</span>' : "");
    fl.appendChild(li(`<b>${esc(f.label)}</b>${tags}<br><span>${esc(String(f.value).slice(0, 240))}</span>`));
  }
  if (!filled.length) fl.appendChild(li('<span>Nothing filled.</span>'));

  const sk = $("skipped");
  sk.innerHTML = "";
  for (const s of skipped) {
    sk.appendChild(li(`<b>${esc(s.label)}</b>${s.required ? '<span class="tag req">required</span>' : ""}<br><span>${esc(s.reason)}</span>`));
  }
  if (!skipped.length) sk.appendChild(li('<span>Nothing skipped.</span>'));

  const notes = $("notes");
  notes.innerHTML = "";
  if (r.locationFlag) {
    const d = document.createElement("div");
    d.textContent = `Location/timezone soft-flag: mentions ${r.locationFlag.matched.join(", ")} — doesn't match your Atlanta / US-Eastern location.`;
    notes.appendChild(d);
  }
  for (const n of r.notes || []) {
    const d = document.createElement("div");
    d.textContent = n;
    notes.appendChild(d);
  }

  const shots = $("shots");
  shots.innerHTML = "";
  for (const s of r.screenshots || []) {
    const b = document.createElement("button");
    b.className = "ghost";
    b.textContent = `Open ${s.split(/[\\/]/).pop()}`;
    b.addEventListener("click", () => window.seekr.openPath(s));
    shots.appendChild(b);
  }
}
