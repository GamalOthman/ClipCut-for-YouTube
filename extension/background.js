// Background service worker: talks to the helper on the PC (native messaging), runs a queue
// of downloads one at a time, shows progress on the toolbar icon, notifies when done,
// and adds "Download whole video" to the right-click menu on YouTube links.

const HOST = "com.ytclip.helper";
let port = null;            // connection to the helper (keeps this worker alive while open)
let info = null;            // last helper status (tools, settings)
let infoTime = 0;
let nextReq = 1;
const pending = new Map();  // request id -> {resolve, timer}

let current = null;         // the running download
const queue = [];           // waiting downloads
let last = null;            // the last finished download (ok / error / cancelled)
let lastSeen = true;        // has the popup shown the last result?
let nextJob = 1;
const notified = new Map(); // notification id -> file path

// ---- helper connection ----------------------------------------------------------------
function hostError(message) {
  const m = message || "";
  if (/not found/i.test(m)) return "The helper isn't installed. Run Setup.bat, then reload this page.";
  if (/forbidden/i.test(m)) return "The helper doesn't accept this extension. Run Setup.bat again.";
  if (/exited/i.test(m)) return "The helper stopped unexpectedly. Run Setup.bat again.";
  return "Helper error: " + m;
}

function getPort() {
  if (port) return port;
  port = chrome.runtime.connectNative(HOST);
  port.onMessage.addListener(onHostMessage);
  port.onDisconnect.addListener(() => {
    const err = hostError((chrome.runtime.lastError && chrome.runtime.lastError.message) || "Native host has exited.");
    port = null;
    info = null;
    for (const p of pending.values()) { clearTimeout(p.timer); p.resolve({ ok: false, error: err }); }
    pending.clear();
    if (current) finish("error", null, err);
  });
  return port;
}

function onHostMessage(m) {
  if (m.type === "reply") {
    const p = pending.get(m.id);
    if (p) {
      pending.delete(m.id);
      clearTimeout(p.timer);
      if (m.settings) { info = { ok: true, ...m }; infoTime = Date.now(); }
      p.resolve({ ok: m.ok !== false, ...m, error: m.ok === false ? m.message : undefined });
    }
    return;
  }
  if (!current) return;
  if (m.type === "progress") {
    current.pct = m.pct;
    current.stage = m.stage;
    current.detail = m.detail || "";
    current.text = null;
  } else if (m.type === "status") {
    current.text = m.text;
  } else if (m.type === "done") {
    finish(m.result, m.file, m.message);
    return;
  } else {
    return;
  }
  update();
}

function request(msg, timeout = 15000) {
  return new Promise((resolve) => {
    const id = nextReq++;
    const timer = setTimeout(() => {
      pending.delete(id);
      resolve({ ok: false, error: "The helper didn't answer. Run Setup.bat again." });
    }, timeout);
    pending.set(id, { resolve, timer });
    try {
      getPort().postMessage({ ...msg, id });
    } catch (e) {
      clearTimeout(timer);
      pending.delete(id);
      resolve({ ok: false, error: hostError(e.message) });
    }
  });
}

async function ping() {
  if (info && Date.now() - infoTime < 20000) return info;
  const answer = await request({ type: "ping" });
  if (answer.ok) { info = answer; infoTime = Date.now(); }
  return answer;
}

// ---- queue ------------------------------------------------------------------------------
async function cookieText() {
  const cookies = await chrome.cookies.getAll({ domain: "youtube.com" });
  const lines = ["# Netscape HTTP Cookie File"];
  for (const c of cookies) {
    const sub = c.domain.startsWith(".") ? "TRUE" : "FALSE";
    const exp = c.expirationDate ? Math.floor(c.expirationDate) : 0;
    lines.push([c.domain, sub, c.path, c.secure ? "TRUE" : "FALSE", exp, c.name, c.value].join("\t"));
  }
  return lines.join("\n") + "\n";
}

function enqueue(msg) {
  const job = {
    id: nextJob++, vid: msg.vid, url: "https://www.youtube.com/watch?v=" + msg.vid,
    start: msg.start ?? null, end: msg.end ?? null, duration: msg.duration ?? null,
    mode: msg.mode || null, live: msg.live || null, diag: msg.diag || null,
    title: msg.title || "YouTube video", label: msg.label || "whole video",
    state: "queued", pct: null, stage: "", detail: "", text: null, file: null,
  };
  queue.push(job);
  startNext();
  update();
  return { ok: true, id: job.id, position: current === job ? 0 : queue.indexOf(job) + 1 };
}

async function startNext() {
  if (current || !queue.length) return;
  current = queue.shift();
  current.state = "running";
  current.stage = "Starting";
  update();
  const job = current;
  let cookies = "";
  try { cookies = await cookieText(); } catch (e) { /* download without sign-in */ }
  if (current !== job) return;   // cancelled meanwhile
  try {
    getPort().postMessage({
      type: "download", url: job.url, start: job.start, end: job.end, duration: job.duration,
      mode: job.mode, live: job.live, diag: job.diag, cookies,
    });
  } catch (e) {
    finish("error", null, hostError(e.message));
  }
}

function finish(result, file, message) {
  const job = current;
  if (!job) return;
  current = null;
  job.state = result;                 // "ok" | "error" | "cancelled"
  job.file = file || null;
  job.text = result === "ok" ? null : (message || (result === "cancelled" ? "Cancelled." : "Download failed."));
  if (result === "ok") job.pct = 100;
  last = job;
  lastSeen = false;
  notify(job);
  update();
  startNext();
}

