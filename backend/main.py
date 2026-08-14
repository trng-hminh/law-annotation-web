"""Legal annotation backend — secure, isolated, scale-ready.

Security model
--------------
* Admin is a single protected account (username + password, PBKDF2-hashed).
  The password comes from the ADMIN_PASSWORD env var; if unset, a default
  ("admin123") is used and a warning is printed at startup.
* Annotator accounts are created by the admin (name + passcode). Passcodes are
  PBKDF2-hashed. Annotators can never list or see other annotators.
* Every protected endpoint requires a signed Bearer token (HMAC-SHA256 over
  the server secret). Tokens encode the identity type and id, so an annotator
  cannot impersonate another annotator or the admin.

Case lifecycle
--------------
* Admin imports the case corpus (POST /api/cases). Case content is stored in
  data/case_docs/<case_id>.json and served on demand — an annotator only ever
  downloads the single case they are working on (scales to thousands of cases).
* Each open case is assigned to ONE annotator (fair auto-assignment included).
* Submitting a case marks it "completed" -> it disappears from annotators'
  lists. The admin can reopen it to put it back in rotation.

Storage (all under backend/, absolute paths):
  submissions/case_<id>_<ts>.json              final submissions
  data/secret.key                              server secret (auto-generated)
  data/config.json                             admin password hash/salt
  data/annotators.json                         annotator accounts
  data/cases.json                              case registry (id/title/status)
  data/assignments.json                        case_id -> annotator_id
  data/case_docs/<case_id>.json                case documents
  data/submissions_index.json                  case_id -> submissions (fast reads)
  data/drafts/<annotator_id>/case_<case_id>.json
"""

import hashlib
import hmac
import json
import os
import re
import secrets
import time
from datetime import datetime
from pathlib import Path

from fastapi import FastAPI, HTTPException, Request
from fastapi.middleware.cors import CORSMiddleware


app = FastAPI()


app.add_middleware(
    CORSMiddleware,
    allow_origins=["http://localhost:5173"],
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)


# ------------------------------ paths & helpers ------------------------------

BASE_DIR = Path(__file__).resolve().parent
SUBMISSIONS_DIR = BASE_DIR / "submissions"
DATA_DIR = BASE_DIR / "data"
CASE_DOCS_DIR = DATA_DIR / "case_docs"
DRAFTS_DIR = DATA_DIR / "drafts"

SECRET_FILE = DATA_DIR / "secret.key"
CONFIG_FILE = DATA_DIR / "config.json"
ANNOTATORS_FILE = DATA_DIR / "annotators.json"
CASES_FILE = DATA_DIR / "cases.json"
ASSIGNMENTS_FILE = DATA_DIR / "assignments.json"
SUBMISSIONS_INDEX_FILE = DATA_DIR / "submissions_index.json"

for _dir in (SUBMISSIONS_DIR, DATA_DIR, CASE_DOCS_DIR, DRAFTS_DIR):
    _dir.mkdir(parents=True, exist_ok=True)


def _read_json(path, default):
    try:
        if not path.exists():
            return default
        return json.loads(path.read_text(encoding="utf-8"))
    except Exception:
        return default


def _write_json(path, data):
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps(data, ensure_ascii=False, indent=2), encoding="utf-8")


def _safe_id(value):
    """Sanitise ids coming from URLs to prevent path traversal."""
    return re.sub(r"[^A-Za-z0-9_\-]", "", str(value))


# ------------------------------ password / secret ------------------------------

def _hash_password(password, salt=None):
    if not salt:
        salt = secrets.token_hex(16)
    dk = hashlib.pbkdf2_hmac("sha256", password.encode("utf-8"), salt.encode("utf-8"), 100_000)
    return salt, dk.hex()


def _ensure_admin_password():
    cfg = _read_json(CONFIG_FILE, {})
    if cfg.get("admin_password_hash"):
        return
    password = os.environ.get("ADMIN_PASSWORD", "admin123")
    salt, hashed = _hash_password(password)
    cfg["admin_username"] = os.environ.get("ADMIN_USERNAME", "admin")
    cfg["admin_password_salt"] = salt
    cfg["admin_password_hash"] = hashed
    _write_json(CONFIG_FILE, cfg)
    if "ADMIN_PASSWORD" not in os.environ:
        print(
            "WARNING: ADMIN_PASSWORD env var not set; using default 'admin123'. "
            "Set ADMIN_PASSWORD before starting uvicorn in production."
        )


