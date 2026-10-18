"""
Helper for the ClipCut for YouTube browser extension.

Edge/Chrome start this program in the background (native messaging) and talk to it
through stdin/stdout: each message is 4 bytes of length followed by JSON.
Requests that need an answer carry an "id"; the answer is {"type": "reply", "id": ...}.
Download progress is sent as "progress" / "status" / "done" messages.

Never print() here: stdout is the channel to the browser. Notes go to helper.log.
"""

import json
import os
import struct
import subprocess
import sys
import tempfile
import threading
import time
from pathlib import Path

HERE = Path(__file__).resolve().parent
sys.path.insert(0, str(HERE))      # the embeddable Python doesn't add the script folder by itself
import ytclip_engine as E          # noqa: E402

VERSION = "2.0.0"
IS_WINDOWS = os.name == "nt"
UPDATE_EVERY = 7 * 24 * 3600       # check for a new yt-dlp once a week

STDIN = sys.stdin.buffer
STDOUT = sys.stdout.buffer
sys.stdout = sys.stderr            # a stray print() must never corrupt the browser channel
if IS_WINDOWS:
    import msvcrt
    msvcrt.setmode(STDIN.fileno(), os.O_BINARY)
    msvcrt.setmode(STDOUT.fileno(), os.O_BINARY)

LOG_FILE = E.HOME_DIR / "helper.log"
out_lock = threading.Lock()


def log(text):
    try:
        LOG_FILE.parent.mkdir(parents=True, exist_ok=True)
        if LOG_FILE.exists() and LOG_FILE.stat().st_size > 1_000_000:
            LOG_FILE.write_text("", encoding="utf-8")
        with LOG_FILE.open("a", encoding="utf-8") as f:
            f.write(time.strftime("%Y-%m-%d %H:%M:%S ") + text + "\n")
    except OSError:
        pass


def send(msg):
    data = json.dumps(msg, ensure_ascii=False).encode("utf-8")
    with out_lock:
        STDOUT.write(struct.pack("<I", len(data)))
        STDOUT.write(data)
        STDOUT.flush()


def reply(req, **fields):
    send({"type": "reply", "id": req.get("id"), "ok": fields.pop("ok", True), **fields})


def read_message():
    head = STDIN.read(4)
    if len(head) < 4:
        return None
    (n,) = struct.unpack("<I", head)
    return json.loads(STDIN.read(n).decode("utf-8"))


def run_quiet(cmd, timeout=120):
    """Run a short command, return (exit code, output text)."""
    try:
        p = subprocess.run(cmd, capture_output=True, text=True, encoding="utf-8", errors="replace",
                           timeout=timeout, creationflags=E.NO_WINDOW)
        return p.returncode, (p.stdout + p.stderr).strip()
    except (OSError, subprocess.SubprocessError) as e:
        return 1, str(e)


E.use_tools()


# ---- tools and updates ------------------------------------------------------------------
tools_lock = threading.Lock()
ytdlp_version = {"value": None}
updating = {"on": False}


def tools_found():
    return {name: bool(E.tool(name)) for name in ("yt-dlp", "ffmpeg", "deno")}


def read_version():
    yt = E.tool("yt-dlp")
    if yt:
        rc, out = run_quiet([yt, "--version"], 60)
        ytdlp_version["value"] = out.splitlines()[-1] if rc == 0 and out else None


def update_ytdlp():
    """Update the yt-dlp in use (pip or yt-dlp -U, as Setup decided). Returns (ok, message)."""
    cmd = E.ytdlp_update_cmd()
    if not cmd:
        return False, "Don't know how to update yt-dlp here. Run Setup.bat again."
    with tools_lock:
        updating["on"] = True
        try:
            rc, out = run_quiet(cmd, 600)
            log("yt-dlp -U: " + out.replace("\n", " | "))
            E.save_state(last_update=time.time())
            read_version()
        finally:
            updating["on"] = False
    last = out.splitlines()[-1] if out else ""
    return rc == 0, last or ("Updated." if rc == 0 else "Update failed.")


def maybe_auto_update():
    st = E.load_state()
    if updating["on"] or job.busy() or not E.ytdlp_update_cmd():
        return
    if time.time() - st.get("last_update", 0) > UPDATE_EVERY:
        threading.Thread(target=update_ytdlp, daemon=True).start()


# ---- one download at a time -------------------------------------------------------------
class Job:
    def __init__(self):
        self.proc = None
        self.thread = None
        self.cancelled = False

    def busy(self):
        return self.thread is not None and self.thread.is_alive()

    def cancel(self):
        self.cancelled = True
        p = self.proc
        if p and p.poll() is None:
            if IS_WINDOWS:   # also stops the ffmpeg that yt-dlp started
                subprocess.run(["taskkill", "/PID", str(p.pid), "/T", "/F"],
                               capture_output=True, creationflags=E.NO_WINDOW)
            else:
                p.terminate()


