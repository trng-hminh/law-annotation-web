"""Legal annotation backend — secure, isolated, scale-ready, deploy-ready.

Two storage backends, chosen automatically:
  * MONGODB_URI env set  -> persistent MongoDB storage (production/deploy)
  * otherwise            -> local JSON files under backend/data (local dev)

Configuration (env vars, safe for Render/Fly/Koyeb):
  MONGODB_URI       connection string (e.g. mongodb+srv://...)
  MONGODB_DB        database name (default: from URI, else "legal_annotation")
  ADMIN_PASSWORD    admin password (default: "admin123" + warning)
  ADMIN_USERNAME    admin username (default: "admin")
  SECRET_KEY        token-signing secret (default: random, persisted)
  ALLOWED_ORIGINS   comma-separated CORS origins (default: http://localhost:5173)

Security model
--------------
* Single protected admin account (username + password, PBKDF2-hashed).
* Annotator accounts are created by the admin (name + passcode), hashed.
* Every protected endpoint requires a signed Bearer token (HMAC-SHA256).
* Annotators can never list or see other annotators or other annotators' data.

Case lifecycle
--------------
* Admin imports the case corpus; case content is served on demand.
* Each open case is assigned to ONE annotator (fair auto-assignment included).
* Submitting marks a case "completed" -> it disappears from annotators' lists.
  The admin can reopen it to put it back in rotation.
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
from fastapi.responses import Response


# ------------------------------ env configuration ------------------------------

BASE_DIR = Path(__file__).resolve().parent

MONGODB_URI = os.environ.get("MONGODB_URI", "").strip()
MONGODB_DB = os.environ.get("MONGODB_DB", "").strip()
ALLOWED_ORIGINS = [
    o.strip()
    for o in os.environ.get("ALLOWED_ORIGINS", "http://localhost:5173").split(",")
    if o.strip()
]
ENV_SECRET = os.environ.get("SECRET_KEY", "").strip()
ENV_ADMIN_PASSWORD = os.environ.get("ADMIN_PASSWORD", "").strip()
ENV_ADMIN_USERNAME = os.environ.get("ADMIN_USERNAME", "admin").strip()


# ------------------------------ storage abstraction ------------------------------

def _read_json_file(path, default):
    try:
        if not path.exists():
            return default
        return json.loads(path.read_text(encoding="utf-8"))
    except Exception:
        return default


def _write_json_file(path, data):
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps(data, ensure_ascii=False, indent=2), encoding="utf-8")


class FileStorage:
    """Local JSON-file storage (no MongoDB required)."""

    def __init__(self, base_dir):
        self.base = Path(base_dir)
        self.data_dir = self.base / "data"
        self.case_docs_dir = self.data_dir / "case_docs"
        self.drafts_dir = self.data_dir / "drafts"
        self.submissions_dir = self.base / "submissions"
        for d in (self.submissions_dir, self.data_dir, self.case_docs_dir, self.drafts_dir):
            d.mkdir(parents=True, exist_ok=True)
        self.annotators_file = self.data_dir / "annotators.json"
        self.admins_file = self.data_dir / "admins.json"
        self.cases_file = self.data_dir / "cases.json"
        self.assignments_file = self.data_dir / "assignments.json"
        self.index_file = self.data_dir / "submissions_index.json"
        self.config_file = self.data_dir / "config.json"
        self.secret_file = self.data_dir / "secret.key"

    def list_annotators(self):
        return _read_json_file(self.annotators_file, [])

    def save_annotators(self, annotators):
        _write_json_file(self.annotators_file, annotators)

    def list_admins(self):
        return _read_json_file(self.admins_file, [])

    def save_admins(self, admins):
        _write_json_file(self.admins_file, admins)

    def read_cases(self):
        return _read_json_file(self.cases_file, [])

    def save_cases(self, cases):
        _write_json_file(self.cases_file, cases)

    def read_assignments(self):
        return _read_json_file(self.assignments_file, {})

    def save_assignments(self, assignments):
        _write_json_file(self.assignments_file, assignments)

    def get_case_doc(self, case_id):
        path = self.case_docs_dir / f"{case_id}.json"
        return _read_json_file(path, None) if path.exists() else None

    def save_case_doc(self, case_id, doc):
        _write_json_file(self.case_docs_dir / f"{case_id}.json", doc)

    def get_draft(self, annotator_id, case_id):
        path = self.drafts_dir / annotator_id / f"case_{case_id}.json"
        return _read_json_file(path, None) if path.exists() else None

    def save_draft(self, annotator_id, case_id, payload):
        payload = dict(payload)
        payload["saved_at"] = datetime.now().isoformat()
        _write_json_file(self.drafts_dir / annotator_id / f"case_{case_id}.json", payload)
        return payload["saved_at"]

    def delete_draft(self, annotator_id, case_id):
        path = self.drafts_dir / annotator_id / f"case_{case_id}.json"
        if path.exists():
            path.unlink()

    def list_drafts(self):
        out = []
        for f in self.drafts_dir.glob("*/case_*.json"):
            out.append({
                "annotator_id": f.parent.name,
                "case_id": f.name.replace("case_", "").replace(".json", ""),
                "updated_at": datetime.fromtimestamp(f.stat().st_mtime).isoformat(),
            })
        return out

    def submissions_index(self):
        if self.index_file.exists():
            return _read_json_file(self.index_file, {})
        index = {}
        for sub_file in sorted(self.submissions_dir.glob("case_*.json")):
            data = _read_json_file(sub_file, {})
            cid = data.get("case_id") or sub_file.name.split("_")[1]
            index.setdefault(str(cid), []).append({
                "annotator_id": data.get("annotator_id"),
                "annotator_name": data.get("annotator_name"),
                "submitted_at": data.get("submitted_at"),
                "file": sub_file.name,
            })
        _write_json_file(self.index_file, index)
        return index

    def record_submission(self, case_id, summary, full_data):
        data = dict(full_data)
        data["annotator_id"] = summary["annotator_id"]
        data["annotator_name"] = summary["annotator_name"]
        data["submitted_at"] = summary["submitted_at"]
        data["received_at"] = datetime.now().isoformat()
        _write_json_file(self.submissions_dir / summary["file"], data)
        index = self.submissions_index()
        index.setdefault(str(case_id), []).append({
            "annotator_id": summary["annotator_id"],
            "annotator_name": summary["annotator_name"],
            "submitted_at": summary["submitted_at"],
            "file": summary["file"],
        })
        _write_json_file(self.index_file, index)

    def list_submissions(self):
        """Toàn bộ submission đầy đủ (phục vụ export)."""
        out = []
        for f in sorted(self.submissions_dir.glob("case_*.json")):
            data = _read_json_file(f, {})
            if data:
                out.append(data)
        return out

    def delete_submissions(self, case_id):
        """Xoá toàn bộ submission của một case."""
        removed = 0
        for f in list(self.submissions_dir.glob(f"case_{case_id}_*.json")):
            f.unlink()
            removed += 1
        if removed and self.index_file.exists():
            self.index_file.unlink()  # index tự dựng lại từ disk lần đọc sau
        return removed

    def read_config(self):
        return _read_json_file(self.config_file, {})

    def save_config(self, cfg):
        _write_json_file(self.config_file, cfg)

    def get_secret(self):
        return self.secret_file.read_text(encoding="utf-8").strip() if self.secret_file.exists() else None

    def set_secret(self, value):
        _write_json_file(self.secret_file, value)


class MongoStorage:
    """Persistent MongoDB storage for production deployment."""

    def __init__(self, db):
        self.db = db

    def list_annotators(self):
        return [a for a in self.db.annotators.find({})]

    def save_annotators(self, annotators):
        self.db.annotators.delete_many({})
        if annotators:
            self.db.annotators.insert_many(annotators)

    def list_admins(self):
        return [a for a in self.db.admins.find({})]

    def save_admins(self, admins):
        self.db.admins.delete_many({})
        if admins:
            self.db.admins.insert_many(admins)

    def read_cases(self):
        return [c for c in self.db.cases.find({})]

    def save_cases(self, cases):
        self.db.cases.delete_many({})
        if cases:
            self.db.cases.insert_many(cases)

    def read_assignments(self):
        doc = self.db.assignments.find_one({"_id": "map"})
        return (doc or {}).get("data", {})

    def save_assignments(self, assignments):
        self.db.assignments.replace_one({"_id": "map"}, {"_id": "map", "data": assignments}, upsert=True)

    def get_case_doc(self, case_id):
        doc = self.db.case_docs.find_one({"_id": case_id})
        return doc if doc else None

    def save_case_doc(self, case_id, doc):
        self.db.case_docs.replace_one({"_id": case_id}, dict(doc, _id=case_id), upsert=True)

    def get_draft(self, annotator_id, case_id):
        doc = self.db.drafts.find_one({"_id": f"{annotator_id}:{case_id}"})
        return doc.get("data") if doc else None

    def save_draft(self, annotator_id, case_id, payload):
        payload = dict(payload)
        payload["saved_at"] = datetime.now().isoformat()
        self.db.drafts.replace_one(
            {"_id": f"{annotator_id}:{case_id}"},
            {"_id": f"{annotator_id}:{case_id}", "annotator_id": annotator_id,
             "case_id": case_id, "saved_at": payload["saved_at"], "data": payload},
            upsert=True,
        )
        return payload["saved_at"]

    def delete_draft(self, annotator_id, case_id):
        self.db.drafts.delete_one({"_id": f"{annotator_id}:{case_id}"})

    def list_drafts(self):
        return [
            {"annotator_id": d["annotator_id"], "case_id": d["case_id"], "updated_at": d["saved_at"]}
            for d in self.db.drafts.find({})
        ]

    def submissions_index(self):
        index = {}
        for s in self.db.submissions.find({}):
            index.setdefault(s["case_id"], []).append({
                "annotator_id": s.get("annotator_id"),
                "annotator_name": s.get("annotator_name"),
                "submitted_at": s.get("submitted_at"),
                "file": s.get("file"),
            })
        return index

    def record_submission(self, case_id, summary, full_data):
        data = dict(full_data)
        data["annotator_id"] = summary["annotator_id"]
        data["annotator_name"] = summary["annotator_name"]
        data["submitted_at"] = summary["submitted_at"]
        data["received_at"] = datetime.now().isoformat()
        doc = dict(data, _id=summary["file"], case_id=str(case_id), file=summary["file"])
        self.db.submissions.replace_one({"_id": summary["file"]}, doc, upsert=True)

    def list_submissions(self):
        """Toàn bộ submission đầy đủ (phục vụ export)."""
        return list(self.db.submissions.find({}))

    def delete_submissions(self, case_id):
        """Xoá toàn bộ submission của một case."""
        res = self.db.submissions.delete_many({"case_id": str(case_id)})
        return res.deleted_count

    def read_config(self):
        doc = self.db.config.find_one({"_id": "admin"})
        return {k: v for k, v in (doc or {}).items() if k != "_id"}

    def save_config(self, cfg):
        self.db.config.replace_one({"_id": "admin"}, dict(cfg, _id="admin"), upsert=True)

    def get_secret(self):
        doc = self.db.secrets.find_one({"_id": "token"})
        return doc.get("value") if doc else None

    def set_secret(self, value):
        self.db.secrets.replace_one({"_id": "token"}, {"_id": "token", "value": value}, upsert=True)


# choose backend
_client = None
if MONGODB_URI:
    import certifi
    from pymongo import MongoClient

    # certifi.wheres() ships a trusted CA bundle that works on macOS, Linux and
    # container runtimes alike, avoiding "CERTIFICATE_VERIFY_FAILED" on macOS.
    _client = MongoClient(MONGODB_URI, serverSelectionTimeoutMS=10000, tlsCAFile=certifi.where())
    # KHÔNG crash nếu MongoDB đang ngủ/chưa sẵn sàng (M0 free tier ngủ sau 60 phút
    # không truy cập và có thể lỗi TLS tạm thời khi thức dậy). Backend vẫn khởi động
    # và tự kết nối lại ở các request sau.
    try:
        _client.admin.command("ping", serverSelectionTimeoutMS=10000)
    except Exception as exc:
        print(f"WARNING: MongoDB chưa sẵn sàng lúc khởi động: {exc}")
        print("Backend vẫn chạy; kết nối sẽ tự phục hồi khi MongoDB hoạt động lại.")
    try:
        _db = _client.get_default_database()
    except Exception:
        _db = _client[MONGODB_DB or "legal_annotation"]
    storage = MongoStorage(_db)
    _STORAGE_NAME = "mongodb"
else:
    storage = FileStorage(BASE_DIR)
    _STORAGE_NAME = "files"


app = FastAPI()


app.add_middleware(
    CORSMiddleware,
    allow_origins=ALLOWED_ORIGINS,
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)


# ------------------------------ password / secret ------------------------------

def _hash_password(password, salt=None):
    if not salt:
        salt = secrets.token_hex(16)
    dk = hashlib.pbkdf2_hmac("sha256", password.encode("utf-8"), salt.encode("utf-8"), 100_000)
    return salt, dk.hex()


def _ensure_admins():
    """Tạo danh sách admin. Nếu đã có thì giữ nguyên.
    Hỗ trợ migrate từ bản cũ (config) để mật khẩu admin hiện tại vẫn dùng được."""
    admins = storage.list_admins()
    if admins:
        return
    cfg = storage.read_config()
    if cfg.get("admin_password_hash"):
        # bản cũ lưu hash trong config -> chuyển sang danh sách admin
        admins.append({
            "username": cfg.get("admin_username", "admin"),
            "name": cfg.get("admin_username", "admin"),
            "password_salt": cfg.get("admin_password_salt", ""),
            "password_hash": cfg.get("admin_password_hash", ""),
            "created_at": datetime.now().isoformat(),
        })
        storage.save_admins(admins)
        return
    password = ENV_ADMIN_PASSWORD or "admin123"
    salt, hashed = _hash_password(password)
    admins.append({
        "username": ENV_ADMIN_USERNAME,
        "name": "Admin",
        "password_salt": salt,
        "password_hash": hashed,
        "created_at": datetime.now().isoformat(),
    })
    storage.save_admins(admins)
    if not ENV_ADMIN_PASSWORD:
        print(
            "WARNING: ADMIN_PASSWORD env var not set; using default 'admin123'. "
            "Set ADMIN_PASSWORD in production."
        )


def _secret():
    if ENV_SECRET:
        return ENV_SECRET
    existing = storage.get_secret()
    if existing:
        return existing
    secret = secrets.token_hex(32)
    storage.set_secret(secret)
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
    for a in storage.list_annotators():
        if a["id"] == annotator_id:
            return a["name"]
    return annotator_id


def _admin_name(username):
    for a in storage.list_admins():
        if a["username"] == username:
            return a.get("name") or a["username"]
    return username


def _registry_by_id():
    return {c["case_id"]: c for c in storage.read_cases()}


def _norm_assignments(raw):
    """Chuẩn hoá assignments: {cid: str|list} -> {cid: [str,...]} (hỗ trợ dữ liệu cũ)."""
    out = {}
    for cid, v in (raw or {}).items():
        out[cid] = v if isinstance(v, list) else ([v] if v else [])
    return out


def _set_case_status(case_id, status, completed_by=None):
    registry = storage.read_cases()
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
    storage.save_cases(registry)


try:
    _ensure_admins()
except Exception as exc:
    # MongoDB chưa sẵn sàng -> bỏ qua lúc khởi động, sẽ tự khởi tạo lại khi có request
    print(f"WARNING: Chưa thể khởi tạo admin lúc này (MongoDB chưa sẵn sàng): {exc}")


# ------------------------------ public ------------------------------

@app.get("/api/health")
def health():
    """Dùng cho uptime monitor — ping DB để giữ cả Render lẫn MongoDB thức."""
    ok = True
    detail = "ok"
    if _STORAGE_NAME == "mongodb" and _client is not None:
        try:
            _client.admin.command("ping", serverSelectionTimeoutMS=5000)
        except Exception as exc:
            ok = False
            detail = str(exc)[:200]
    return {"status": "ok" if ok else "degraded", "storage": _STORAGE_NAME, "detail": detail}


@app.get("/")
def root():
    return {
        "message": "Legal annotation backend is running",
        "storage": _STORAGE_NAME,
        "endpoints": [
            "POST /api/auth/admin",
            "POST /api/auth/annotator",
            "POST /api/auth/admin/change-password",
            "GET/POST /api/admins (admin)",
            "PUT/DELETE /api/admins/{username} (admin)",
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
            "DELETE /api/cases/{id}/submissions (admin)",
            "DELETE /api/assignments (admin, xoá toàn bộ phân công)",
        ],
    }


# ------------------------------ auth ------------------------------

@app.post("/api/auth/admin")
def admin_login(payload: dict):
    username = str(payload.get("username", "")).strip().lower()
    password = str(payload.get("password", ""))
    admins = storage.list_admins()
    found = next((a for a in admins if a["username"].lower() == username), None)
    if not found:
        raise HTTPException(status_code=401, detail="Sai tên đăng nhập hoặc mật khẩu.")
    _, hashed = _hash_password(password, found.get("password_salt", ""))
    if not hmac.compare_digest(hashed, found.get("password_hash", "")):
        raise HTTPException(status_code=401, detail="Sai tên đăng nhập hoặc mật khẩu.")
    return {
        "type": "admin",
        "id": found["username"],
        "name": found.get("name") or found["username"],
        "token": _make_token("admin", found["username"], hours=12),
    }


@app.post("/api/auth/annotator")
def annotator_login(payload: dict):
    name = str(payload.get("name", "")).strip()
    passcode = str(payload.get("passcode", ""))
    annotators = storage.list_annotators()
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
    auth = _require_admin(request)
    current_password = str(payload.get("current_password", ""))
    new_password = str(payload.get("new_password", ""))
    if len(new_password) < 6:
        raise HTTPException(status_code=400, detail="Mật khẩu mới phải có ít nhất 6 ký tự.")
    admins = storage.list_admins()
    found = next((a for a in admins if a["username"] == auth["id"]), None)
    if not found:
        raise HTTPException(status_code=404, detail="Không tìm thấy tài khoản admin.")
    _, hashed = _hash_password(current_password, found.get("password_salt", ""))
    if not hmac.compare_digest(hashed, found.get("password_hash", "")):
        raise HTTPException(status_code=401, detail="Mật khẩu hiện tại không đúng.")
    salt, h = _hash_password(new_password)
    found["password_salt"] = salt
    found["password_hash"] = h
    storage.save_admins(admins)
    return {"success": True, "message": "Đã đổi mật khẩu."}


# ------------------------------ admin management (admin) ------------------------------

def _sanitize_admin(admin):
    return {
        "username": admin["username"],
        "name": admin.get("name", ""),
        "created_at": admin.get("created_at"),
    }


@app.get("/api/admins")
def list_admins(request: Request):
    _require_admin(request)
    return [_sanitize_admin(a) for a in storage.list_admins()]


@app.post("/api/admins")
def create_admin(payload: dict, request: Request):
    _require_admin(request)
    username = str(payload.get("username", "")).strip().lower()
    password = str(payload.get("password", ""))
    name = str(payload.get("name", "")).strip() or username
    if not re.match(r"^[a-z0-9_\-]+$", username):
        raise HTTPException(status_code=400, detail="Username chỉ gồm chữ thường, số, gạch dưới, gạch ngang.")
    if len(password) < 6:
        raise HTTPException(status_code=400, detail="Mật khẩu phải có ít nhất 6 ký tự.")
    admins = storage.list_admins()
    if any(a["username"] == username for a in admins):
        raise HTTPException(status_code=409, detail="Username admin đã tồn tại.")
    salt, hashed = _hash_password(password)
    admins.append({
        "username": username,
        "name": name,
        "password_salt": salt,
        "password_hash": hashed,
        "created_at": datetime.now().isoformat(),
    })
    storage.save_admins(admins)
    return _sanitize_admin(admins[-1])


@app.put("/api/admins/{username}")
def update_admin(username: str, payload: dict, request: Request):
    _require_admin(request)
    username = _safe_id(username).lower()
    admins = storage.list_admins()
    found = next((a for a in admins if a["username"] == username), None)
    if not found:
        raise HTTPException(status_code=404, detail="Không tìm thấy admin.")
    new_name = str(payload.get("name", "")).strip()
    if new_name:
        found["name"] = new_name
    new_password = str(payload.get("password", ""))
    if new_password:
        if len(new_password) < 6:
            raise HTTPException(status_code=400, detail="Mật khẩu phải có ít nhất 6 ký tự.")
        salt, hashed = _hash_password(new_password)
        found["password_salt"] = salt
        found["password_hash"] = hashed
    storage.save_admins(admins)
    return _sanitize_admin(found)


@app.delete("/api/admins/{username}")
def delete_admin(username: str, request: Request):
    auth = _require_admin(request)
    username = _safe_id(username).lower()
    admins = storage.list_admins()
    if auth["id"] == username:
        raise HTTPException(status_code=400, detail="Không thể xoá chính mình.")
    if len(admins) <= 1:
        raise HTTPException(status_code=400, detail="Không thể xoá admin cuối cùng.")
    admins = [a for a in admins if a["username"] != username]
    storage.save_admins(admins)
    return {"success": True}


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
    return [_sanitize_annotator(a) for a in storage.list_annotators()]


@app.post("/api/annotators")
def create_annotator(payload: dict, request: Request):
    _require_admin(request)
    name = str(payload.get("name", "")).strip()
    passcode = str(payload.get("passcode", ""))
    if not name:
        raise HTTPException(status_code=400, detail="Cần nhập tên annotator.")
    if len(passcode) < 4:
        raise HTTPException(status_code=400, detail="Mã annotator phải có ít nhất 4 ký tự.")
    annotators = storage.list_annotators()
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
    storage.save_annotators(annotators)
    return _sanitize_annotator(annotator, with_passcode=True)


@app.put("/api/annotators/{annotator_id}")
def update_annotator(annotator_id: str, payload: dict, request: Request):
    _require_admin(request)
    annotator_id = _safe_id(annotator_id)
    annotators = storage.list_annotators()
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
    storage.save_annotators(annotators)
    return _sanitize_annotator(found, with_passcode=bool(new_passcode))


@app.delete("/api/annotators/{annotator_id}")
def delete_annotator(annotator_id: str, request: Request):
    _require_admin(request)
    annotator_id = _safe_id(annotator_id)
    annotators = storage.list_annotators()
    annotators = [a for a in annotators if a["id"] != annotator_id]
    storage.save_annotators(annotators)
    assignments = _norm_assignments(storage.read_assignments())
    changed = False
    for cid, ids in list(assignments.items()):
        if annotator_id in ids:
            new_ids = [x for x in ids if x != annotator_id]
            if new_ids:
                assignments[cid] = new_ids
            else:
                del assignments[cid]
            changed = True
    if changed:
        storage.save_assignments(assignments)
    for d in storage.list_drafts():
        if d["annotator_id"] == annotator_id:
            storage.delete_draft(annotator_id, d["case_id"])
    return {"success": True}


# ------------------------------ case corpus (admin import) ------------------------------

@app.post("/api/cases")
def import_cases(payload: dict, request: Request):
    _require_admin(request)
    docs = payload.get("cases", []) or []
    registry = storage.read_cases()
    by_id = {c["case_id"]: c for c in registry}
    imported = 0
    for doc in docs:
        cid = _safe_id(doc.get("id") or doc.get("case_id") or "")
        if not cid:
            continue
        storage.save_case_doc(cid, doc)
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
    storage.save_cases(result)
    return {"imported": imported, "total_cases": len(result)}


# ------------------------------ assignment ------------------------------

@app.post("/api/cases/{case_id}/assign")
def assign_case(case_id: str, payload: dict, request: Request):
    """Thêm/bớt annotator cho một case. Mỗi annotator chỉ xuất hiện 1 lần/case."""
    _require_admin(request)
    case_id = _safe_id(case_id)
    annotator_id = payload.get("annotator_id")
    remove = bool(payload.get("remove"))
    assignments = _norm_assignments(storage.read_assignments())

    if annotator_id:
        annotator_id = _safe_id(str(annotator_id))
        if not any(a["id"] == annotator_id for a in storage.list_annotators()):
            raise HTTPException(status_code=400, detail="Annotator không tồn tại.")
        cur = assignments.get(case_id, [])
        if remove:
            cur = [x for x in cur if x != annotator_id]
        elif annotator_id not in cur:
            cur.append(annotator_id)
        if cur:
            assignments[case_id] = cur
        else:
            assignments.pop(case_id, None)
    else:
        # annotator_id = null -> xoá toàn bộ phân công của case
        assignments.pop(case_id, None)
    storage.save_assignments(assignments)
    return {"case_id": case_id, "annotator_ids": assignments.get(case_id, [])}


@app.delete("/api/assignments")
def clear_all_assignments(request: Request):
    """Xoá toàn bộ phân công của tất cả case."""
    _require_admin(request)
    storage.save_assignments({})
    return {"success": True, "cleared": True}


@app.post("/api/cases/{case_id}/reopen")
def reopen_case(case_id: str, request: Request):
    _require_admin(request)
    case_id = _safe_id(case_id)
    registry = storage.read_cases()
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
    storage.save_cases(registry)
    return {"success": True, "case_id": case_id, "status": "open"}


@app.post("/api/cases/auto-assign")
def auto_assign(request: Request):
    """PHÂN CÔNG LŨY TIẾN — mỗi lần bấm chỉ thêm ĐÚNG 1 annotator cho mỗi case open:
    lần 1: mỗi case 1 annotator; lần 2: thêm annotator khác (2/case); lần 3: thêm nữa...
    Annotator trong cùng case luôn KHÁC NHAU, cân bằng theo khối lượng công việc."""
    _require_admin(request)
    annotators = storage.list_annotators()
    if not annotators:
        raise HTTPException(status_code=400, detail="Chưa có annotator nào. Hãy tạo annotator trước.")
    annotator_ids = [a["id"] for a in annotators]
    registry = storage.read_cases()
    assignments = _norm_assignments(storage.read_assignments())

    open_cases = sorted(
        c["case_id"] for c in registry if c.get("status") != "completed"
    )

    def workload_of(aid):
        return sum(1 for cid in open_cases if aid in assignments.get(cid, []))

    workload = {aid: workload_of(aid) for aid in annotator_ids}

    added = 0
    for cid in open_cases:
        cur = [x for x in assignments.get(cid, []) if x in annotator_ids]
        # case đã đủ mọi annotator hiện có -> bỏ qua
        if len(cur) >= len(annotator_ids):
            continue
        candidates = [aid for aid in annotator_ids if aid not in cur]
        if not candidates:
            continue
        aid = min(candidates, key=lambda a: workload[a])
        cur.append(aid)
        workload[aid] += 1
        added += 1
        assignments[cid] = cur

    storage.save_assignments(assignments)

    per_case = {}
    for cid in open_cases:
        n = len(assignments.get(cid, []))
        per_case[str(n)] = per_case.get(str(n), 0) + 1

    return {
        "assigned": added,           # số lượt gán thêm ở lần bấm này
        "total_open": len(open_cases),
        "distribution": per_case,    # VD {"1": 10} sau lần 1; {"2": 10} sau lần 2
    }


# ------------------------------ views ------------------------------

@app.get("/api/annotator/cases")
def annotator_cases(request: Request):
    """Annotator's own cases only — no visibility into other annotators.
    Case hiển thị cho annotator tới khi CHÍNH annotator đó submit
    (case có nhiều annotator sẽ còn lại cho người kia tới khi họ submit)."""
    auth = _require_annotator(request)
    assignments = _norm_assignments(storage.read_assignments())
    registry = _registry_by_id()
    submissions_index = storage.submissions_index()

    open_cases = []
    all_assigned = 0
    done = 0
    for cid, ids in assignments.items():
        if auth["id"] not in ids:
            continue
        all_assigned += 1
        reg = registry.get(cid)
        if reg is None:
            continue
        submitted_ids = {s.get("annotator_id") for s in submissions_index.get(cid, [])}
        if reg.get("status") == "completed" or auth["id"] in submitted_ids:
            done += 1
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
            "completed": done,
            "remaining": len(open_cases),
        },
    }


@app.get("/api/cases")
def admin_overview(request: Request):
    _require_admin(request)
    registry = storage.read_cases()
    assignments = _norm_assignments(storage.read_assignments())
    submissions_index = storage.submissions_index()
    drafts = storage.list_drafts()

    drafts_by_case = {}
    for d in drafts:
        drafts_by_case.setdefault(d["case_id"], []).append({
            "annotator_id": d["annotator_id"],
            "updated_at": d["updated_at"],
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
            "assigned_to": assignments.get(cid) or [],
            "submissions": submissions_index.get(cid, []),
            "drafts": drafts_by_case.get(cid, []),
        })
    return result


@app.get("/api/cases/{case_id}/doc")
def get_case_doc(case_id: str, request: Request):
    auth = _require_auth(request)
    case_id = _safe_id(case_id)
    doc = storage.get_case_doc(case_id)
    if doc is None:
        raise HTTPException(status_code=404, detail="Không tìm thấy case.")
    if auth["type"] == "annotator":
        assignments = _norm_assignments(storage.read_assignments())
        if auth["id"] not in assignments.get(case_id, []):
            raise HTTPException(status_code=403, detail="Case này không được phân công cho bạn.")
    return doc


# ------------------------------ drafts (annotator only) ------------------------------

@app.get("/api/cases/{case_id}/draft")
def get_draft(case_id: str, request: Request):
    auth = _require_annotator(request)
    case_id = _safe_id(case_id)
    draft = storage.get_draft(auth["id"], case_id)
    if draft is None:
        raise HTTPException(status_code=404, detail="Chưa có nháp.")
    return draft


@app.put("/api/cases/{case_id}/draft")
def save_draft(case_id: str, payload: dict, request: Request):
    auth = _require_annotator(request)
    case_id = _safe_id(case_id)
    saved_at = storage.save_draft(auth["id"], case_id, payload)
    return {"success": True, "case_id": case_id, "saved_at": saved_at}


@app.delete("/api/cases/{case_id}/draft")
def delete_draft(case_id: str, request: Request):
    auth = _require_annotator(request)
    case_id = _safe_id(case_id)
    storage.delete_draft(auth["id"], case_id)
    return {"success": True}


# ------------------------------ submission ------------------------------

@app.post("/api/submit")
def submit_case(payload: dict, request: Request):
    auth = _require_auth(request)
    case_id = _safe_id(str(payload.get("case_id", "")))
    if not case_id:
        raise HTTPException(status_code=400, detail="Thiếu case_id.")
    if storage.get_case_doc(case_id) is None:
        raise HTTPException(status_code=404, detail="Không tìm thấy case.")

    # annotators may only submit cases assigned to them; admin may submit any
    assigned_ids = []
    if auth["type"] == "annotator":
        assignments = _norm_assignments(storage.read_assignments())
        assigned_ids = assignments.get(case_id, [])
        if auth["id"] not in assigned_ids:
            raise HTTPException(status_code=403, detail="Case này không được phân công cho bạn.")

    annotator_id = auth["id"]
    annotator_name = _admin_name(auth["id"]) if auth["type"] == "admin" else _annotator_name(auth["id"])

    timestamp = datetime.now().strftime("%Y%m%d_%H%M%S")
    filename = f"case_{case_id}_{timestamp}.json"
    summary = {
        "annotator_id": annotator_id,
        "annotator_name": annotator_name,
        "submitted_at": payload.get("submitted_at"),
        "file": filename,
    }
    storage.record_submission(case_id, summary, payload)

    if auth["type"] == "admin":
        # admin submit -> luôn hoàn thành
        _set_case_status(case_id, "completed", completed_by=annotator_id)
    else:
        # annotator: case hoàn thành khi TẤT CẢ annotator được giao đã submit
        submitted_ids = {s.get("annotator_id") for s in storage.submissions_index().get(case_id, [])}
        if all(aid in submitted_ids for aid in assigned_ids):
            _set_case_status(case_id, "completed", completed_by=annotator_id)

    storage.delete_draft(annotator_id, case_id)

    final_status = _registry_by_id().get(case_id, {}).get("status", "open")
    return {
        "success": True,
        "case_id": case_id,
        "annotator_id": annotator_id,
        "annotator_name": annotator_name,
        "file": filename,
        "status": final_status,
    }


# ------------------------------ export (admin, cho nghiên cứu) ------------------------------

@app.get("/api/export/submissions")
def export_submissions(request: Request):
    """Toàn bộ submission (payload đầy đủ) dạng JSON — dành cho nghiên cứu."""
    _require_admin(request)
    subs = storage.list_submissions()
    subs.sort(key=lambda s: (str(s.get("case_id", "")), str(s.get("submitted_at", "") or "")))
    return {
        "exported_at": datetime.now().isoformat(),
        "count": len(subs),
        "submissions": subs,
    }


@app.get("/api/export/submissions.csv")
def export_submissions_csv(request: Request):
    """Bảng tóm tắt CSV (1 dòng/submission) — mở được bằng Excel."""
    _require_admin(request)
    subs = storage.list_submissions()
    subs.sort(key=lambda s: (str(s.get("case_id", "")), str(s.get("submitted_at", "") or "")))

    import csv
    import io

    buf = io.StringIO()
    writer = csv.writer(buf)
    writer.writerow([
        "case_id", "title", "annotator_id", "annotator_name",
        "submitted_at", "received_at", "file",
        "num_units", "num_confirmed", "outcomes", "num_reasoning", "num_decisions",
    ])
    for s in subs:
        units = s.get("units") or []
        reasoning = s.get("reasoning") or []
        decisions = s.get("decisions") or []
        requests = [u for u in units if u.get("type") == "request"]
        outcomes = ";".join(str(r.get("outcome") or "") for r in requests)
        writer.writerow([
            s.get("case_id", ""),
            s.get("title", ""),
            s.get("annotator_id", ""),
            s.get("annotator_name", ""),
            s.get("submitted_at", ""),
            s.get("received_at", ""),
            s.get("file", ""),
            len(units),
            sum(1 for u in units if u.get("status") == "confirmed"),
            outcomes,
            len(reasoning),
            len(decisions),
        ])

    content = "\ufeff" + buf.getvalue()  # BOM để Excel đọc tiếng Việt đúng
    return Response(
        content=content,
        media_type="text/csv; charset=utf-8",
        headers={"Content-Disposition": 'attachment; filename="submissions.csv"'},
    )


@app.delete("/api/cases/{case_id}/submissions")
def delete_case_submissions(case_id: str, request: Request):
    """Admin xoá toàn bộ bài gửi của một case và mở lại case đó."""
    _require_admin(request)
    case_id = _safe_id(case_id)
    removed = storage.delete_submissions(case_id)
    # hết bài gửi -> case quay lại trạng thái mở
    _set_case_status(case_id, "open")
    return {"success": True, "case_id": case_id, "deleted": removed, "status": "open"}


def _safe_id(value):
    """Sanitise ids coming from URLs to prevent path traversal."""
    return re.sub(r"[^A-Za-z0-9_\-]", "", str(value))