def _secret():
    if SECRET_FILE.exists():
        return SECRET_FILE.read_text(encoding="utf-8").strip()
    secret = secrets.token_hex(32)
    SECRET_FILE.write_text(secret, encoding="utf-8")
    return secret


def _make_token(identity_type, identity_id, hours=24):
    expires = int(time.time()) + hours * 3600
    payload = f"{identity_type}:{identity_id}:{expires}"
    sig = hmac.new(_secret().encode(), payload.encode(), hashlib.sha256).hexdigest()
    return f"{payload}:{sig}"


def _require_auth(request: Request):
    header = request.headers.get("authorization", "")
    if not header.startswith("Bearer "):
        raise HTTPException(status_code=401, detail="Thiếu token đăng nhập.")
    parts = header[7:].split(":")
    if len(parts) != 4:
        raise HTTPException(status_code=401, detail="Token không hợp lệ.")
    itype, iid, exp, sig = parts
    try:
        if int(exp) < int(time.time()):
            raise HTTPException(status_code=401, detail="Token đã hết hạn, hãy đăng nhập lại.")
    except ValueError:
        raise HTTPException(status_code=401, detail="Token không hợp lệ.")
    expected = hmac.new(_secret().encode(), f"{itype}:{iid}:{exp}".encode(), hashlib.sha256).hexdigest()
    if not hmac.compare_digest(expected, sig):
        raise HTTPException(status_code=401, detail="Token không hợp lệ.")
    return {"type": itype, "id": iid}


def _require_admin(request: Request):
    auth = _require_auth(request)
    if auth["type"] != "admin":
        raise HTTPException(status_code=403, detail="Chỉ admin mới có quyền này.")
    return auth


def _require_annotator(request: Request):
    auth = _require_auth(request)
    if auth["type"] != "annotator":
        raise HTTPException(status_code=403, detail="Chỉ annotator mới có quyền này.")
    return auth


def _annotator_name(annotator_id):
    for a in _read_json(ANNOTATORS_FILE, []):
        if a["id"] == annotator_id:
            return a["name"]
    return annotator_id


def _registry_by_id():
    return {c["case_id"]: c for c in _read_json(CASES_FILE, [])}


def _set_case_status(case_id, status, completed_by=None):
    registry = _read_json(CASES_FILE, [])
    for c in registry:
        if c["case_id"] == case_id:
            c["status"] = status
            if status == "completed":
                c["completed_at"] = datetime.now().isoformat()
                c["completed_by"] = completed_by
            else:
                c.pop("completed_at", None)
                c.pop("completed_by", None)
            break
    _write_json(CASES_FILE, registry)


def _submissions_index():
    """case_id -> [submission summary, ...]; rebuilt lazily from disk."""
    if SUBMISSIONS_INDEX_FILE.exists():
        return _read_json(SUBMISSIONS_INDEX_FILE, {})
    index = {}
    for sub_file in sorted(SUBMISSIONS_DIR.glob("case_*.json")):
        data = _read_json(sub_file, {})
        cid = data.get("case_id") or sub_file.name.split("_")[1]
        index.setdefault(str(cid), []).append({
            "annotator_id": data.get("annotator_id"),
            "annotator_name": data.get("annotator_name"),
            "submitted_at": data.get("submitted_at"),
            "file": sub_file.name,
        })
    _write_json(SUBMISSIONS_INDEX_FILE, index)
    return index


_ensure_admin_password()


# ------------------------------ public ------------------------------

