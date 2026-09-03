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
import os
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
        timeout=15,
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
    args = parser.parse_args()

    pdf_dir = Path(args.dir).expanduser().resolve()
    if not pdf_dir.is_dir():
        print(f"ERROR: '{pdf_dir}' is not a directory.")
        sys.exit(1)

    pdfs = sorted(pdf_dir.glob("*.pdf"))
    if not pdfs:
        print(f"No PDF files found in '{pdf_dir}'.")
        sys.exit(0)

    print(f"Found {len(pdfs)} PDF file(s) in {pdf_dir}")

    if args.dry:
        print("\n-- DRY RUN (no uploads will happen) --")
        for p in pdfs:
            case_id = p.stem  # filename without extension
            print(f"  would upload: {p.name}  → case_id={case_id}")
        return

    password = args.password or os.environ.get("ADMIN_PASSWORD", "")
    if not password:
        parser.error("Provide --pass or set ADMIN_PASSWORD; no default production password is used.")

    token = login(args.url, args.user, password)

    ok = 0
    fail = 0
    print(f"\nUploading to {args.url} ...\n")
    for p in pdfs:
        case_id = p.stem  # "20889.pdf" → "20889"
        if upload_pdf(args.url, token, case_id, p):
            ok += 1
        else:
            fail += 1

    print(f"\nDone. {ok} uploaded, {fail} failed.")
    if fail:
        sys.exit(1)


if __name__ == "__main__":
    main()
