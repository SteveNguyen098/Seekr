const $ = (id) => document.getElementById(id);
const logEl = $("log");

const MAX_LINKS = 5;
let running = false;

function setRunning(on) {
  running = on;
  $("run").disabled = on;
  $("stop").disabled = !on;
  $("addLink").disabled = on;
  for (const i of linkInputs()) i.disabled = on;
  if (!on) $("status").textContent = "Idle";
}

// ---- link rows -----------------------------------------------------------

const linkInputs = () => Array.from(document.querySelectorAll("#links input"));

function addLinkRow(value = "") {
  const rows = document.querySelectorAll("#links .linkRow");
  if (rows.length >= MAX_LINKS) return;

  const row = document.createElement("div");
  row.className = "linkRow";

  const n = document.createElement("span");
  n.className = "linkNum";

  const input = document.createElement("input");
  input.type = "text";
  input.placeholder = "https://...";
  input.spellcheck = false;
  input.value = value;
  // Enter anywhere in the list starts the batch, matching the old
  // single-input behaviour.
  input.addEventListener("keydown", (e) => {
    if (e.key === "Enter" && !running) $("run").click();
  });

  const del = document.createElement("button");
  del.className = "ghost small";
  del.textContent = "×";
  del.title = "Remove this link";
  del.addEventListener("click", () => {
    if (running) return;
    row.remove();
    renumberLinks();
  });

  row.append(n, input, del);
  $("links").appendChild(row);
  renumberLinks();
  return input;
}

// Keeps the visible numbering and the "remove" affordance honest: the last
// remaining row can't be deleted, and the Add button disappears at the cap.
function renumberLinks() {
  const rows = Array.from(document.querySelectorAll("#links .linkRow"));
  rows.forEach((row, i) => {
    row.querySelector(".linkNum").textContent = i + 1;
    row.querySelector("button").style.visibility = rows.length > 1 ? "visible" : "hidden";
  });
  $("addLink").style.display = rows.length >= MAX_LINKS ? "none" : "";
}

addLinkRow();
$("addLink").addEventListener("click", () => addLinkRow()?.focus());

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

// Every link in a batch shares one browser profile now, which is what makes
// a verification carry across links. The flip side: two links at the same
// employer also share that employer's session, and some ATSs treat the
// second one as a continuation of the first application rather than a new
// one. Cheap to warn about, genuinely annoying to discover afterwards.
function sameEmployerWarning(urls) {
  const byHost = new Map();
  for (const u of urls) {
    let host;
    try {
      host = new URL(u).hostname.replace(/^www\./, "");
    } catch {
      continue; // not a parseable URL; the CLI will reject it with a better message
    }
    byHost.set(host, (byHost.get(host) || 0) + 1);
  }
  const dupes = [...byHost].filter(([, n]) => n > 1);
  if (!dupes.length) return null;
  return (
    `These links point at the same site:\n\n` +
    dupes.map(([h, n]) => `  • ${h} — ${n} links`).join("\n") +
    `\n\nEvery link in a batch shares one browser profile, so the second application ` +
    `to an employer inherits the first one's session. Some systems treat that as ` +
    `continuing the first application instead of starting a new one.\n\n` +
    `Run them in separate batches if you'd rather keep the sessions apart.\n\n` +
    `Continue anyway?`
  );
}

$("run").addEventListener("click", async () => {
  const urls = linkInputs()
    .map((i) => i.value.trim())
    .filter(Boolean);
  if (!urls.length) return alert("Paste at least one job posting or careers page link.");

  const warning = sameEmployerWarning(urls);
  if (warning && !confirm(warning)) return;

  logEl.textContent = "";
  $("results").innerHTML = "";
  $("pause").classList.add("hidden");
  setRunning(true);

  const res = await window.seekr.run({ urls, headed: true });
  if (!res.ok) {
    appendLog(`\n[shell] ${res.error}\n`);
    setRunning(false);
  }
});

$("stop").addEventListener("click", async () => {
  await window.seekr.stop();
  appendLog("\n[shell] Batch stopped — all browser windows closed.\n");
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
  $("results").innerHTML = "";
  logEl.textContent = "";
  $("links").innerHTML = "";
  addLinkRow().focus();
  $("status").textContent = "Idle";
});

$("continue").addEventListener("click", async () => {
  await window.seekr.sendEnter();
  $("pause").classList.add("hidden");
  $("status").textContent = "Running…";
});

let queueTotal = 1;

window.seekr.on("queue-started", ({ total }) => {
  queueTotal = total;
});

window.seekr.on("job-started", ({ index, total, url, command }) => {
  queueTotal = total;
  $("status").textContent = `Filling link ${index + 1} of ${total}…`;
  appendLog(`${index > 0 ? "\n\n" : ""}${"=".repeat(60)}\n[${index + 1}/${total}] ${url}\n${"=".repeat(60)}\n$ ${command}\n\n`);
});