function cancel(id) {
  if (current && (id == null || id === current.id)) {
    if (port) port.postMessage({ type: "cancel" });
    else finish("cancelled", null, null);
    return;
  }
  const i = queue.findIndex((j) => j.id === id);
  if (i >= 0) { queue.splice(i, 1); update(); }
}

// ---- what the user sees: badge, notification, open popup ---------------------------------
function snapshot() {
  const pick = (j) => j && { id: j.id, vid: j.vid, title: j.title, label: j.label, state: j.state, pct: j.pct,
    stage: j.stage, detail: j.detail, text: j.text, file: j.file };
  return { current: pick(current), queue: queue.map(pick), last: pick(last) };
}

let badgeTimer = null;
function update() {
  let text = "", color = "#d93025";
  if (current) {
    text = typeof current.pct === "number" ? Math.floor(current.pct) + "%" : "...";
  } else if (last && !lastSeen) {
    if (last.state === "ok") { text = "✓"; color = "#188038"; }
    else if (last.state === "error") { text = "!"; }
  }
  chrome.action.setBadgeBackgroundColor({ color }).catch(() => {});
  chrome.action.setBadgeText({ text }).catch(() => {});
  clearTimeout(badgeTimer);
  if (!current && last && last.state === "ok" && !lastSeen) {
    badgeTimer = setTimeout(() => { lastSeen = true; update(); }, 60000);
  }
  chrome.runtime.sendMessage({ type: "jobs", jobs: snapshot() }).catch(() => {});
}

async function notify(job) {
  if (job.state === "cancelled") return;
  const { notify: on } = await chrome.storage.local.get({ notify: true });
  if (!on) return;
  const id = "ytclip-" + job.id;
  const name = job.file ? job.file.split(/[\\/]/).pop() : job.title;
  chrome.notifications.create(id, {
    type: "basic", iconUrl: "icons/icon128.png", priority: 1,
    title: job.state === "ok" ? "Clip saved" : "Download failed",
    message: job.state === "ok" ? name + "\nClick to show it in the folder." : (job.title + "\n" + (job.text || "")),
  }).catch(() => {});
  if (job.state === "ok") notified.set(id, job.file || "");
}

chrome.notifications.onClicked.addListener((id) => {
  if (!notified.has(id)) return;
  try { getPort().postMessage({ type: "open", path: notified.get(id) }); } catch (e) { /* ignore */ }
  chrome.notifications.clear(id);
});

// ---- right-click menu -------------------------------------------------------------------
function videoIdFrom(url) {
  try {
    const u = new URL(url);
    if (u.hostname === "youtu.be") return u.pathname.slice(1, 12) || null;
    if (u.pathname === "/watch") return u.searchParams.get("v");
    const m = u.pathname.match(/^\/(?:shorts|live)\/([\w-]{6,})/);
    return m ? m[1] : null;
  } catch (e) { return null; }
}

chrome.runtime.onInstalled.addListener(() => {
  chrome.contextMenus.removeAll(() => {
    chrome.contextMenus.create({
      id: "ytclip-link", title: "Download whole video with ClipCut", contexts: ["link"],
      targetUrlPatterns: ["*://*.youtube.com/watch*", "*://*.youtube.com/shorts/*", "*://youtu.be/*"],
    });
    chrome.contextMenus.create({
      id: "ytclip-page", title: "Download whole video with ClipCut", contexts: ["page", "video"],
      documentUrlPatterns: ["*://*.youtube.com/watch*", "*://*.youtube.com/shorts/*"],
    });
  });
});

chrome.contextMenus.onClicked.addListener(async (data) => {
  const vid = videoIdFrom(data.linkUrl || data.pageUrl || "");
  if (!vid) return;
  const st = await ping();
  const mode = st && st.settings ? st.settings.mode : "video";
  const title = data.linkUrl ? (data.selectionText || "YouTube video " + vid) : "YouTube video " + vid;
  enqueue({ vid, mode, title, label: "whole video" });
});

// ---- messages from the popup, the page and the Settings page ----------------------------
chrome.runtime.onMessage.addListener((msg, sender, send) => {
  switch (msg.type) {
    case "hello":
      if (msg.from === "popup" && last && !current) { lastSeen = true; update(); }
      ping().then((answer) => send({ info: answer, jobs: snapshot() }));
      return true;
    case "download":
      send(enqueue(msg));
      return false;
    case "cancel":
      cancel(msg.id ?? null);
      send({ ok: true });
      return false;
    case "clear_last":
      last = null; lastSeen = true; update();
      send({ ok: true });
      return false;
    case "open":
      try { getPort().postMessage({ type: "open", path: msg.path ?? ((last && last.file) || "") }); } catch (e) { /* ignore */ }
      send({ ok: true });
      return false;
    case "open_options":
      chrome.runtime.openOptionsPage();
      send({ ok: true });
      return false;
    case "get_settings":
      request({ type: "get_settings" }).then(send);
      return true;
    case "set_settings":
      info = null;
      request({ type: "set_settings", settings: msg.settings }).then(send);
      return true;
    case "choose_folder":
      request({ type: "choose_folder" }, 15 * 60 * 1000).then(send);
      return true;
    case "update_tools":
      request({ type: "update_tools" }, 11 * 60 * 1000).then(send);
      return true;
    default:
      return false;
  }
});
