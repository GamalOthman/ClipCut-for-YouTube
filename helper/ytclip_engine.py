"""
Download engine for ClipCut for YouTube.

Builds yt-dlp / ffmpeg commands, stores settings, reads progress lines and turns
known errors into plain-language hints. No window code: the browser helper
(ytclip_host.py) uses it. Tools installed by Setup live in %LOCALAPPDATA%\\ClipCut\\bin.
"""

import json
import os
import re
import shutil
import subprocess
from pathlib import Path

IS_WINDOWS = os.name == "nt"
NO_WINDOW = subprocess.CREATE_NO_WINDOW if IS_WINDOWS else 0

HOME_DIR = Path(os.environ.get("LOCALAPPDATA") or (Path.home() / ".local" / "share")) / "ClipCut"
BIN_DIR = HOME_DIR / "bin"
SETTINGS_FILE = HOME_DIR / "settings.json"
STATE_FILE = HOME_DIR / "state.json"
TOOLS_FILE = HOME_DIR / "tools.json"      # written by Setup: which programs to use

# ---- choices and defaults ---------------------------------------------------------
RESOLUTIONS = ["Best", "2160p", "1440p", "1080p", "720p", "480p", "360p"]
CONTAINERS = ["mp4", "mkv"]
AUDIO_FORMATS = ["mp3", "m4a"]
AUDIO_BITRATES = ["128", "192", "256", "320"]
COMPRESS_LEVELS = {"Light": 23, "Medium": 28, "Strong": 32}   # x264 CRF values

DEFAULTS = {
    "mode": "video",
    "max_res": "1080p",
    "container": "mp4",
    "prefer_h264": True,
    "audio_format": "mp3",
    "audio_bitrate": "192",
    "precise_cut": False,
    "compress": False,
    "compress_level": "Medium",
    "dest": str(Path.home() / "Downloads" / "YouTube Clips"),
}
CHOICES = {
    "mode": ["video", "audio"], "max_res": RESOLUTIONS, "container": CONTAINERS,
    "audio_format": AUDIO_FORMATS, "audio_bitrate": AUDIO_BITRATES,
    "compress_level": list(COMPRESS_LEVELS),
}

FRAGMENTS = "8"   # pieces downloaded at the same time (YouTube often sends hundreds of small pieces)
PCT_RE = re.compile(r"^\[download\]\s+(\d+(?:\.\d+)?)%")
SPEED_RE = re.compile(r"\bat\s+(~?\s*[\d.]+\s*[KMG]i?B/s)")
ETA_RE = re.compile(r"\bETA\s+(\d[\d:]*)")
FF_TIME_RE = re.compile(r"time=(\d+):(\d+):(\d+(?:\.\d+)?)")
FF_SIZE_RE = re.compile(r"size=\s*(\d+(?:\.\d+)?)\s*(KiB|kB|MiB|MB|GiB|GB|B)\b", re.I)
_SIZE_UNITS = {"b": 1, "kib": 1024, "kb": 1000, "mib": 1024 ** 2, "mb": 1000 ** 2, "gib": 1024 ** 3, "gb": 1000 ** 3}


# ---- tools --------------------------------------------------------------------------
_tools = {}


def use_tools():
    """Read tools.json from Setup and put those programs' folders first on PATH,
    so yt-dlp also finds the same ffmpeg and deno."""
    global _tools
    try:
        _tools = json.loads(TOOLS_FILE.read_text(encoding="utf-8"))
    except (OSError, ValueError):
        _tools = {}
    dirs = []
    for name in ("ffmpeg", "deno", "yt-dlp"):
        p = _tools.get(name)
        if isinstance(p, str) and Path(p).exists() and str(Path(p).parent) not in dirs:
            dirs.append(str(Path(p).parent))
    os.environ["PATH"] = os.pathsep.join(dirs + [str(BIN_DIR), os.environ.get("PATH", "")])


def tool(name):
    """Full path of a program: the one Setup chose, else whatever is on PATH."""
    p = _tools.get(name)
    if isinstance(p, str) and Path(p).exists():
        return p
    return shutil.which(name)


def ytdlp_update_cmd():
    """How to update the yt-dlp in use (pip for a pip install, otherwise yt-dlp -U); None if unknown."""
    c = _tools.get("ytdlp_update")
    if isinstance(c, list) and c and Path(str(c[0])).exists():
        return [str(x) for x in c]
    b = bundled_ytdlp()
    return [str(b), "-U"] if b else None


