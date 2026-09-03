"""Isolated regression tests for the legal-annotation HTTP API.

These tests import the application with a temporary bootstrap directory and
an explicitly blank ``MONGODB_URI``. Each test then replaces ``main.storage``
with a fresh ``FileStorage`` rooted in another temporary directory. They never
use the configured MongoDB database or the repository's ``backend/data``
directory.

Run from the repository root (after installing backend requirements):

    backend/.venv/bin/python -m unittest backend/test_api_integration.py -v

``fastapi.testclient`` uses httpx; install ``httpx>=0.28,<1`` in a clean test
environment. No pytest-specific features are used.
"""

from __future__ import annotations

import csv
import io
import os
import sys
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch

from fastapi.testclient import TestClient


# The backend is deliberately a single-file application rather than a Python
# package.  Adding its directory makes this test runnable both as a script and
# through ``python -m unittest`` from the repository root.
BACKEND_DIR = Path(__file__).resolve().parent
if str(BACKEND_DIR) not in sys.path:
    sys.path.insert(0, str(BACKEND_DIR))

# Import-time application setup normally selects MongoDB from the caller's
# environment and creates FileStorage under backend/. Keep even that bootstrap
# work entirely temporary before the per-test storage rebinding below.
_IMPORT_TEMP_STORAGE = tempfile.TemporaryDirectory(prefix="legal-annotation-import-")
_IMPORT_MAIN_PATH = Path(_IMPORT_TEMP_STORAGE.name) / "main.py"
with patch.dict(
    os.environ,
    {
        "MONGODB_URI": "",
        "MONGODB_DB": "",
        "SECRET_KEY": "isolated-module-import-secret",
        "ADMIN_USERNAME": "isolated-module-import-admin",
        "ADMIN_PASSWORD": "isolated-module-import-password",
    },
    clear=False,
):
    with patch.object(Path, "resolve", return_value=_IMPORT_MAIN_PATH):
        import main  # noqa: E402  (must follow the isolated import setup above)


PDF_BYTES = b"%PDF-1.4\n1 0 obj\n<< /Type /Catalog >>\nendobj\n%%EOF\n"
PDF_LIMIT_BYTES = 15 * 1024 * 1024