job = Job()


def run(cmd, stage, total):
    """Run a command, forward progress, return (exit code, best hint, last error line)."""
    log("> " + subprocess.list2cmdline(cmd))
    env = dict(os.environ, PYTHONIOENCODING="utf-8", PYTHONUTF8="1")
    job.proc = subprocess.Popen(cmd, stdout=subprocess.PIPE, stderr=subprocess.STDOUT,
                                stdin=subprocess.DEVNULL, text=True, encoding="utf-8",
                                errors="replace", env=env, creationflags=E.NO_WINDOW)
    hint, last_err, last_sent, slow = None, None, 0.0, False
    meter = E.SpeedMeter()
    send({"type": "progress", "pct": None, "stage": stage})
    for raw in job.proc.stdout:
        line = raw.strip()
        if not line:
            continue
        prog = E.read_progress(line, total)
        if prog:
            pct, detail = prog
            now = time.monotonic()
            size = E.ffmpeg_bytes(line) if line.startswith(("frame=", "size=")) else None
            if size is not None:
                speed = meter.detail(now, size, pct)
                detail = ", ".join(x for x in (detail, speed) if x)
            if now - last_sent > 0.4 or (pct or 0) >= 100:
                if slow:
                    detail = (detail + " – " if detail else "") + E.SLOW_NOTE
                send({"type": "progress", "pct": pct, "stage": stage, "detail": detail})
                last_sent = now
            if E.is_summary(line):
                log(line)
            continue
        if line.startswith(("frame=", "size=")):
            continue
        log(line)
        if line.startswith("ERROR"):
            last_err = line
        if "challenge solving failed" in line.lower():
            slow = True
        h = E.hint_for(line)
        if h and (h != E.RELOAD_HINT or not hint):
            hint = h
    return job.proc.wait(), hint, last_err


def download(msg):
    result, final, message = "error", None, None
    temp_files = []
    try:
        s = E.load_settings()
        if msg.get("mode") in ("video", "audio"):
            s["mode"] = msg["mode"]
        url = str(msg.get("url") or "")
        start, end = msg.get("start"), msg.get("end")
        start = float(start) if start is not None else None
        end = float(end) if end is not None else None
        live_now = msg.get("live") == "now"
        if msg.get("diag"):
            log("marks: " + json.dumps(msg["diag"], ensure_ascii=False))
        ytdlp, ffmpeg = E.tool("yt-dlp"), E.tool("ffmpeg")
        if not url.startswith("https://www.youtube.com/watch?v="):
            raise RuntimeError("Not a YouTube video link.")
        if not ytdlp or not ffmpeg:
            missing = " and ".join(n for n, p in (("yt-dlp", ytdlp), ("ffmpeg", ffmpeg)) if not p)
            raise RuntimeError(f"{missing} is missing. Run Setup.bat again.")
        if start is not None and end is not None and end <= start:
            raise RuntimeError("End must be after the start.")
        if live_now and end is None:
            raise RuntimeError("This stream is still live. Mark an end too, or wait until the stream ends.")
        Path(s["dest"]).mkdir(parents=True, exist_ok=True)

        duration = msg.get("duration")
        duration = float(duration) if duration else None
        if start is None and end is None:
            part_len = None                      # whole video: yt-dlp reports its own percentage
        else:
            stop = end if end is not None else duration
            part_len = (stop - (start or 0.0)) if stop else None

        cookies = None                           # this browser's YouTube cookies, sent by the extension
        if (msg.get("cookies") or "").count("\n") > 1:
            fd, cookies = tempfile.mkstemp(prefix="ytclip_ck_", suffix=".txt")
            with os.fdopen(fd, "w", encoding="utf-8", newline="\n") as f:
                f.write(msg["cookies"])
            temp_files.append(cookies)

        fd, path_file = tempfile.mkstemp(prefix="ytclip_", suffix=".txt")
        os.close(fd)
        temp_files.append(path_file)
        cmd = E.build_command(ytdlp, s, url, start, end, path_file, cookies, live_now)
        rc, hint, last_err = run(cmd, "Downloading", part_len)
        if job.cancelled:
            result = "cancelled"
        elif rc == 0:
            lines = [l.strip() for l in Path(path_file).read_text(encoding="utf-8", errors="replace").splitlines()]
            lines = [l for l in lines if l]
            final = Path(lines[-1]) if lines else None
            result = "ok"
        else:
            message = hint or (last_err or "Download failed.").replace("ERROR: ", "")

        if result == "ok" and s["mode"] == "video" and s["compress"] and final and final.exists():
            tmp = final.with_name(final.stem + ".smaller" + final.suffix)
            crf = E.COMPRESS_LEVELS[s["compress_level"]]
            rc, _, last_err = run(E.compress_command(ffmpeg, final, tmp, crf),
                                  "Making the file smaller", E.probe_duration(final))
            if rc == 0 and not job.cancelled:
                os.replace(tmp, final)
            else:
                try:
                    tmp.unlink()
                except OSError:
                    pass
                result = "cancelled" if job.cancelled else "error"
                message = None if job.cancelled else "Downloaded, but making it smaller failed."
    except Exception as e:  # report anything unexpected to the panel
        log(f"Error: {e!r}")
        message = str(e)
        result = "cancelled" if job.cancelled else "error"
    finally:
        for f in temp_files:
            try:
                os.remove(f)
            except OSError:
                pass
        job.proc = None
        log(f"done: {result} {final or message or ''}")
        send({"type": "done", "result": result, "file": str(final) if final else None,
              "message": None if result == "ok" else message})