def bundled_ytdlp():
    p = BIN_DIR / ("yt-dlp.exe" if IS_WINDOWS else "yt-dlp")
    return p if p.exists() else None


# ---- settings and small state -------------------------------------------------------
def _clean(data, base):
    s = dict(base)
    if not isinstance(data, dict):
        return s
    for key, default in DEFAULTS.items():
        value = data.get(key)
        if isinstance(value, type(default)) and value in CHOICES.get(key, [value]):
            if key == "dest" and not value.strip():
                continue
            s[key] = value
    return s


def load_settings():
    try:
        data = json.loads(SETTINGS_FILE.read_text(encoding="utf-8"))
    except (OSError, ValueError):
        data = {}
    return _clean(data, DEFAULTS)


def save_settings(changes):
    """Merge changes into the saved settings; returns the result."""
    s = _clean(changes, load_settings())
    try:
        SETTINGS_FILE.parent.mkdir(parents=True, exist_ok=True)
        SETTINGS_FILE.write_text(json.dumps(s, indent=2, ensure_ascii=False), encoding="utf-8")
    except OSError:
        pass
    return s


def load_state():
    try:
        return json.loads(STATE_FILE.read_text(encoding="utf-8"))
    except (OSError, ValueError):
        return {}


def save_state(**changes):
    st = load_state()
    st.update(changes)
    try:
        STATE_FILE.parent.mkdir(parents=True, exist_ok=True)
        STATE_FILE.write_text(json.dumps(st, indent=2), encoding="utf-8")
    except OSError:
        pass
    return st


# ---- time helpers ---------------------------------------------------------------------
def clock(sec):
    """Seconds -> H:MM:SS.mmm (what yt-dlp receives)."""
    h, rem = divmod(sec, 3600)
    m, s = divmod(rem, 60)
    return f"{int(h)}:{int(m):02d}:{s:06.3f}"


def label(sec):
    """Seconds -> short label like 1m30s or 1h02m03s (used in file names)."""
    sec = int(sec)
    h, rem = divmod(sec, 3600)
    m, s = divmod(rem, 60)
    if h:
        return f"{h}h{m:02d}m{s:02d}s"
    return f"{m}m{s:02d}s" if m else f"{s}s"


def hms_to_sec(match):
    return int(match.group(1)) * 3600 + int(match.group(2)) * 60 + float(match.group(3))


def probe_duration(path):
    """Length of a media file in seconds using ffprobe; None if unknown."""
    ffprobe = tool("ffprobe")
    if not ffprobe:
        return None
    try:
        out = subprocess.run([ffprobe, "-v", "error", "-show_entries", "format=duration",
                              "-of", "default=nw=1:nk=1", str(path)], capture_output=True,
                             text=True, timeout=30, creationflags=NO_WINDOW).stdout.strip()
        return float(out) or None
    except (OSError, ValueError, subprocess.SubprocessError):
        return None


# ---- commands -------------------------------------------------------------------------
def build_command(ytdlp, s, url, start, end, path_file, cookies_file=None, live_now=False):
    cmd = [ytdlp, "--ignore-config", "--no-plugin-dirs", "--newline", "--no-playlist",
           "--no-mtime", "--force-overwrites", "--concurrent-fragments", FRAGMENTS]
    if cookies_file:
        cmd += ["--cookies", cookies_file]
    if live_now:
        cmd.append("--live-from-start")   # stream still running: times count from its start

    name_tag = ""
    if start is not None or end is not None:
        a = start or 0.0
        b = clock(end) if end is not None else "inf"
        cmd += ["--download-sections", f"*{clock(a)}-{b}"]
        name_tag = f" [{label(a)}-{label(end) if end is not None else 'end'}]"
        if s["precise_cut"]:
            cmd.append("--force-keyframes-at-cuts")

    if s["mode"] == "audio":
        fmt = s["audio_format"]
        codec = "mp3" if fmt == "mp3" else "mp4a"
        cmd += ["-f", f"ba[acodec^={codec}]/ba/b", "-x", "--audio-format", fmt,
                "--audio-quality", f"{s['audio_bitrate']}K"]
    else:
        res = "res" if s["max_res"] == "Best" else "res:" + s["max_res"].rstrip("p")
        if s["prefer_h264"]:
            sort = f"vcodec:h264,lang,{res},quality,fps,hdr:12,acodec:aac"
        else:
            sort = f"lang,{res},quality,fps"
        cmd += ["-S", sort, "--merge-output-format", s["container"],
                "--remux-video", s["container"]]

    cmd += ["-P", s["dest"], "-o", f"%(title).150B{name_tag}.%(ext)s",
            "--print-to-file", "after_move:filepath", path_file, url]
    return cmd