@app.get("/")
def root():
    return {
        "message": "Legal annotation backend is running",
        "endpoints": [
            "POST /api/auth/admin",
            "POST /api/auth/annotator",
            "POST /api/auth/admin/change-password",
            "GET/POST /api/annotators (admin)",
            "PUT/DELETE /api/annotators/{id} (admin)",
            "POST /api/cases (admin, import corpus)",
            "GET  /api/cases (admin, overview)",
            "GET  /api/cases/{id}/doc",
            "GET  /api/annotator/cases (annotator)",
            "POST /api/cases/{id}/assign (admin)",
            "POST /api/cases/{id}/reopen (admin)",
            "POST /api/cases/auto-assign (admin)",
            "GET/PUT/DELETE /api/cases/{id}/draft (annotator)",
            "POST /api/submit",
        ],
    }


# ------------------------------ auth ------------------------------

@app.post("/api/auth/admin")
def admin_login(payload: dict):
    cfg = _read_json(CONFIG_FILE, {})
    username = str(payload.get("username", ""))
    password = str(payload.get("password", ""))
    expected_user = cfg.get("admin_username", "admin")
    expected_hash = cfg.get("admin_password_hash", "")
    salt = cfg.get("admin_password_salt", "")
    if username != expected_user or not expected_hash:
        raise HTTPException(status_code=401, detail="Sai tên đăng nhập hoặc mật khẩu.")
    _, hashed = _hash_password(password, salt)
    if not hmac.compare_digest(hashed, expected_hash):
        raise HTTPException(status_code=401, detail="Sai tên đăng nhập hoặc mật khẩu.")
    return {
        "type": "admin",
        "id": "admin",
        "name": expected_user,
        "token": _make_token("admin", "admin", hours=12),
    }


@app.post("/api/auth/annotator")
def annotator_login(payload: dict):
    name = str(payload.get("name", "")).strip()
    passcode = str(payload.get("passcode", ""))
    annotators = _read_json(ANNOTATORS_FILE, [])
    found = next((a for a in annotators if a["name"].lower() == name.lower()), None)
    if not found:
        raise HTTPException(status_code=401, detail="Sai tên hoặc mã annotator.")
    _, hashed = _hash_password(passcode, found.get("passcode_salt", ""))
    if not hmac.compare_digest(hashed, found.get("passcode_hash", "")):
        raise HTTPException(status_code=401, detail="Sai tên hoặc mã annotator.")
    return {
        "type": "annotator",
        "id": found["id"],
        "name": found["name"],
        "token": _make_token("annotator", found["id"]),
    }


@app.post("/api/auth/admin/change-password")
def change_admin_password(payload: dict, request: Request):
    _require_admin(request)
    new_password = str(payload.get("new_password", ""))
    if len(new_password) < 6:
        raise HTTPException(status_code=400, detail="Mật khẩu mới phải có ít nhất 6 ký tự.")
    cfg = _read_json(CONFIG_FILE, {})
    salt, hashed = _hash_password(new_password)
    cfg["admin_password_salt"] = salt
    cfg["admin_password_hash"] = hashed
    _write_json(CONFIG_FILE, cfg)
    return {"success": True, "message": "Đã đổi mật khẩu admin."}


# ------------------------------ annotator management (admin) ------------------------------

def _sanitize_annotator(annotator, with_passcode=False):
    out = {
        "id": annotator["id"],
        "name": annotator["name"],
        "created_at": annotator.get("created_at"),
    }
    if with_passcode:
        out["passcode"] = annotator.get("_passcode_plain")
    return out


@app.get("/api/annotators")
def list_annotators(request: Request):
    _require_admin(request)
    return [_sanitize_annotator(a) for a in _read_json(ANNOTATORS_FILE, [])]


@app.post("/api/annotators")
def create_annotator(payload: dict, request: Request):
    _require_admin(request)
    name = str(payload.get("name", "")).strip()
    passcode = str(payload.get("passcode", ""))
    if not name:
        raise HTTPException(status_code=400, detail="Cần nhập tên annotator.")
    if len(passcode) < 4:
        raise HTTPException(status_code=400, detail="Mã annotator phải có ít nhất 4 ký tự.")
    annotators = _read_json(ANNOTATORS_FILE, [])
    if any(a["name"].lower() == name.lower() for a in annotators):
        raise HTTPException(status_code=409, detail="Tên annotator đã tồn tại.")
    ids = [int(a["id"][1:]) for a in annotators if a["id"].startswith("A")]
    next_id = (max(ids) + 1) if ids else 1
    salt, hashed = _hash_password(passcode)
    annotator = {
        "id": f"A{next_id}",
        "name": name,
        "passcode_salt": salt,
        "passcode_hash": hashed,
        "created_at": datetime.now().isoformat(),
        "_passcode_plain": passcode,
    }
    annotators.append(annotator)
    _write_json(ANNOTATORS_FILE, annotators)
    return _sanitize_annotator(annotator, with_passcode=True)