class ApiIntegrationTests(unittest.TestCase):
    """End-to-end API tests against a fresh, on-disk temporary FileStorage."""

    ADMIN_USERNAME = "integration-admin"
    ADMIN_PASSWORD = "integration-admin-password"
    TEST_SECRET = "integration-test-secret-that-is-never-used-in-production"

    def setUp(self):
        self._tempdir = tempfile.TemporaryDirectory(prefix="legal-annotation-api-")
        self._original_storage = main.storage
        self._original_secret = main.ENV_SECRET
        self._original_admin_username = main.ENV_ADMIN_USERNAME
        self._original_admin_password = main.ENV_ADMIN_PASSWORD

        # Do not let tests depend on or modify a developer's local admin,
        # secret, JSON corpus, submissions, or deployed MongoDB data.
        main.storage = main.FileStorage(self._tempdir.name)
        main.ENV_SECRET = self.TEST_SECRET
        main.ENV_ADMIN_USERNAME = self.ADMIN_USERNAME
        main.ENV_ADMIN_PASSWORD = self.ADMIN_PASSWORD
        main._ensure_admins()

        self.client = TestClient(main.app)
        self.admin_token = self._login_admin()

    def tearDown(self):
        self.client.close()
        main.storage = self._original_storage
        main.ENV_SECRET = self._original_secret
        main.ENV_ADMIN_USERNAME = self._original_admin_username
        main.ENV_ADMIN_PASSWORD = self._original_admin_password
        self._tempdir.cleanup()

    def _assert_status(self, response, expected_status):
        self.assertEqual(response.status_code, expected_status, response.text)
        return response

    @staticmethod
    def _auth(token):
        return {"Authorization": f"Bearer {token}"}

    def _login_admin(self, password=None):
        response = self.client.post(
            "/api/auth/admin",
            json={
                "username": self.ADMIN_USERNAME,
                "password": password or self.ADMIN_PASSWORD,
            },
        )
        self._assert_status(response, 200)
        return response.json()["token"]

    def _create_annotator(self, name="Integration Annotator", passcode="pass-1234"):
        response = self.client.post(
            "/api/annotators",
            headers=self._auth(self.admin_token),
            json={"name": name, "passcode": passcode},
        )
        self._assert_status(response, 200)
        return response.json()

    def _login_annotator(self, name="Integration Annotator", passcode="pass-1234"):
        response = self.client.post(
            "/api/auth/annotator",
            json={"name": name, "passcode": passcode},
        )
        self._assert_status(response, 200)
        return response.json()["token"]

    def _import_cases(self, *cases):
        response = self.client.post(
            "/api/cases",
            headers=self._auth(self.admin_token),
            json={"cases": list(cases)},
        )
        self._assert_status(response, 200)
        return response.json()

    def _assign(self, case_id, annotator_id):
        response = self.client.post(
            f"/api/cases/{case_id}/assign",
            headers=self._auth(self.admin_token),
            json={"annotator_id": annotator_id},
        )
        self._assert_status(response, 200)
        return response.json()

    def _upload_pdf(self, case_id, data=PDF_BYTES, filename="case.pdf", token=None):
        return self.client.post(
            f"/api/cases/{case_id}/pdf",
            headers=self._auth(token or self.admin_token),
            files={"file": (filename, data, "application/pdf")},
        )

    def test_json_case_import_preserves_documents_and_enforces_case_access(self):
        first_case = {
            "id": "case-101",
            "title": "First imported case",
            "facts": [{"id": "fact-1", "text": "A material fact."}],
        }
        second_case = {
            "case_id": "case-102",
            "title": "Second imported case",
            "requests": [{"id": "request-1", "text": "A request."}],
        }

        # Corpus import is privileged, and a well-formed JSON corpus is stored
        # as its original case document rather than just as a registry summary.
        self._assert_status(self.client.post("/api/cases", json={"cases": [first_case]}), 401)
        result = self._import_cases(first_case, second_case)
        self.assertEqual(result["imported"], 2)
        self.assertEqual(result["skipped"], 0)
        self.assertEqual(result["total_cases"], 2)

        overview = self._assert_status(
            self.client.get("/api/cases", headers=self._auth(self.admin_token)), 200
        ).json()
        self.assertEqual(
            [(case["case_id"], case["title"]) for case in overview],
            [("case-101", "First imported case"), ("case-102", "Second imported case")],
        )
        self.assertEqual(
            self._assert_status(
                self.client.get("/api/cases/case-101/doc", headers=self._auth(self.admin_token)), 200
            ).json(),
            first_case,
        )

        annotator = self._create_annotator()
        annotator_token = self._login_annotator()
        self._assert_status(
            self.client.post(
                "/api/cases",
                headers=self._auth(annotator_token),
                json={"cases": [first_case]},
            ),
            403,
        )
        self._assert_status(
            self.client.get("/api/cases/case-101/doc", headers=self._auth(annotator_token)), 403
        )

        self._assign("case-101", annotator["id"])
        self.assertEqual(
            self._assert_status(
                self.client.get("/api/cases/case-101/doc", headers=self._auth(annotator_token)), 200
            ).json(),
            first_case,
        )

    def test_pdf_upload_retrieval_and_case_scoped_authorization(self):
        self._import_cases(
            {"id": "pdf-assigned", "title": "Assigned PDF case"},
            {"id": "pdf-private", "title": "Unassigned PDF case"},
        )
        annotator = self._create_annotator()
        annotator_token = self._login_annotator()
        self._assign("pdf-assigned", annotator["id"])

        # An administrator can store and retrieve the exact binary document.
        uploaded = self._upload_pdf("pdf-assigned")
        self._assert_status(uploaded, 200)
        self.assertEqual(uploaded.json(), {"success": True, "case_id": "pdf-assigned", "size": len(PDF_BYTES)})
        fetched = self._assert_status(
            self.client.get("/api/cases/pdf-assigned/pdf", headers=self._auth(self.admin_token)), 200
        )
        self.assertEqual(fetched.content, PDF_BYTES)
        self.assertEqual(fetched.headers["content-type"], "application/pdf")
        self.assertIn('filename="case_pdf-assigned.pdf"', fetched.headers["content-disposition"])

        # Access is authenticated and limited to an annotator's assignments.
        self._assert_status(self.client.get("/api/cases/pdf-assigned/pdf"), 401)
        self._assert_status(
            self.client.post(
                "/api/cases/pdf-assigned/pdf",
                headers=self._auth(annotator_token),
                files={"file": ("case.pdf", PDF_BYTES, "application/pdf")},
            ),
            403,
        )
        self._assert_status(
            self.client.get("/api/cases/pdf-assigned/pdf", headers=self._auth(annotator_token)), 200
        )

        self._assert_status(self._upload_pdf("pdf-private"), 200)
        self._assert_status(
            self.client.get("/api/cases/pdf-private/pdf", headers=self._auth(annotator_token)), 403
        )

    def test_pdf_upload_rejects_unknown_invalid_and_oversized_files(self):
        self._import_cases({"id": "pdf-validation", "title": "PDF validation case"})

        self._assert_status(self._upload_pdf("unknown-case"), 404)
        self._assert_status(
            self._upload_pdf("pdf-validation", data=b"this is not a PDF", filename="not-a-pdf.pdf"),
            400,
        )
        self._assert_status(
            self._upload_pdf("pdf-validation", data=PDF_BYTES, filename="not-a-pdf.txt"), 400
        )

        # MongoDB documents top out at 16 MiB, so the endpoint's advertised
        # cross-storage maximum is deliberately 15 MiB (inclusive).
        at_limit = PDF_BYTES + b"0" * (PDF_LIMIT_BYTES - len(PDF_BYTES))
        self._assert_status(self._upload_pdf("pdf-validation", data=at_limit), 200)
        over_limit = at_limit + b"0"
        self._assert_status(self._upload_pdf("pdf-validation", data=over_limit), 413)

    def test_assigned_annotator_can_draft_submit_and_admin_can_download_safe_exports(self):
        formula_title = "=SUM(1,1)"
        formula_outcome = "+looks-like-a-formula"
        self._import_cases(
            {"id": "submit-101", "title": formula_title},
            {"id": "not-assigned", "title": "Other case"},
        )
        annotator = self._create_annotator()
        annotator_token = self._login_annotator()
        self._assign("submit-101", annotator["id"])

        draft = {"units": [{"id": "unit-1", "status": "draft"}]}
        self._assert_status(
            self.client.put(
                "/api/cases/not-assigned/draft",
                headers=self._auth(annotator_token),
                json=draft,
            ),
            403,
        )
        self._assert_status(
            self.client.put(
                "/api/cases/submit-101/draft",
                headers=self._auth(annotator_token),
                json=draft,
            ),
            200,
        )
        saved_draft = self._assert_status(
            self.client.get("/api/cases/submit-101/draft", headers=self._auth(annotator_token)), 200
        ).json()
        self.assertEqual(saved_draft["units"], draft["units"])
        self._assert_status(
            self.client.delete("/api/cases/submit-101/draft", headers=self._auth(annotator_token)), 200
        )
        self._assert_status(
            self.client.get("/api/cases/submit-101/draft", headers=self._auth(annotator_token)), 404
        )

        submission = {
            "case_id": "submit-101",
            "title": formula_title,
            "submitted_at": "2026-09-03T00:00:00Z",
            "units": [
                {
                    "id": "unit-1",
                    "type": "request",
                    "status": "confirmed",
                    "outcome": formula_outcome,
                }
            ],
            "reasoning": [{"id": "reason-1", "text": "Annotated reasoning."}],
            "decisions": [{"id": "decision-1", "text": "Annotated decision."}],
        }
        self._assert_status(self.client.post("/api/submit", json=submission), 401)
        submitted = self._assert_status(
            self.client.post("/api/submit", headers=self._auth(annotator_token), json=submission), 200
        ).json()
        self.assertEqual(submitted["status"], "completed")
        self.assertEqual(submitted["annotator_id"], annotator["id"])

        my_submission = self._assert_status(
            self.client.get("/api/cases/submit-101/submission", headers=self._auth(annotator_token)), 200
        ).json()
        self.assertEqual(my_submission["units"], submission["units"])

        self._assert_status(
            self.client.get("/api/export/submissions", headers=self._auth(annotator_token)), 403
        )
        exported = self._assert_status(
            self.client.get("/api/export/submissions", headers=self._auth(self.admin_token)), 200
        ).json()
        self.assertEqual(exported["count"], 1)
        self.assertEqual(exported["submissions"][0]["case_id"], "submit-101")
        self.assertEqual(exported["submissions"][0]["reasoning"], submission["reasoning"])

        csv_response = self._assert_status(
            self.client.get("/api/export/submissions.csv", headers=self._auth(self.admin_token)), 200
        )
        self.assertTrue(csv_response.headers["content-type"].startswith("text/csv"))
        self.assertIn("attachment; filename=\"submissions.csv\"", csv_response.headers["content-disposition"])
        rows = list(csv.DictReader(io.StringIO(csv_response.content.decode("utf-8-sig"))))
        self.assertEqual(len(rows), 1)
        # CSV downloads can be opened in Excel; values that look like formulas
        # must be retained as text rather than evaluated by spreadsheet apps.
        self.assertEqual(rows[0]["title"], "'=SUM(1,1)")
        self.assertEqual(rows[0]["outcomes"], "'+looks-like-a-formula")

    def test_tokens_are_revoked_after_credential_reset_and_account_deletion(self):
        annotator = self._create_annotator(name="Revocation Annotator", passcode="old-code")
        old_annotator_token = self._login_annotator("Revocation Annotator", "old-code")
        self._assert_status(
            self.client.get("/api/annotator/cases", headers=self._auth(old_annotator_token)), 200
        )

        self._assert_status(
            self.client.put(
                f"/api/annotators/{annotator['id']}",
                headers=self._auth(self.admin_token),
                json={"passcode": "new-code"},
            ),
            200,
        )
        self._assert_status(
            self.client.get("/api/annotator/cases", headers=self._auth(old_annotator_token)), 401
        )
        new_annotator_token = self._login_annotator("Revocation Annotator", "new-code")
        self._assert_status(
            self.client.get("/api/annotator/cases", headers=self._auth(new_annotator_token)), 200
        )

        self._assert_status(
            self.client.delete(
                f"/api/annotators/{annotator['id']}", headers=self._auth(self.admin_token)
            ),
            200,
        )
        self._assert_status(
            self.client.get("/api/annotator/cases", headers=self._auth(new_annotator_token)), 401
        )

        old_admin_token = self.admin_token
        self._assert_status(
            self.client.post(
                "/api/auth/admin/change-password",
                headers=self._auth(old_admin_token),
                json={
                    "current_password": self.ADMIN_PASSWORD,
                    "new_password": "new-integration-admin-password",
                },
            ),
            200,
        )
        self._assert_status(
            self.client.get("/api/cases", headers=self._auth(old_admin_token)), 401
        )
        fresh_admin_token = self._login_admin("new-integration-admin-password")
        self._assert_status(
            self.client.get("/api/cases", headers=self._auth(fresh_admin_token)), 200
        )

    def test_file_storage_secret_is_stable_for_the_first_authenticated_follow_up(self):
        # This intentionally disables the test-only environment secret.  It
        # verifies the file-storage path that creates and reads a fresh secret.
        main.ENV_SECRET = ""
        first_secret = main._secret()
        self.assertEqual(first_secret, main._secret())
        self.assertFalse(first_secret.startswith('"'))

        fresh_token = self._login_admin()
        self._assert_status(
            self.client.get("/api/cases", headers=self._auth(fresh_token)), 200
        )


if __name__ == "__main__":
    unittest.main(verbosity=2)