def compress_command(ffmpeg, src, tmp, crf):
    """ffmpeg command that re-encodes src into tmp with x264 at the given CRF."""
    cmd = [ffmpeg, "-hide_banner", "-loglevel", "error", "-stats", "-y", "-i", str(src),
           "-c:v", "libx264", "-crf", str(crf), "-preset", "medium", "-c:a", "aac", "-b:a", "128k"]
    if Path(src).suffix.lower() == ".mp4":
        cmd += ["-movflags", "+faststart"]
    cmd.append(str(tmp))
    return cmd


# ---- reading output ---------------------------------------------------------------------
SLOW_NOTE = "YouTube is slowing this (puzzle not solved)"
RELOAD_HINT = "YouTube rejected the request. Reload the YouTube page, check you are logged in, and try again."


def hint_for(line):
    """A plain-language fix for a known yt-dlp error line, or None."""
    low = line.lower()
    if "not a bot" in low or "sign in to confirm" in low:
        return "YouTube wants a sign-in. Log in to YouTube in this browser, then try again."
    if "challenge solving failed" in low or "javascript runtime" in low:
        return "YouTube's puzzle couldn't be solved. Open Settings and click Update tools."
    if "page needs to be reloaded" in low:
        return RELOAD_HINT
    if "requested format is not available" in low:
        return "That quality isn't available for this video. Choose another max resolution in Settings."
    if "private video" in low or "members-only" in low or "join this channel" in low:
        return "This video is private or for channel members only."
    if "live event will begin" in low or "premieres in" in low:
        return "This stream hasn't started yet."
    if "live-from-start" in low or "not available from the start" in low:
        return "YouTube no longer keeps that part of the stream. Wait until the stream ends, then download it."
    return None


def read_progress(line, total):
    """A yt-dlp or ffmpeg progress line -> (percent or None, detail text). None if it isn't one.
    total = expected length in seconds, used to turn ffmpeg's time into a percentage."""
    m = PCT_RE.match(line)
    if m:
        bits = []
        s, e = SPEED_RE.search(line), ETA_RE.search(line)
        if s:
            bits.append("at " + s.group(1).replace(" ", ""))
        if e and e.group(1).strip("0:"):
            bits.append(e.group(1) + " left")
        return float(m.group(1)), ", ".join(bits)
    if line.startswith(("frame=", "size=")):   # ffmpeg (used for clips)
        m = FF_TIME_RE.search(line)
        if not m:
            return None
        done = hms_to_sec(m)
        if total:
            return min(100.0, done / total * 100), ""
        return None, f"{label(done)} done"
    return None


def ffmpeg_bytes(line):
    """Bytes received so far, from an ffmpeg progress line (its size= field); None if missing."""
    m = FF_SIZE_RE.search(line)
    if not m:
        return None
    return float(m.group(1)) * _SIZE_UNITS.get(m.group(2).lower(), 1)


class SpeedMeter:
    """Turns ffmpeg's growing size= value into 'at 2.31MiB/s, 01:20 left' (yt-dlp's own style)."""

    def __init__(self):
        self.samples = []      # (seconds, bytes)
        self.t0 = None

    def detail(self, now, size, pct):
        if self.t0 is None:
            self.t0 = now
        self.samples.append((now, size))
        while len(self.samples) > 2 and now - self.samples[0][0] > 5:   # average over ~5 s
            self.samples.pop(0)
        bits = []
        t_old, s_old = self.samples[0]
        if now - t_old >= 1 and size >= s_old:
            rate = (size - s_old) / (now - t_old)
            bits.append(f"at {rate / 1024 ** 2:.2f}MiB/s")
        if pct and 1 <= pct < 100 and now - self.t0 >= 3:
            left = int((now - self.t0) * (100 - pct) / pct)
            bits.append(f"{left // 60:02d}:{left % 60:02d} left" if left < 3600 else
                        f"{left // 3600}:{left % 3600 // 60:02d}:{left % 60:02d} left")
        return ", ".join(bits)


def is_summary(line):
    """yt-dlp's final '[download] 100% of 50MiB in 00:00:12 at 4MiB/s' line, worth logging."""
    return bool(PCT_RE.match(line)) and " in " in line and line.split("%")[0].strip().endswith("100")