@app.put("/api/annotators/{annotator_id}")
def update_annotator(annotator_id: str, payload: dict, request: Request):
    _require_admin(request)
    annotator_id = _safe_id(annotator_id)
    annotators = _read_json(ANNOTATORS_FILE, [])
    found = next((a for a in annotators if a["id"] == annotator_id), None)
    if not found:
        raise HTTPException(status_code=404, detail="Không tìm thấy annotator.")
    new_name = str(payload.get("name", "")).strip()
    if new_name and new_name.lower() != found["name"].lower():
        if any(a["name"].lower() == new_name.lower() and a["id"] != annotator_id for a in annotators):
            raise HTTPException(status_code=409, detail="Tên annotator đã tồn tại.")
        found["name"] = new_name
    new_passcode = str(payload.get("passcode", ""))
    if new_passcode:
        if len(new_passcode) < 4:
            raise HTTPException(status_code=400, detail="Mã annotator phải có ít nhất 4 ký tự.")
        salt, hashed = _hash_password(new_passcode)
        found["passcode_salt"] = salt
        found["passcode_hash"] = hashed
        found["_passcode_plain"] = new_passcode
    _write_json(ANNOTATORS_FILE, annotators)
    return _sanitize_annotator(found, with_passcode=bool(new_passcode))


@app.delete("/api/annotators/{annotator_id}")
def delete_annotator(annotator_id: str, request: Request):
    _require_admin(request)
    annotator_id = _safe_id(annotator_id)
    annotators = _read_json(ANNOTATORS_FILE, [])
    annotators = [a for a in annotators if a["id"] != annotator_id]
    _write_json(ANNOTATORS_FILE, annotators)
    assignments = _read_json(ASSIGNMENTS_FILE, {})
    changed = False
    for cid, aid in list(assignments.items()):
        if aid == annotator_id:
            del assignments[cid]
            changed = True
    if changed:
        _write_json(ASSIGNMENTS_FILE, assignments)
    draft_dir = DRAFTS_DIR / annotator_id
    if draft_dir.exists():
        for f in draft_dir.glob("*.json"):
            f.unlink()
        try:
            draft_dir.rmdir()
        except OSError:
            pass
    return {"success": True}


# ------------------------------ case corpus (admin import) ------------------------------

@app.post("/api/cases")
def import_cases(payload: dict, request: Request):
    _require_admin(request)
    docs = payload.get("cases", []) or []
    registry = _read_json(CASES_FILE, [])
    by_id = {c["case_id"]: c for c in registry}
    imported = 0
    for doc in docs:
        cid = _safe_id(doc.get("id") or doc.get("case_id") or "")
        if not cid:
            continue
        _write_json(CASE_DOCS_DIR / f"{cid}.json", doc)
        existing = by_id.get(cid, {})
        by_id[cid] = {
            "case_id": cid,
            "title": doc.get("title") or existing.get("title") or f"Case {cid}",
            "status": existing.get("status", "open"),
        }
        if existing.get("status") == "completed":
            by_id[cid]["completed_at"] = existing.get("completed_at")
            by_id[cid]["completed_by"] = existing.get("completed_by")
        imported += 1
    result = sorted(by_id.values(), key=lambda x: x["case_id"])
    _write_json(CASES_FILE, result)
    return {"imported": imported, "total_cases": len(result)}


# ------------------------------ assignment ------------------------------

