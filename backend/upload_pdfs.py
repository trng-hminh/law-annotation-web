#!/usr/bin/env python3
"""Bulk-upload PDFs to the legal annotation backend.

Naming convention
-----------------
Each PDF must be named after its case_id:
  20889.pdf
  332.pdf
  etc.

Usage
-----
  ADMIN_PASSWORD='your-password' python upload_pdfs.py --dir /path/to/pdfs --url http://localhost:8000 --user admin

Options
-------
  --dir    Folder containing the PDF files  (required)
  --url    Backend base URL                 (default: http://localhost:8000)
  --user   Admin username                   (default: admin)
  --pass   Admin password (or ADMIN_PASSWORD environment variable)
  --dry    Dry-run: only print what would be uploaded, don't actually upload
"""

import argparse
import getpass
import json
import os
import re
import sys
from pathlib import Path

try:
    import requests
except ImportError:
    print("ERROR: 'requests' library not found. Run:  pip install requests")
    sys.exit(1)


def login(base_url: str, username: str, password: str) -> str:
    resp = requests.post(
        f"{base_url}/api/auth/admin",
        json={"username": username, "password": password},
        timeout=120,
    )
    if not resp.ok:
        print(f"ERROR: Login failed — {resp.status_code} {resp.text}")
        sys.exit(1)
    token = resp.json().get("token")
    if not token:
        print("ERROR: No token returned from login.")
        sys.exit(1)
    print(f"Logged in as '{username}'.")
    return token


def upload_pdf(base_url: str, token: str, case_id: str, pdf_path: Path) -> bool:
    with pdf_path.open("rb") as f:
        resp = requests.post(
            f"{base_url}/api/cases/{case_id}/pdf",
            headers={"Authorization": f"Bearer {token}"},
            files={"file": (pdf_path.name, f, "application/pdf")},
            timeout=120,
        )
    if resp.ok:
        size_kb = resp.json().get("size", 0) // 1024
        print(f"  [OK] case {case_id:>10}  {pdf_path.name}  ({size_kb} KB)")
        return True
    else:
        detail = ""
        try:
            detail = resp.json().get("detail", "")
        except Exception:
            pass
        print(f"  [FAIL] case {case_id:>10}  {pdf_path.name}  → {resp.status_code} {detail}")
        return False


def main():
    parser = argparse.ArgumentParser(description="Bulk-upload PDFs to legal annotation backend.")
    parser.add_argument("--dir",  required=True, help="Folder containing PDF files named <case_id>.pdf")
    parser.add_argument("--url",  default="http://localhost:8000", help="Backend base URL")
    parser.add_argument("--user", default="admin", help="Admin username")
    parser.add_argument("--pass", dest="password", help="Admin password (or set ADMIN_PASSWORD)")
    parser.add_argument("--dry",  action="store_true", help="Dry-run only")
    parser.add_argument("--recursive", action="store_true", help="Include self_annotate/expert subfolders")
    parser.add_argument("--manifest", help="Validate PDF IDs and folder groups against a cases JSON file")
    args = parser.parse_args()

    pdf_dir = Path(args.dir).expanduser().resolve()
    if not pdf_dir.is_dir():
        print(f"ERROR: '{pdf_dir}' is not a directory.")
        sys.exit(1)

    pdfs = sorted(p for p in (pdf_dir.rglob("*") if args.recursive else pdf_dir.iterdir())
                  if p.is_file() and p.suffix.lower() == ".pdf")
    if not pdfs:
        print(f"No PDF files found in '{pdf_dir}'.")
        sys.exit(0)

    print(f"Found {len(pdfs)} PDF file(s) in {pdf_dir}")

    # Existing corpora use ban_3184.pdf; the API's actual case ID is 3184.
    def case_id_of(path):
        return path.stem.removeprefix("ban_")

    ids = [case_id_of(p) for p in pdfs]
    if len(set(ids)) != len(ids):
        parser.error("Duplicate case IDs in PDF folders; choose one PDF per case.")
    if any(not re.fullmatch(r"[A-Za-z0-9_-]+", cid) for cid in ids):
        parser.error("PDF filenames must use <case_id>.pdf or ban_<case_id>.pdf.")
    if any(p.stat().st_size > 15 * 1024 * 1024 for p in pdfs):
        parser.error("A PDF exceeds the backend limit of 15 MiB.")
    if args.manifest:
        from case_schema import case_type
        data = json.loads(Path(args.manifest).read_text(encoding="utf-8-sig"))
        cases = data if isinstance(data, list) else data["cases"]
        expected = {str(c.get("id") or c["case_id"]): case_type(c.get("type")) for c in cases}
        unknown = set(ids) - set(expected)
        if unknown:
            parser.error(f"PDFs absent from manifest: {sorted(unknown)}")
        for p in pdfs:
            folder_mode = case_type(p.parent.name)
            if folder_mode and folder_mode != expected[case_id_of(p)]:
                parser.error(f"Folder/type mismatch: {p.name}")
        print(f"Manifest matches {len(ids)} PDF IDs; {len(set(expected) - set(ids))} cases outside this upload.")

    if args.dry:
        print("\n-- DRY RUN (no uploads will happen) --")
        for p in pdfs:
            case_id = case_id_of(p)
            print(f"  would upload: {p.name}  → case_id={case_id}")
        return

    password = args.password or os.environ.get("ADMIN_PASSWORD", "") or getpass.getpass("Admin password: ")
    if not password:
        parser.error("Provide --pass or set ADMIN_PASSWORD; no default production password is used.")

    token = login(args.url, args.user, password)

    ok = 0
    fail = 0
    print(f"\nUploading to {args.url} ...\n")
    for p in pdfs:
        case_id = case_id_of(p)
        if upload_pdf(args.url, token, case_id, p):
            ok += 1
        else:
            fail += 1

    print(f"\nDone. {ok} uploaded, {fail} failed.")
    if fail:
        sys.exit(1)


if __name__ == "__main__":
    main()
