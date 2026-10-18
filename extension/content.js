// Runs on youtube.com. Adds a small scissors button to the video player (styled like
// YouTube's own buttons) with a tiny menu, the [ and ] keys, a short message when you mark,
// and a yellow band on the progress bar for the marked part. Nothing else appears on the
// page unless you use it. The toolbar drop-down (popup.js) controls the same marks.
(() => {
  if (window.__ytclipLoaded) return;
  window.__ytclipLoaded = true;

  const st = { vid: null, start: null, end: null, live: null, offset: 0, diag: {}, mode: null, previewEnd: null };
  const NOT_LIVE = "A clip can't be cut while the stream is still live. You can download it after the stream ends.";

  // ---- helpers -------------------------------------------------------------
  const alive = () => { try { return !!chrome.runtime.id; } catch (e) { return false; } };

  function send(msg) {
    return new Promise((resolve) => {
      if (!alive()) return resolve({ ok: false, error: "The extension was updated. Reload this page." });
      try {
        chrome.runtime.sendMessage(msg, (answer) => {
          if (chrome.runtime.lastError) resolve({ ok: false, error: chrome.runtime.lastError.message });
          else resolve(answer || {});
        });
      } catch (e) {
        resolve({ ok: false, error: "The extension was updated. Reload this page." });
      }
    });
  }

  function videoId() {
    const u = new URL(location.href);
    if (u.pathname === "/watch") return u.searchParams.get("v");
    const m = u.pathname.match(/^\/(?:shorts|live)\/([\w-]{6,})/);
    return m ? m[1] : null;
  }
  const isShorts = () => location.pathname.startsWith("/shorts/");

  function getPlayer() {
    if (isShorts()) {
      return document.querySelector("ytd-reel-video-renderer[is-active] .html5-video-player") ||
             document.querySelector("#shorts-player");
    }
    return document.getElementById("movie_player");
  }
  function getVideo() {
    const p = getPlayer();
    return (p && p.querySelector("video")) || document.querySelector("video");
  }

  function fmt(sec) {
    if (sec == null) return "--:--";
    const t = Math.max(0, sec);
    const h = Math.floor(t / 3600), m = Math.floor((t % 3600) / 60), s = t % 60;
    const ss = s.toFixed(1).padStart(4, "0");
    return h ? `${h}:${String(m).padStart(2, "0")}:${ss}` : `${m}:${ss}`;
  }
  const title = () => document.title.replace(/^\(\d+\)\s*/, "").replace(/\s*-\s*YouTube\s*$/, "") || "YouTube video";

  // Ask page.js (inside the YouTube page) for the player's live-stream details.
  let reqId = 0;
  function askPage() {
    return new Promise((resolve) => {
      const id = String(++reqId);
      const onRes = (e) => {
        let data;
        try { data = JSON.parse(e.detail); } catch (err) { return; }
        if (data.id !== id) return;
        window.removeEventListener("ytclip-res", onRes);
        clearTimeout(timer);
        resolve(data);
      };
      const timer = setTimeout(() => { window.removeEventListener("ytclip-res", onRes); resolve(null); }, 600);
      window.addEventListener("ytclip-res", onRes);
      window.dispatchEvent(new CustomEvent("ytclip-req", { detail: id }));
    });
  }

  // Position as yt-dlp counts it. On a stream that is live now, the video element's time can
  // count from when *this player* started, not from the stream start.
  function streamPosition(i) {
    const liveNow = i.isLiveNow || i.isLive;
    if (!liveNow) return { pos: i.current, method: i.isLiveContent ? "replay" : "video" };
    const startTs = i.startTimestamp ? Date.parse(i.startTimestamp) / 1000 : null;
    const ing = i.ps && i.ps.ingestionTime;
    if (startTs && ing && ing > startTs && ing <= i.now + 60) return { pos: ing - startTs, method: "ingestion" };
    if (startTs && i.seekEnd != null && i.current != null) {
      const behind = Math.max(0, i.seekEnd - i.current);
      const clockPos = i.now - startTs - behind;
      if (Math.abs(i.current - clockPos) < 120) return { pos: i.current, method: "media" };
      return { pos: Math.max(0, clockPos), method: "clock" };
    }
    return { pos: i.current, method: "media-only" };
  }
  // stream position -> the video element's own time (they differ only on live-now streams)
  const mediaTime = (pos) => (st.live === "now" ? pos - st.offset : pos);

  // ---- styles for the few things we put on the page -----------------------------------------
  const style = document.createElement("style");
  style.id = "ytclip-style";
  style.textContent = `
    .ytclip-btn { display:inline-flex !important; align-items:center; justify-content:center; vertical-align:top;
      background:transparent !important; border:0 !important; box-shadow:none !important; }
    .ytclip-btn svg { width:100%; height:100%; }
    .ytclip-btn.has-marks svg .blade { stroke:#ffc400; }
    .ytclip-float { position:absolute; top:10px; left:10px; z-index:61; width:36px; height:36px; border:0; border-radius:50%;
      background:rgba(0,0,0,.55); cursor:pointer; opacity:0; transition:opacity .2s; padding:4px; }
    .html5-video-player:hover .ytclip-float, .ytclip-float.has-marks { opacity:1; }
    .ytclip-menu { position:absolute; z-index:70; min-width:230px; direction:ltr; text-align:left; background:rgba(28,28,28,.94); color:#fff;
      border-radius:12px; padding:8px 0; font:13px/1.3 Roboto, Arial, sans-serif; box-shadow:0 4px 18px rgba(0,0,0,.5);
      text-shadow:none; }
    .ytclip-menu button { all:unset; box-sizing:border-box; display:flex; width:100%; align-items:center; gap:10px;
      padding:9px 16px; cursor:pointer; color:#fff; font:13px Roboto, Arial, sans-serif; }
    .ytclip-menu button:hover { background:rgba(255,255,255,.12); }
    .ytclip-menu .t { margin-left:auto; font:600 13px Consolas, "Roboto Mono", monospace; color:#ddd; }
    .ytclip-menu .go { color:#ff8a80; font-weight:600; }
    .ytclip-menu .note { padding:4px 16px 6px; font-size:11px; color:#fdd663; max-width:260px; }
    .ytclip-menu .hint { padding:6px 16px 2px; font-size:11px; color:#aaa; border-top:1px solid rgba(255,255,255,.12); margin-top:4px; }
    .ytclip-toast { position:absolute; top:10%; left:50%; direction:ltr; transform:translateX(-50%); z-index:71; max-width:80%;
      background:rgba(0,0,0,.8); color:#fff; padding:8px 14px; border-radius:8px; text-align:center;
      font:600 15px Roboto, Arial, sans-serif; pointer-events:none; transition:opacity .3s; }
    #ytclip-band { position:absolute; top:0; bottom:0; background:rgba(255,196,0,.6); pointer-events:none; z-index:40;
      border-left:2px solid #ffc400; border-right:2px solid #ffc400; }`;
  (document.head || document.documentElement).appendChild(style);

  const SCISSORS = `<svg viewBox="0 0 36 36" aria-hidden="true">
    <circle cx="11.5" cy="12.5" r="3.4" fill="none" stroke="#fff" stroke-width="2"/>
    <circle cx="11.5" cy="23.5" r="3.4" fill="none" stroke="#fff" stroke-width="2"/>
    <path class="blade" d="M14.3 14.6 L26.5 23.2 M14.3 21.4 L26.5 12.8" stroke="#fff" stroke-width="2" stroke-linecap="round"/>
  </svg>`;

  // ---- the scissors button and its menu -----------------------------------------------------
  let menu = null;

  function ensureButton() {
    const p = getPlayer();
    if (!p || !st.vid) return;
    if (p.querySelector(".ytclip-btn, .ytclip-float")) { markButton(p); return; }
    const right = !isShorts() && p.querySelector(".ytp-right-controls");
    const b = document.createElement("button");
    b.type = "button";
    b.title = "ClipCut";
    b.setAttribute("aria-label", "ClipCut");
    b.innerHTML = SCISSORS;
    if (right) {
      b.className = "ytp-button ytclip-btn";
      right.insertBefore(b, right.firstChild);
    } else {
      b.className = "ytclip-float";      // fallback when YouTube's control bar isn't there (e.g. Shorts)
      p.appendChild(b);
    }
    b.addEventListener("click", (e) => { e.stopPropagation(); e.preventDefault(); toggleMenu(b); });
    markButton(p);
  }

  function markButton(p) {
    const b = p && p.querySelector(".ytclip-btn, .ytclip-float");
    if (b) b.classList.toggle("has-marks", st.start != null || st.end != null);
  }

  function closeMenu() { if (menu) { menu.remove(); menu = null; } }

  function toggleMenu(btn) {
    if (menu) { closeMenu(); return; }
    const p = getPlayer();
    if (!p) return;
    menu = document.createElement("div");
    menu.className = "ytclip-menu";
    menu.addEventListener("click", (e) => e.stopPropagation());
    menu.addEventListener("mousedown", (e) => e.stopPropagation());
    p.appendChild(menu);
    renderMenu();
    const pr = p.getBoundingClientRect(), br = btn.getBoundingClientRect();
    if (btn.classList.contains("ytclip-float")) {
      menu.style.top = (br.bottom - pr.top + 6) + "px";
      menu.style.left = (br.left - pr.left) + "px";
    } else {
      menu.style.bottom = (pr.bottom - br.top + 8) + "px";
      menu.style.right = Math.max(8, pr.right - br.right - 60) + "px";
    }
  }

  function renderMenu() {
    if (!menu) return;
    menu.innerHTML = `
      <button data-a="start">Mark start <span class="t">${fmt(st.start)}</span></button>
      <button data-a="end">Mark end <span class="t">${fmt(st.end)}</span></button>
      ${st.live === "now" ? `<div class="note">Live stream: a clip can be cut after the stream ends.</div>` : ""}
      <button data-a="clip" class="go">Download clip</button>
      <button data-a="whole">Download whole video</button>
      ${st.start != null || st.end != null ? `<button data-a="clear">Clear marks</button>` : ""}
      <div class="hint">Keys: [ start · ] end · more in the toolbar icon</div>`;
    menu.querySelectorAll("button").forEach((b) => b.addEventListener("click", async () => {
      const a = b.dataset.a;
      if (a === "start" || a === "end") { await mark(a); renderMenu(); return; }
      if (a === "clear") { clearMarks(); renderMenu(); return; }
      closeMenu();
      const r = await download(a === "whole");
      toast(r.ok ? (r.position >= 1 ? `Added to the queue (#${r.position})` : "Download started – progress is on the extension icon") : r.error);
    }));
  }

  document.addEventListener("click", () => closeMenu(), true);
  document.addEventListener("keydown", (e) => { if (e.key === "Escape") closeMenu(); }, true);

  // ---- marks -----------------------------------------------------------------
  function toast(text) {
    const p = getPlayer();
    if (!p || !text) return;
    let t = p.querySelector(".ytclip-toast");
    if (!t) { t = document.createElement("div"); t.className = "ytclip-toast"; p.appendChild(t); }
    t.textContent = text;
    t.style.opacity = "1";
    clearTimeout(t._h);
    t._h = setTimeout(() => { t.style.opacity = "0"; }, text.length > 40 ? 3500 : 1500);
  }

  async function mark(which) {
    if (!st.vid) return { ok: false, error: "Open a YouTube video first." };
    const p = getPlayer(), v = getVideo();
    if (p && p.classList.contains("ad-showing")) { toast("Wait for the ad to finish"); return { ok: false, error: "Wait for the ad to finish." }; }
    const i = isShorts() ? null : await askPage();
    let r = null;
    if (i && !i.error && (!i.videoId || i.videoId === st.vid)) {
      if (i.ad) { toast("Wait for the ad to finish"); return { ok: false, error: "Wait for the ad to finish." }; }
      r = streamPosition(i);
      const live = i.isLiveNow || i.isLive ? "now" : (i.isLiveContent ? "replay" : null);
      if (live !== st.live) { st.live = live; st.start = st.end = null; }
      if (live === "now" && i.current != null) st.offset = r.pos - i.current;
    }
    if (!r || r.pos == null) r = { pos: v ? v.currentTime : null, method: "element" };
    if (r.pos == null) return { ok: false, error: "No video found." };
    const now = r.pos;
    if (which === "start") {
      st.start = now;
      if (st.end != null && st.end <= now) st.end = null;
      toast("Start " + fmt(now));
    } else {
      if (st.start != null && now <= st.start) { toast("End must be after the start"); return { ok: false, error: "End must be after the start." }; }
      st.end = now;
      toast("End " + fmt(now));
    }
    st.diag[which] = { pos: now, method: r.method, player: i };
    changed();
    return { ok: true };
  }

  function nudge(which, delta) {
    if (st[which] == null) return;
    const v = Math.max(0, st[which] + delta);
    if (which === "start" && st.end != null && v >= st.end) return;
    if (which === "end" && st.start != null && v <= st.start) return;
    st[which] = v;
    changed();
  }

  function jump(which) {
    const v = getVideo();
    if (!v || st[which] == null) return;
    v.currentTime = Math.max(0, mediaTime(st[which]));
  }

  function preview() {
    const v = getVideo();
    if (!v || (st.start == null && st.end == null)) return;
    v.currentTime = Math.max(0, mediaTime(st.start || 0));
    st.previewEnd = st.end != null ? mediaTime(st.end) : null;
    if (!v.__ytclipWatch) {
      v.__ytclipWatch = true;
      v.addEventListener("timeupdate", () => {
        if (st.previewEnd != null && v.currentTime >= st.previewEnd) { v.pause(); st.previewEnd = null; }
      });
      v.addEventListener("seeking", () => {   // the user moved away: stop watching for the end
        if (st.previewEnd != null && (v.currentTime < mediaTime(st.start || 0) - 1 || v.currentTime > st.previewEnd)) st.previewEnd = null;
      });
    }
    v.play().catch(() => {});
  }

  function clearMarks() { st.start = st.end = null; st.diag = {}; changed(); }

  function changed() { markButton(getPlayer()); drawBand(); renderMenu(); }

  // yellow band on the progress bar for the marked part
  function drawBand() {
    const p = getPlayer(), v = getVideo();
    const bar = p && p.querySelector(".ytp-progress-bar");
    let band = document.getElementById("ytclip-band");
    let lo = null, hi = null;
    if (v && st.live === "now" && v.seekable && v.seekable.length) {
      lo = v.seekable.start(0); hi = v.seekable.end(v.seekable.length - 1);   // the rewindable part
    } else if (v && isFinite(v.duration) && v.duration > 0) {
      lo = 0; hi = v.duration;
    }
    if (!bar || hi == null || hi <= lo || (st.start == null && st.end == null) || isShorts()) {
      if (band) band.remove();
      return;
    }
    if (!band || band.parentElement !== bar) {
      if (band) band.remove();
      band = document.createElement("div");
      band.id = "ytclip-band";
      bar.appendChild(band);
    }
    const span = hi - lo;
    const a = Math.min(Math.max(mediaTime(st.start != null ? st.start : 0), lo), hi);
    const b = Math.min(Math.max(st.end != null ? mediaTime(st.end) : (st.live === "now" ? hi : hi), lo), hi);
    band.style.left = ((a - lo) / span * 100) + "%";
    band.style.width = (Math.max(0, b - a) / span * 100) + "%";
  }

  // ---- download --------------------------------------------------------------
  async function download(whole, mode) {
    if (!st.vid) return { ok: false, error: "Open a YouTube video first." };
    if (st.live === "now") return { ok: false, error: NOT_LIVE };
    if (!whole && st.start == null && st.end == null) return { ok: false, error: "Mark a start and/or end first, or download the whole video." };
    const v = getVideo();
    const duration = v && isFinite(v.duration) && v.duration > 0 ? v.duration : null;
    if (!mode) {
      if (!st.mode) { const h = await send({ type: "hello" }); st.mode = (h.info && h.info.settings && h.info.settings.mode) || "video"; }
      mode = st.mode;
    }
    return send({
      type: "download", vid: st.vid, title: title(), mode, duration,
      start: whole ? null : st.start, end: whole ? null : st.end,
      label: whole ? "whole video" : `${fmt(st.start || 0)} – ${st.end != null ? fmt(st.end) : "end"}`,
      live: whole ? null : st.live, diag: whole ? null : st.diag,
    });
  }

  function state() {
    return { ok: true, vid: st.vid, title: st.vid ? title() : null, start: st.start, end: st.end, live: st.live };
  }

  // ---- events ----------------------------------------------------------------
  document.addEventListener("keydown", (e) => {
    if (!st.vid || e.ctrlKey || e.altKey || e.metaKey || e.shiftKey) return;
    if (e.code !== "BracketLeft" && e.code !== "BracketRight") return;   // same keys on any keyboard layout
    const el = e.composedPath()[0];
    if (el && (el.isContentEditable || /^(INPUT|TEXTAREA|SELECT)$/.test(el.tagName))) return;
    e.preventDefault();
    e.stopPropagation();
    mark(e.code === "BracketLeft" ? "start" : "end");
  }, true);

  // commands from the toolbar drop-down
  chrome.runtime.onMessage.addListener((msg, sender, reply) => {
    if (!msg || msg.type !== "cmd") return false;
    (async () => {
      let r = { ok: true };
      switch (msg.cmd) {
        case "state": break;
        case "mark": r = await mark(msg.which); break;
        case "nudge": nudge(msg.which, msg.delta); break;
        case "jump": jump(msg.which); break;
        case "preview": preview(); break;
        case "clear": clearMarks(); break;
        case "download": r = await download(!!msg.whole, msg.mode); break;
      }
      reply({ ...state(), result: r });
    })();
    return true;
  });

  // YouTube changes pages without reloading, so check twice a second.
  setInterval(() => {
    const id = videoId();
    if (id !== st.vid) {
      st.vid = id;
      st.start = st.end = null;
      st.live = null;
      st.offset = 0;
      st.diag = {};
      st.previewEnd = null;
      closeMenu();
    }
    if (id) { ensureButton(); drawBand(); }
    else { const b = document.getElementById("ytclip-band"); if (b) b.remove(); }
  }, 500);
})();
