"""Bikefit local server: static UI, session storage on disk, and a Claude Code chat coach.

Run: python3 server.py   (then open http://localhost:8765)
"""

import json
import os
import re
import subprocess
import time
from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from urllib.parse import urlparse

ROOT = Path(__file__).resolve().parent
DATA = Path(os.environ.get("BIKEFIT_DATA", ROOT / "data")).expanduser().resolve()
PORT = int(os.environ.get("BIKEFIT_PORT", 8765))
MODEL = os.environ.get("BIKEFIT_MODEL", "sonnet")
CHAT_TIMEOUT = 600
MAX_UPLOAD = 300 * 1024 * 1024

# Session ids and file names come from the browser and become path segments,
# so only plain names are accepted, which rules out traversal like "../".
SESSION_RE = re.compile(r"^[\w-]{1,80}$")
FILE_RE = re.compile(r"^[\w.-]{1,120}\.(png|jpg|jpeg|webm|mp4)$")

COACH_PROMPT = """You are an experienced bike fitter coaching the rider through a self-fit, \
using a local app. You can read the rider's data, and you can search the web.

The working directory holds one folder per fit session. Each folder contains:
- session.json: bike identity and type, measurements in mm or degrees, body data, \
recorded joint-angle stats (interior angles: a straight leg is 180; torso is degrees above \
horizontal), notes, and the list of snapshots.
- Snapshot PNGs: side-view frames with the detected skeleton drawn on. Look at them \
when posture matters.
Every user message names the current session folder. Read its session.json before you \
answer, because the rider may have changed values since your last turn. Read older \
sessions when comparing.

The app has three tabs:
- Capture: camera or uploaded video/photo, live angles, a "Record 10s" button for \
pedal-stroke stats, and "Freeze" + "Save snapshot" (joints can be dragged to correct them).
- Measurements: bike identity, core contact points, frame, cockpit & cleats, body.
- Sessions: create a session (it copies the current measurements), plus a before/after compare.

Guide the rider step by step, from nothing to a dialled fit. Follow this protocol, \
skip steps that are already done, and say where you are in it:
1. Intake: goals, riding style and hours, pain or injuries, flexibility, bike brand/model/year/size.
2. Bike lookup: search the web for that exact model's geometry (stack, reach, seat angle, \
stock stem/bar/crank) and any manufacturer fit guidance. Cite the sources briefly.
3. Body measurements (height, inseam: book-against-the-wall method, arm, torso).
4. Current bike measurements: tell them exactly how to measure each one.
5. Cleats: fore-aft over the ball of the foot, rotation, stance width.
6. Saddle height: knee extension at the bottom of the stroke, from a 10s recording.
7. Saddle setback and tilt.
8. Reach and drop: torso, elbow and shoulder angles, hip angle closed at the top.
9. Cockpit: bar width, hood position and angle.
10. Verify: a ride, a new session after changes, and a compare with the previous one.

Rules:
- One step at a time. Give concrete actions: which tab, which field, which button.
- Recommend changes in small increments (saddle height 3-5 mm at a time) and say why.
- The app's target ranges are starting points. Weigh comfort, pain and goals above the numbers.
- Pain that is sharp, numb or persistent: advise a professional fitter or physio.
- Keep replies short and skimmable.
- End EVERY reply with a final block in exactly this form, with 2-3 short options the \
rider can click to send as their next message:
Next:
- <option>
- <option>
"""


def session_dir(sid: str) -> Path:
    if not SESSION_RE.match(sid or ""):
        raise ValueError(f"bad session id: {sid!r}")
    return DATA / sid


def read_json(path: Path, default):
    return json.loads(path.read_text()) if path.exists() else default


def write_json(path: Path, obj) -> None:
    # Write-then-rename so a crash mid-save never leaves a truncated file.
    tmp = path.with_suffix(".tmp")
    tmp.write_text(json.dumps(obj, indent=2))
    tmp.replace(path)


def list_sessions():
    out = []
    for d in sorted(DATA.iterdir(), reverse=True) if DATA.exists() else []:
        s = read_json(d / "session.json", None)
        if s is not None:
            out.append({"id": d.name, "label": s.get("label", ""), "created": s.get("created", ""),
                        "bike": s.get("bike", {})})
    return out


def create_session(label: str, copy_from: str | None = None) -> dict:
    slug = re.sub(r"[^\w-]+", "-", label.strip().lower()).strip("-")[:40] or "fit"
    sid = f"{time.strftime('%Y-%m-%d-%H%M%S')}-{slug}"
    session = {"id": sid, "label": label or "Fit", "created": time.strftime("%Y-%m-%d %H:%M"),
               "bike": {"type": "road"}, "measurements": {}, "angles": None,
               "snapshots": [], "notes": ""}
    if copy_from:
        prev = read_json(session_dir(copy_from) / "session.json", {})
        session["bike"] = prev.get("bike", session["bike"])
        session["measurements"] = prev.get("measurements", {})
    d = session_dir(sid)
    d.mkdir(parents=True)
    write_json(d / "session.json", session)
    return session


def claude_cmd(prompt: str, claude_session_id: str | None) -> list[str]:
    tools = "Read,WebSearch,WebFetch"
    cmd = ["claude", "-p", prompt, "--output-format", "json", "--model", MODEL,
           "--tools", tools, "--allowedTools", tools,
           "--append-system-prompt", COACH_PROMPT]
    if claude_session_id:
        cmd += ["--resume", claude_session_id]
    return cmd


