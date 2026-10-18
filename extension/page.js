// Runs inside the YouTube page itself (not the extension's sandbox) so it can ask
// YouTube's player for live-stream details. The panel (content.js) asks through a
// "ytclip-req" event and gets the answer back as a "ytclip-res" event (JSON text).
(() => {
  if (window.__ytclipPage) return;
  window.__ytclipPage = true;

  const num = (x) => (typeof x === "number" && isFinite(x) ? x : null);

  window.addEventListener("ytclip-req", (e) => {
    let out;
    try {
      const p = document.getElementById("movie_player") || document.querySelector(".html5-video-player");
      const v = p ? p.querySelector("video") : document.querySelector("video");
      const pr = (p && typeof p.getPlayerResponse === "function" && p.getPlayerResponse()) || window.ytInitialPlayerResponse || {};
      const vd = pr.videoDetails || {};
      const lb = (pr.microformat && pr.microformat.playerMicroformatRenderer &&
                  pr.microformat.playerMicroformatRenderer.liveBroadcastDetails) || {};
      let ps = null;
      try { ps = p && typeof p.getProgressState === "function" ? p.getProgressState() : null; } catch (err) { ps = null; }
      const seek = v && v.seekable && v.seekable.length ? v.seekable : null;
      out = {
        videoId: vd.videoId || null,
        isLive: !!vd.isLive,
        isLiveContent: !!vd.isLiveContent,
        isLiveNow: !!lb.isLiveNow,
        startTimestamp: lb.startTimestamp || null,
        endTimestamp: lb.endTimestamp || null,
        current: v ? num(v.currentTime) : null,
        duration: v ? num(v.duration) : null,
        seekStart: seek ? num(seek.start(0)) : null,
        seekEnd: seek ? num(seek.end(seek.length - 1)) : null,
        ad: !!(p && p.classList.contains("ad-showing")),
        ps: ps ? {
          current: num(ps.current), seekableStart: num(ps.seekableStart), seekableEnd: num(ps.seekableEnd),
          ingestionTime: num(ps.ingestionTime), isAtLiveHead: !!ps.isAtLiveHead, duration: num(ps.duration),
        } : null,
        now: Date.now() / 1000,
      };
    } catch (err) {
      out = { error: String(err) };
    }
    window.dispatchEvent(new CustomEvent("ytclip-res", { detail: JSON.stringify({ id: e.detail, ...out }) }));
  });
})();
