// Settings page: reads and saves settings through the helper (via background.js).
const FIELDS = ["mode", "max_res", "container", "prefer_h264", "precise_cut", "compress",
                "compress_level", "audio_format", "audio_bitrate"];
const LABELS = { compress_level: { Light: "Light", Medium: "Medium", Strong: "Strong" } };
const $ = (id) => document.getElementById(id);

function call(msg) {
  return new Promise((resolve) => {
    chrome.runtime.sendMessage(msg, (answer) => {
      if (chrome.runtime.lastError) resolve({ ok: false, error: chrome.runtime.lastError.message });
      else resolve(answer || { ok: false, error: "No answer." });
    });
  });
}

function fillChoices(choices) {
  for (const [key, list] of Object.entries(choices || {})) {
    const el = $(key);
    if (!el || el.tagName !== "SELECT" || key === "mode") continue;
    el.innerHTML = "";
    for (const v of list) {
      const o = document.createElement("option");
      o.value = v;
      o.textContent = (LABELS[key] && LABELS[key][v]) || v;
      el.appendChild(o);
    }
  }
}

function show(answer) {
  if (!answer.ok && !answer.settings) {
    $("error").textContent = answer.error || answer.message || "The helper isn't answering. Run Setup.bat again.";
    return;
  }
  $("error").textContent = "";
  const s = answer.settings || {};
  for (const k of FIELDS) {
    const el = $(k);
    if (!el || !(k in s)) continue;
    if (el.type === "checkbox") el.checked = !!s[k]; else el.value = s[k];
  }
  $("dest").value = s.dest || "";
  $("compress_level").disabled = !$("compress").checked;
  const t = answer.tools || {};
  const parts = ["yt-dlp", "ffmpeg", "deno"].map((n) => `${n}: ${t[n] ? "found" : "MISSING"}`);
  $("tools").innerHTML = "";
  const line = document.createElement("div");
  line.textContent = parts.join(" · ") + (answer.ytdlp_version ? `   (yt-dlp ${answer.ytdlp_version})` : "");
  line.className = ["yt-dlp", "ffmpeg", "deno"].every((n) => t[n]) ? "ok" : "err";
  $("tools").appendChild(line);
  for (const [n, p] of Object.entries(answer.tool_paths || {})) {
    if (!p) continue;
    const d = document.createElement("div");
    d.className = "muted";
    d.textContent = `${n}: ${p}`;
    $("tools").appendChild(d);
  }
}

let savedTimer;
async function save(changes) {
  const answer = await call({ type: "set_settings", settings: changes });
  show(answer);
  $("saved").textContent = answer.ok ? "Saved." : "";
  clearTimeout(savedTimer);
  savedTimer = setTimeout(() => { $("saved").textContent = ""; }, 1500);
}

for (const k of FIELDS) {
  $(k).addEventListener("change", (e) => {
    const el = e.target;
    save({ [k]: el.type === "checkbox" ? el.checked : el.value });
  });
}

$("choose").addEventListener("click", async () => {
  $("choose").disabled = true;
  $("saved").textContent = "A folder window opened (it may be behind this browser window).";
  const answer = await call({ type: "choose_folder" });
  $("choose").disabled = false;
  show(answer);
  $("saved").textContent = answer.chosen ? "Saved." : "";
});

$("update").addEventListener("click", async () => {
  $("update").disabled = true;
  $("upd").className = "muted";
  $("upd").textContent = "Updating… (up to a minute)";
  const answer = await call({ type: "update_tools" });
  $("update").disabled = false;
  if (answer.settings) show(answer);
  $("upd").className = answer.ok ? "ok" : "err";
  $("upd").textContent = answer.message || answer.error || (answer.ok ? "Done." : "Update failed.");
});

// stored in the browser, not by the helper
chrome.storage.local.get({ notify: true }, (d) => { $("notify").checked = !!d.notify; });
$("notify").addEventListener("change", () => {
  chrome.storage.local.set({ notify: $("notify").checked });
  $("saved").textContent = "Saved.";
  clearTimeout(savedTimer);
  savedTimer = setTimeout(() => { $("saved").textContent = ""; }, 1500);
});

(async () => {
  const answer = await call({ type: "get_settings" });
  fillChoices(answer.choices);
  show(answer);
})();