# ---- other requests -----------------------------------------------------------------------
def open_location(path):
    dest = Path(E.load_settings()["dest"])
    p = Path(path) if path else None
    if IS_WINDOWS:
        if p and p.exists():
            subprocess.Popen(f'explorer /select,"{p}"')
        else:
            dest.mkdir(parents=True, exist_ok=True)
            os.startfile(dest)
    else:
        subprocess.Popen(["xdg-open", str(p.parent if p and p.exists() else dest)])


def choose_folder(current):
    """Windows folder dialog through PowerShell; returns the chosen path or None."""
    if not IS_WINDOWS:
        return None
    start = (current or "").replace("'", "''")
    script = (
        "Add-Type -AssemblyName System.Windows.Forms;"
        "[Console]::OutputEncoding=[Text.Encoding]::UTF8;"
        "$d=New-Object System.Windows.Forms.FolderBrowserDialog;"
        "$d.Description='Choose where clips are saved';$d.ShowNewFolderButton=$true;"
        f"$d.SelectedPath='{start}';"
        "$o=New-Object System.Windows.Forms.Form -Property @{TopMost=$true};"
        "if($d.ShowDialog($o) -eq 'OK'){$d.SelectedPath}"
    )
    rc, out = run_quiet(["powershell", "-NoProfile", "-STA", "-Command", script], 900)
    path = out.strip().splitlines()[-1].strip() if rc == 0 and out.strip() else ""
    return path if path and Path(path).is_dir() else None


def info_fields():
    s = E.load_settings()
    return {
        "version": VERSION, "busy": job.busy(), "updating": updating["on"],
        "tools": tools_found(), "ytdlp_version": ytdlp_version["value"],
        "tool_paths": {n: E.tool(n) for n in ("yt-dlp", "ffmpeg", "deno")},
        "settings": s, "dest_name": Path(s["dest"]).name,
    }


def handle(msg):
    kind = msg.get("type")
    if kind == "ping":
        reply(msg, **info_fields())
        maybe_auto_update()
    elif kind == "get_settings":
        reply(msg, choices=E.CHOICES, **info_fields())
    elif kind == "set_settings":
        E.save_settings(msg.get("settings") or {})
        reply(msg, **info_fields())
    elif kind == "choose_folder":
        def pick():
            path = choose_folder(E.load_settings()["dest"])
            if path:
                E.save_settings({"dest": path})
            reply(msg, chosen=path, **info_fields())
        threading.Thread(target=pick, daemon=True).start()
    elif kind == "update_tools":
        def upd():
            if job.busy():
                reply(msg, ok=False, message="Wait for the download to finish first.")
                return
            ok, text = update_ytdlp()
            reply(msg, ok=ok, message=text, **info_fields())
        threading.Thread(target=upd, daemon=True).start()
    elif kind == "download":
        if job.busy():
            send({"type": "done", "result": "error", "message": "A download is already running."})
        elif updating["on"]:
            send({"type": "done", "result": "error", "message": "yt-dlp is updating. Try again in a minute."})
        else:
            job.cancelled = False
            job.thread = threading.Thread(target=download, args=(msg,), daemon=True)
            job.thread.start()
    elif kind == "cancel":
        job.cancel()
    elif kind == "open":
        open_location(msg.get("path"))


def main():
    log(f"helper {VERSION} started (Python {sys.version.split()[0]}, tools in {E.BIN_DIR})")
    threading.Thread(target=read_version, daemon=True).start()
    while True:
        try:
            msg = read_message()
        except (OSError, ValueError) as e:
            log(f"bad message: {e!r}")
            break
        if msg is None:          # browser closed the connection
            break
        try:
            handle(msg)
        except Exception as e:
            log(f"Error handling {msg.get('type')}: {e!r}")
            if msg.get("id") is not None:
                reply(msg, ok=False, message=str(e))
    job.cancel()
    log("helper stopped")
    os._exit(0)


if __name__ == "__main__":
    main()