@app.post("/api/cases/{case_id}/assign")
def assign_case(case_id: str, payload: dict, request: Request):
    _require_admin(request)
    case_id = _safe_id(case_id)
    annotator_id = payload.get("annotator_id")
    assignments = _read_json(ASSIGNMENTS_FILE, {})
    if annotator_id:
        annotator_id = _safe_id(str(annotator_id))
        if not any(a["id"] == annotator_id for a in _read_json(ANNOTATORS_FILE, [])):
            raise HTTPException(status_code=400, detail="Annotator không tồn tại.")
        assignments[case_id] = annotator_id
    else:
        assignments.pop(case_id, None)
    _write_json(ASSIGNMENTS_FILE, assignments)
    return {"case_id": case_id, "annotator_id": assignments.get(case_id)}


@app.post("/api/cases/{case_id}/reopen")
def reopen_case(case_id: str, request: Request):
    _require_admin(request)
    case_id = _safe_id(case_id)
    registry = _read_json(CASES_FILE, [])
    found = False
    for c in registry:
        if c["case_id"] == case_id:
            c["status"] = "open"
            c.pop("completed_at", None)
            c.pop("completed_by", None)
            found = True
            break
    if not found:
        raise HTTPException(status_code=404, detail="Không tìm thấy case.")
    _write_json(CASES_FILE, registry)
    return {"success": True, "case_id": case_id, "status": "open"}


@app.post("/api/cases/auto-assign")
def auto_assign(request: Request):
    """Evenly distribute open, unassigned cases across annotators,
    favouring annotators with the lightest current workload."""
    _require_admin(request)
    annotators = _read_json(ANNOTATORS_FILE, [])
    if not annotators:
        raise HTTPException(status_code=400, detail="Chưa có annotator nào. Hãy tạo annotator trước.")
    registry = _read_json(CASES_FILE, [])
    assignments = _read_json(ASSIGNMENTS_FILE, {})

    open_ids = {c["case_id"] for c in registry if c.get("status") != "completed"}
    pending = sorted(open_ids - set(assignments.keys()))

    workload = {a["id"]: 0 for a in annotators}
    for cid, aid in assignments.items():
        if cid in open_ids and aid in workload:
            workload[aid] += 1

    assigned = 0
    for cid in pending:
        aid = min(workload, key=workload.get)
        assignments[cid] = aid
        workload[aid] += 1
        assigned += 1

    _write_json(ASSIGNMENTS_FILE, assignments)
    return {"assigned": assigned, "pending": len(pending) - assigned}


# ------------------------------ views ------------------------------

@app.get("/api/annotator/cases")
def annotator_cases(request: Request):
    """Annotator's own open cases only — no visibility into other annotators."""
    auth = _require_annotator(request)
    assignments = _read_json(ASSIGNMENTS_FILE, {})
    registry = _registry_by_id()

    open_cases = []
    all_assigned = 0
    completed = 0
    for cid, aid in assignments.items():
        if aid != auth["id"]:
            continue
        all_assigned += 1
        reg = registry.get(cid)
        if reg is None:
            continue
        if reg.get("status") == "completed":
            completed += 1
        else:
            open_cases.append({
                "case_id": cid,
                "title": reg.get("title", f"Case {cid}"),
            })
    open_cases.sort(key=lambda c: c["case_id"])
    return {
        "cases": open_cases,
        "stats": {
            "assigned": all_assigned,
            "completed": completed,
            "remaining": len(open_cases),
        },
    }


@app.get("/api/cases")
def admin_overview(request: Request):
    _require_admin(request)
    registry = _read_json(CASES_FILE, [])
    assignments = _read_json(ASSIGNMENTS_FILE, {})
    submissions_index = _submissions_index()

    drafts_by_case = {}
    for draft_file in DRAFTS_DIR.glob("*/case_*.json"):
        cid = draft_file.name.replace("case_", "").replace(".json", "")
        drafts_by_case.setdefault(cid, []).append({
            "annotator_id": draft_file.parent.name,
            "updated_at": datetime.fromtimestamp(draft_file.stat().st_mtime).isoformat(),
        })

    result = []
    for c in registry:
        cid = c["case_id"]
        result.append({
            "case_id": cid,
            "title": c.get("title", f"Case {cid}"),
            "status": c.get("status", "open"),
            "completed_at": c.get("completed_at"),
            "completed_by": c.get("completed_by"),
            "assigned_to": assignments.get(cid),
            "submissions": submissions_index.get(cid, []),
            "drafts": drafts_by_case.get(cid, []),
        })
    return result


