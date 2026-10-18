// Toolbar drop-down: marks for the YouTube video in the current tab, and the download queue.
const $ = (id) => document.getElementById(id);
let tabId = null;
let vstate = null;   // marks reported by the page
let jobs = null;
let info = null;

function fmt(sec) {
  if (sec == null) return "--:--";
  const t = Math.max(0, sec);
  const h = Math.floor(t / 3600), m = Math.floor((t % 3600) / 60), s = t % 60;
  const ss = s.toFixed(1).padStart(4, "0");
  return h ? `${h}:${String(m).padStart(2, "0")}:${ss}` : `${m}:${ss}`;
}
const fileName = (p) => (p ? p.split(/[\\/]/).pop() : "");

function bg(msg) {
  return new Promise((resolve) => chrome.runtime.sendMessage(msg, (a) => {
    resolve(chrome.runtime.lastError ? { ok: false, error: chrome.runtime.lastError.message } : (a || {}));
  }));
}
function page(msg) {
  return new Promise((resolve) => {
    if (tabId == null) return resolve(null);
    chrome.tabs.sendMessage(tabId, { type: "cmd", ...msg }, (a) => resolve(chrome.runtime.lastError ? null : a));
  });
}

function setMsg(text, kind) { const m = $("vmsg"); m.textContent = text || ""; m.className = "msg " + (kind || ""); }

// ---- this video --------------------------------------------------------------------------
function renderVideo() {
  const on = vstate && vstate.vid;
  $("video").classList.toggle("hide", !on);
  $("novideo").classList.toggle("hide", !!on);
  if (!on) return;
  $("vtitle").textContent = vstate.title || "";
  $("vtitle").title = vstate.title || "";
  $("ts").textContent = fmt(vstate.start);
  $("te").textContent = fmt(vstate.end);
  $("ts").disabled = $("s-").disabled = $("s+").disabled = vstate.start == null;
  $("te").disabled = $("e-").disabled = $("e+").disabled = vstate.end == null;
  const any = vstate.start != null || vstate.end != null;
  $("preview").disabled = $("clear").disabled = !any;
  $("dl").disabled = !any;
  if (vstate.live === "now" && !$("vmsg").textContent) {
    setMsg("Live stream: times count from the stream start. A clip can be cut after the stream ends.", "warn");
  }
}

async function cmd(c, extra = {}) {
  const r = await page({ cmd: c, ...extra });
  if (!r) { setMsg("Reload the YouTube page (F5), then try again.", "err"); return null; }
  vstate = r;
  if (r.result && r.result.ok === false) setMsg(r.result.error, "err");
  else if (c !== "state") setMsg("");
  renderVideo();
  return r;
}

// ---- downloads ---------------------------------------------------------------------------
function el(tag, cls, text) { const e = document.createElement(tag); if (cls) e.className = cls; if (text != null) e.textContent = text; return e; }