def chat(sid: str, message: str, fresh: bool) -> dict:
    d = session_dir(sid)
    chat_file = d / "chat.json"
    log = {"claude_session_id": None, "messages": []} if fresh else read_json(
        chat_file, {"claude_session_id": None, "messages": []})
    prompt = f"[Current session folder: {sid}/]\n\n{message}"
    proc = subprocess.run(claude_cmd(prompt, log["claude_session_id"]), cwd=DATA,
                          capture_output=True, text=True, timeout=CHAT_TIMEOUT)
    try:
        res = json.loads(proc.stdout)
    except json.JSONDecodeError:
        raise RuntimeError((proc.stderr or proc.stdout or "claude produced no output").strip()[:2000])
    if res.get("is_error"):
        raise RuntimeError(str(res.get("result") or res)[:2000])
    log["claude_session_id"] = res.get("session_id")
    log["messages"] += [{"role": "user", "text": message}, {"role": "assistant", "text": res["result"]}]
    write_json(chat_file, log)
    return {"reply": res["result"], "messages": log["messages"]}


class Handler(SimpleHTTPRequestHandler):
    def __init__(self, *a, **kw):
        super().__init__(*a, directory=str(ROOT / "static"), **kw)

    def log_message(self, fmt, *args):
        if "/api/" in self.path:
            super().log_message(fmt, *args)

    def send_json(self, obj, code=200):
        body = json.dumps(obj).encode()
        self.send_response(code)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def body(self) -> bytes:
        n = int(self.headers.get("Content-Length") or 0)
        if n > MAX_UPLOAD:
            raise ValueError("upload too large")
        return self.rfile.read(n)

    def same_origin(self) -> bool:
        # Any web page open in the browser can send requests to localhost. Reject foreign
        # Origin headers (CSRF) and foreign Host headers (DNS rebinding).
        ok = {f"localhost:{PORT}", f"127.0.0.1:{PORT}"}
        origin = self.headers.get("Origin")
        return self.headers.get("Host") in ok and (origin is None or urlparse(origin).netloc in ok)

    def route(self, method):
        parts = [p for p in urlparse(self.path).path.split("/") if p]
        if not self.same_origin():
            return self.send_json({"error": "forbidden"}, 403)
        try:
            # /data/<sid>/<file>: serve snapshots and clips.
            if method == "GET" and len(parts) == 3 and parts[0] == "data":
                if not FILE_RE.match(parts[2]):
                    raise ValueError("bad file name")
                f = session_dir(parts[1]) / parts[2]
                if not f.exists():
                    return self.send_json({"error": "not found"}, 404)
                data = f.read_bytes()
                self.send_response(200)
                self.send_header("Content-Type", self.guess_type(str(f)))
                self.send_header("Content-Length", str(len(data)))
                self.end_headers()
                return self.wfile.write(data)
            if parts[:1] != ["api"]:
                return super().do_GET() if method == "GET" else self.send_json({"error": "not found"}, 404)

            match method, parts[1:]:
                case "GET", ["sessions"]:
                    return self.send_json(list_sessions())
                case "POST", ["sessions"]:
                    req = json.loads(self.body() or b"{}")
                    return self.send_json(create_session(req.get("label", ""), req.get("copy_from")))
                case "GET", ["sessions", sid]:
                    f = session_dir(sid) / "session.json"
                    return self.send_json(read_json(f, None)) if f.exists() else self.send_json({"error": "not found"}, 404)
                case "PUT", ["sessions", sid]:
                    d = session_dir(sid)
                    if not d.exists():
                        return self.send_json({"error": "not found"}, 404)
                    write_json(d / "session.json", json.loads(self.body()))
                    return self.send_json({"ok": True})
                case "POST", ["sessions", sid, "files", name]:
                    if not FILE_RE.match(name):
                        raise ValueError("bad file name")
                    (session_dir(sid) / name).write_bytes(self.body())
                    return self.send_json({"ok": True, "url": f"/data/{sid}/{name}"})
                case "GET", ["sessions", sid, "chat"]:
                    return self.send_json(read_json(session_dir(sid) / "chat.json", {"messages": []}))
                case "POST", ["chat"]:
                    req = json.loads(self.body())
                    return self.send_json(chat(req["session_id"], req["message"], bool(req.get("fresh"))))
            return self.send_json({"error": "not found"}, 404)
        except ValueError as e:
            return self.send_json({"error": str(e)}, 400)
        except subprocess.TimeoutExpired:
            return self.send_json({"error": "Claude took too long, try again"}, 504)
        except (RuntimeError, FileNotFoundError) as e:
            return self.send_json({"error": str(e)}, 500)

    def do_GET(self):
        self.route("GET")

    def do_POST(self):
        self.route("POST")

    def do_PUT(self):
        self.route("PUT")


if __name__ == "__main__":
    DATA.mkdir(parents=True, exist_ok=True)
    print(f"Bikefit on http://localhost:{PORT}  (data: {DATA}, coach model: {MODEL})")
    # Loopback only: the API reads and writes your files and runs Claude.
    ThreadingHTTPServer(("127.0.0.1", PORT), Handler).serve_forever()