window.seekr.on("run-output", ({ text }) => appendLog(text));

// Only ever the mid-run verification pause now. The final "close the
// browser" prompt is consumed by the main process to advance the queue and
// is deliberately never answered, so it no longer surfaces here.
window.seekr.on("run-awaiting-input", ({ index }) => {
  $("pauseMsg").textContent = `Link ${index + 1} is asking for a verification code. Enter it in the browser window that's open, then click Continue.`;
  $("pause").classList.remove("hidden");
  $("status").textContent = "Waiting for you…";
});

window.seekr.on("job-finished", ({ index, url, status, code, report }) => {
  $("pause").classList.add("hidden");
  if (status === "review") {
    appendLog(`\n[shell] Link ${index + 1} filled. Its browser window is open for review.\n`);
  } else {
    appendLog(`\n[shell] Link ${index + 1} ended without reaching a form (exit code ${code}).\n`);
  }
  renderReport(report, { index, status, url });
});

window.seekr.on("queue-finished", ({ total }) => {
  setRunning(false);
  $("status").textContent =
    total > 1
      ? `All ${total} links filled — review the open windows, then submit each by hand.`
      : "Filled — review the open window, then submit by hand.";
  appendLog(
    `\n[shell] Batch complete. ${total} browser window${total > 1 ? "s are" : " is"} still open for review.\n` +
      `[shell] Submit by hand, then use New run when you're done — that closes them all.\n`
  );
});

function li(html) {
  const el = document.createElement("li");
  el.innerHTML = html;
  return el;
}
const esc = (s) => String(s ?? "").replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));

// Appends one card per link rather than overwriting a single fixed panel,
// so a whole batch stays on screen side by side.
function renderReport(r, { index, status, url }) {
  const card = document.createElement("section");
  card.className = "results";

  const head = document.createElement("div");
  head.className = "job";
  const badge =
    status === "review"
      ? '<span class="tag ok">filled</span>'
      : '<span class="tag req">no form</span>';
  head.innerHTML =
    `<div class="title"><span class="pill">${index + 1} of ${queueTotal}</span> ${esc(r?.job?.title || url || "(untitled)")}${badge}</div>` +
    (r
      ? `<div class="meta">${esc(r.job?.location || "")}${r.job?.score != null ? ` &middot; match ${Math.round(r.job.score)}` : ""}` +
        `${r.resumeUploaded ? ` &middot; uploaded ${esc(r.resumeUploaded.split(/[\\/]/).pop())}` : ""}</div>` +
        (r.job?.reasoning ? `<div class="meta">${esc(r.job.reasoning)}</div>` : "")
      : `<div class="meta">This link produced no application form — see the log above for why.</div>`);
  card.appendChild(head);

  if (!r) {
    $("results").appendChild(card);
    return;
  }

  const filled = r.filled || [];
  const skipped = r.skipped || [];

  const cols = document.createElement("div");
  cols.className = "cols";

  const fl = document.createElement("ul");
  for (const f of filled) {
    const tags =
      (f.generated ? '<span class="tag ai">AI</span>' : "") +
      (f.lowConfidence ? '<span class="tag low">low confidence</span>' : "");
    fl.appendChild(li(`<b>${esc(f.label)}</b>${tags}<br><span>${esc(String(f.value).slice(0, 240))}</span>`));
  }
  if (!filled.length) fl.appendChild(li("<span>Nothing filled.</span>"));

  const sk = document.createElement("ul");
  for (const s of skipped) {
    sk.appendChild(li(`<b>${esc(s.label)}</b>${s.required ? '<span class="tag req">required</span>' : ""}<br><span>${esc(s.reason)}</span>`));
  }
  if (!skipped.length) sk.appendChild(li("<span>Nothing skipped.</span>"));

  const colFilled = document.createElement("div");
  colFilled.innerHTML = `<h2>Filled <span class="pill">${filled.length}</span></h2>`;
  colFilled.appendChild(fl);
  const colSkipped = document.createElement("div");
  colSkipped.innerHTML = `<h2>Skipped <span class="pill">${skipped.length}</span></h2>`;
  colSkipped.appendChild(sk);
  cols.append(colFilled, colSkipped);
  card.appendChild(cols);

  const notes = document.createElement("div");
  notes.className = "notes";
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
  card.appendChild(notes);

  const shots = document.createElement("div");
  shots.className = "shots";
  for (const s of r.screenshots || []) {
    const b = document.createElement("button");
    b.className = "ghost";
    b.textContent = `Open ${s.split(/[\\/]/).pop()}`;
    b.addEventListener("click", () => window.seekr.openPath(s));
    shots.appendChild(b);
  }
  card.appendChild(shots);

  $("results").appendChild(card);
}