function renderJobs() {
  const box = $("jobs");
  box.innerHTML = "";
  const j = jobs || {};
  if (j.current) {
    const c = j.current, d = el("div", "job");
    d.appendChild(el("div", "name", c.title)).title = c.title;
    d.appendChild(el("div", "sub", c.label));
    const bar = el("div", "bar" + (typeof c.pct === "number" ? "" : " ind"));
    const fill = el("i"); if (typeof c.pct === "number") fill.style.width = c.pct + "%";
    bar.appendChild(fill); d.appendChild(bar);
    const row = el("div", "row");
    const pct = typeof c.pct === "number" ? " " + Math.floor(c.pct) + "%" : "";
    row.appendChild(el("span", "sub", c.text || `${c.stage || "Working"}…${pct}${c.detail ? " " + c.detail : ""}`)).style.flex = "1";
    const cancel = el("button", "small", "Cancel");
    cancel.onclick = () => bg({ type: "cancel", id: c.id });
    row.appendChild(cancel); d.appendChild(row);
    box.appendChild(d);
  }
  if (j.queue && j.queue.length) {
    box.appendChild(el("div", "sub muted", "Waiting:"));
    j.queue.forEach((q, i) => {
      const r = el("div", "q");
      r.appendChild(el("span", "name", `${i + 1}. ${q.title} (${q.label})`)).title = q.title;
      const x = el("button", "small", "✕"); x.title = "Remove from the queue";
      x.onclick = () => bg({ type: "cancel", id: q.id });
      r.appendChild(x); box.appendChild(r);
    });
  }
  if (j.last) {
    const l = j.last, d = el("div", "job");
    if (l.state === "ok") {
      d.appendChild(el("div", "name ok", "Saved: " + fileName(l.file))).title = l.file || "";
      const r = el("div", "row");
      const open = el("a", "link", "Show in folder"); open.onclick = () => bg({ type: "open", path: l.file || "" });
      r.appendChild(open);
      d.appendChild(r);
    } else if (l.state === "error") {
      d.appendChild(el("div", "name", l.title)).title = l.title;
      d.appendChild(el("div", "err", l.text || "Download failed."));
    } else {
      d.appendChild(el("div", "sub", "Cancelled: " + l.title));
    }
    box.appendChild(d);
  }
  if (!j.current && !(j.queue && j.queue.length) && !j.last) box.appendChild(el("div", "empty", "Nothing downloading."));

  const t = $("tools");
  t.className = "msg";
  t.textContent = "";
  if (info && info.ok === false) { t.className = "msg err"; t.textContent = info.error || "The helper isn't answering. Run Setup.bat again."; }
  else if (info && info.tools) {
    const missing = ["yt-dlp", "ffmpeg", "deno"].filter((k) => !info.tools[k]);
    if (missing.length) { t.className = "msg err"; t.textContent = "Missing: " + missing.join(", ") + ". Run Setup.bat again."; }
    else if (info.settings) {
      const s = info.settings;
      t.className = "msg muted";
      t.textContent = `${$("mode").value === "audio" ? s.audio_format + " " + s.audio_bitrate + " kbps" : s.max_res + " " + s.container} → ${info.dest_name || s.dest}`;
    }
  }
}

chrome.runtime.onMessage.addListener((msg) => {
  if (msg && msg.type === "jobs") { jobs = msg.jobs; renderJobs(); }
});

// ---- buttons -----------------------------------------------------------------------------
$("settings").onclick = () => { chrome.runtime.openOptionsPage(); window.close(); };
$("ms").onclick = () => cmd("mark", { which: "start" });
$("me").onclick = () => cmd("mark", { which: "end" });
$("ts").onclick = () => cmd("jump", { which: "start" });
$("te").onclick = () => cmd("jump", { which: "end" });
$("s-").onclick = () => cmd("nudge", { which: "start", delta: -1 });
$("s+").onclick = () => cmd("nudge", { which: "start", delta: 1 });
$("e-").onclick = () => cmd("nudge", { which: "end", delta: -1 });
$("e+").onclick = () => cmd("nudge", { which: "end", delta: 1 });
$("preview").onclick = () => cmd("preview");
$("clear").onclick = () => cmd("clear");
$("mode").onchange = renderJobs;
async function download(whole) {
  const r = await cmd("download", { whole, mode: $("mode").value });
  if (r && r.result && r.result.ok) setMsg(r.result.position >= 1 ? `Added to the queue (#${r.result.position}).` : "Download started.", "ok");
}
$("dl").onclick = () => download(false);
$("whole").onclick = () => download(true);

// ---- start -------------------------------------------------------------------------------
(async () => {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  const onYouTube = tab && /^https?:\/\/(www|m)\.youtube\.com\//.test(tab.url || "");
  if (onYouTube) {
    tabId = tab.id;
    const r = await page({ cmd: "state" });
    if (r) vstate = r;
    else $("novideo-text").textContent = "Reload this YouTube page (F5) so the extension can work on it.";
  }
  renderVideo();
  const h = await bg({ type: "hello", from: "popup" });
  info = h.info || (h.ok === false ? h : null);
  jobs = h.jobs || null;
  if (info && info.settings) $("mode").value = info.settings.mode || "video";
  renderJobs();
})();