@app.get("/api/cases/{case_id}/doc")
def get_case_doc(case_id: str, request: Request):
    auth = _require_auth(request)
    case_id = _safe_id(case_id)
    path = CASE_DOCS_DIR / f"{case_id}.json"
    if not path.exists():
        raise HTTPException(status_code=404, detail="Không tìm thấy case.")
    if auth["type"] == "annotator":
        assignments = _read_json(ASSIGNMENTS_FILE, {})
        if assignments.get(case_id) != auth["id"]:
            raise HTTPException(status_code=403, detail="Case này không được phân công cho bạn.")
    return _read_json(path, {})


# ------------------------------ drafts (annotator only) ------------------------------

@app.get("/api/cases/{case_id}/draft")
def get_draft(case_id: str, request: Request):
    auth = _require_annotator(request)
    case_id = _safe_id(case_id)
    path = DRAFTS_DIR / auth["id"] / f"case_{case_id}.json"
    if not path.exists():
        raise HTTPException(status_code=404, detail="Chưa có nháp.")
    return _read_json(path, {})


@app.put("/api/cases/{case_id}/draft")
def save_draft(case_id: str, payload: dict, request: Request):
    auth = _require_annotator(request)
    case_id = _safe_id(case_id)
    path = DRAFTS_DIR / auth["id"] / f"case_{case_id}.json"
    payload["saved_at"] = datetime.now().isoformat()
    _write_json(path, payload)
    return {"success": True, "case_id": case_id, "saved_at": payload["saved_at"]}


@app.delete("/api/cases/{case_id}/draft")
def delete_draft(case_id: str, request: Request):
    auth = _require_annotator(request)
    case_id = _safe_id(case_id)
    path = DRAFTS_DIR / auth["id"] / f"case_{case_id}.json"
    if path.exists():
        path.unlink()
    return {"success": True}


# ------------------------------ submission ------------------------------

@app.post("/api/submit")
def submit_case(payload: dict, request: Request):
    auth = _require_auth(request)
    case_id = _safe_id(str(payload.get("case_id", "")))
    if not case_id:
        raise HTTPException(status_code=400, detail="Thiếu case_id.")
    if not (CASE_DOCS_DIR / f"{case_id}.json").exists():
        raise HTTPException(status_code=404, detail="Không tìm thấy case.")

    # annotators may only submit cases assigned to them; admin may submit any
    if auth["type"] == "annotator":
        assignments = _read_json(ASSIGNMENTS_FILE, {})
        if assignments.get(case_id) != auth["id"]:
            raise HTTPException(status_code=403, detail="Case này không được phân công cho bạn.")

    annotator_id = auth["id"]
    annotator_name = "admin" if auth["type"] == "admin" else _annotator_name(auth["id"])

    timestamp = datetime.now().strftime("%Y%m%d_%H%M%S")
    data = dict(payload)
    data["annotator_id"] = annotator_id
    data["annotator_name"] = annotator_name
    data["received_at"] = datetime.now().isoformat()
    filename = SUBMISSIONS_DIR / f"case_{case_id}_{timestamp}.json"
    _write_json(filename, data)

    index = _submissions_index()
    index.setdefault(case_id, []).append({
        "annotator_id": annotator_id,
        "annotator_name": annotator_name,
        "submitted_at": data.get("submitted_at"),
        "file": filename.name,
    })
    _write_json(SUBMISSIONS_INDEX_FILE, index)

    _set_case_status(case_id, "completed", completed_by=annotator_id)

    draft = DRAFTS_DIR / annotator_id / f"case_{case_id}.json"
    if draft.exists():
        draft.unlink()

    return {
        "success": True,
        "case_id": case_id,
        "annotator_id": annotator_id,
        "annotator_name": annotator_name,
        "file": filename.name,
        "status": "completed",
    }
