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

    def test_suggestion_toggles_preserve_sources_and_saved_work(self):
        source = {"id": "suggested", "title": "Suggested case", "parties": [{"id": "P1"}],
                  "units": [{"id": "C1", "text": "suggested claim"}],
                  "reasoning": [{"id": "RE1"}], "decisions": [{"id": "DE1"}],
                  "request_decision_links": [{"request_id": "R1", "decision_id": "DE1"}]}
        self._import_cases(source, dict(source, id="other"))
        annotator = self._create_annotator()
        token = self._login_annotator()
        self._assign("suggested", annotator["id"])
        self._assign("other", annotator["id"])
        admin = self._auth(self.admin_token)
        ann = self._auth(token)
        path = "/api/annotation-settings"
        self._assert_status(self.client.put(path, headers=ann, json={"show_suggestions": False}), 403)
        self._assert_status(self.client.put(path, headers=admin, json={"show_suggestions": "false"}), 400)
        self.assertTrue(self.client.get(path, headers=admin).json()["show_suggestions"])
        self.assertEqual(self.client.get("/api/cases/suggested/doc", headers=ann).json(), source)
        self._assert_status(self.client.put(path, headers=admin, json={"show_suggestions": False}), 200)
        blank = self.client.get("/api/cases/suggested/doc", headers=ann).json()
        for field in ("units", "reasoning", "decisions", "request_decision_links"):
            self.assertEqual(blank[field], [])
        self.assertEqual(blank["parties"], source["parties"])
        self.assertEqual(self.client.get("/api/cases/suggested/source", headers=admin).json(), source)
        self._assert_status(self.client.put("/api/cases/suggested/draft", headers=ann,
                                           json={"id": "suggested", "units": [{"id": "C2"}]}), 200)
        per_case = "/api/cases/suggested/annotation-settings"
        self._assert_status(self.client.put(per_case, headers=admin, json={"show_suggestions": True}), 200)
        self.assertEqual(self.client.get("/api/cases/suggested/doc", headers=ann).json(), source)
        self.assertEqual(self.client.get("/api/cases/other/doc", headers=ann).json()["units"], [])
        # Reimports retain the setting; global changes clear every override.
        self._import_cases(source)
        self.assertTrue(self.client.get("/api/cases", headers=admin).json()[1]["show_suggestions"])
        self._assert_status(self.client.put(path, headers=admin, json={"show_suggestions": False}), 200)
        self.assertEqual(self.client.get("/api/cases/suggested/doc", headers=ann).json()["units"], [])
        self.assertEqual(self.client.get("/api/cases/suggested/draft", headers=ann).json()["units"], [{"id": "C2"}])
        self._assert_status(self.client.put(path, headers=admin, json={"show_suggestions": True}), 200)
        self.assertEqual(self.client.get("/api/cases/other/doc", headers=ann).json()["units"], source["units"])

    def test_typed_raw_import_automatically_controls_suggestions_and_keeps_law_text(self):
        law = [{"provision_id": "LP1", "title": "Supplied provision", "content": "Full supplied law text."}]
        raw = {"case_id": "typed-self", "type": "self",
               "parties": [{"party_id": "P1", "name": "Party", "procedural_role": "PLAINTIFF"}],
               "claims": [{"claim_id": "C1", "span": {"text": "LLM claim"}, "asserted_by": ["P1"], "order": 1}],
               "requests": [{"request_id": "R1", "span": {"text": "LLM request"}, "order": 2}],
               "reasonings": [{"reasoning_id": "RE1", "span": {"text": "LLM reasoning"}}],
               "decisions": [{"decision_id": "DE1", "span": {"text": "LLM decision"}}],
               "request_outcomes": [{"request_id": "R1", "outcome": "ACCEPTED"}],
               "request_decision_links": [{"request_id": "R1", "decision_id": "DE1"}],
               "request_reasoning_links": [{"request_id": "R1", "reasoning_id": "RE1"}],
               "legal_provisions": law}
        self._import_cases(raw, dict(raw, case_id="typed-expert", type="expert"))
        annotator = self._create_annotator()
        token = self._login_annotator()
        ann, admin = self._auth(token), self._auth(self.admin_token)
        for cid in ("typed-self", "typed-expert"):
            self._assign(cid, annotator["id"])
        suggested = self.client.get("/api/cases/typed-self/doc", headers=ann).json()
        self.assertEqual(suggested["units"][0]["text"], "LLM claim")
        self.assertEqual(suggested["units"][1]["linkedDecisions"], ["DE1"])
        self.assertEqual(suggested["units"][1]["outcome"], "accepted")
        blank = self.client.get("/api/cases/typed-expert/doc", headers=ann).json()
        for field in ("units", "reasoning", "decisions", "claims", "requests", "reasonings",
                      "request_outcomes", "request_decision_links", "request_reasoning_links"):
            self.assertEqual(blank[field], [])
        self.assertNotIn("legal_provisions", blank)
        self.assertEqual(blank["parties"][0]["id"], "P1")
        human_law = [{"provision_id": "LP2", "title": "Human provision", "content": "Human correction.", "status": "confirmed"}]
        self._assert_status(self.client.put("/api/cases/typed-expert/draft", headers=ann,
                                           json={"units": [{"id": "C2", "text": "Human claim"}], "legal_provisions": human_law, "annotation_editor_version": 2}), 200)
        draft = self.client.get("/api/cases/typed-expert/draft", headers=ann).json()
        self.assertNotIn("legal_provisions", draft)
        self._assert_status(self.client.post("/api/submit", headers=ann,
                                            json={"case_id": "typed-expert", "type": "self", "legal_provisions": human_law, "annotation_editor_version": 2,
                                                  "units": draft["units"], "reasoning": [], "decisions": []}), 200)
        exported = self.client.get("/api/export/submissions?type=expert", headers=admin).json()
        self.assertEqual(exported["count"], 1)
        self.assertEqual(exported["submissions"][0]["type"], "expert")
        self.assertEqual(exported["submissions"][0]["legal_provisions"], law)
        self.assertEqual(exported["submissions"][0]["units"], draft["units"])
        self.assertEqual(self.client.get("/api/export/submissions?type=self", headers=admin).json()["count"], 0)
        csv_response = self.client.get("/api/export/submissions.csv?type=expert", headers=admin)
        row = next(csv.DictReader(io.StringIO(csv_response.content.decode("utf-8-sig"))))
        self.assertEqual(row["type"], "expert")
        self.assertEqual(row["num_legal_provisions"], "1")
        self._assert_status(self.client.get("/api/export/submissions?type=unknown", headers=admin), 400)

        # Case metadata is included even for older submissions missing that field.
        for p in main.storage.submissions_dir.glob("*.json"):
            stored = main._read_json_file(p, {})
            stored.pop("legal_provisions", None)
            stored.pop("type", None)
            main._write_json_file(p, stored)
        self.assertEqual(self.client.get("/api/export/submissions?type=expert", headers=admin).json()["submissions"][0]["legal_provisions"], law)
        self.assertNotIn("legal_provisions", main.storage.list_submissions()[0])

    def test_expert_is_blank_for_admin_and_annotator_even_after_global_toggle(self):
        source = {"id": "blind", "type": "expert", "units": [{"id": "C1", "type": "claim", "text": "Model claim"}],
                  "reasoning": [{"id": "RE1", "text": "Model reasoning"}], "decisions": [{"id": "DE1", "text": "Model decision"}],
                  "legal_provisions": [{"provision_id": "LP1", "title": "Model law", "content": "Model content"}]}
        self._import_cases(source)
        annotator = self._create_annotator()
        self._assign("blind", annotator["id"])
        admin, ann = self._auth(self.admin_token), self._auth(self._login_annotator())
        for enabled in (True, False, True):
            self._assert_status(self.client.put("/api/annotation-settings", headers=admin, json={"show_suggestions": enabled}), 200)
            for headers in (admin, ann):
                doc = self._assert_status(self.client.get("/api/cases/blind/doc", headers=headers), 200).json()
                for field in ("units", "reasoning", "decisions"):
                    self.assertEqual(doc[field], [])
                if headers == ann:
                    self.assertNotIn("legal_provisions", doc)
            self.assertFalse(self.client.get("/api/cases", headers=admin).json()[0]["show_suggestions"])
        self._assert_status(self.client.put("/api/cases/blind/annotation-settings", headers=admin, json={"show_suggestions": True}), 400)
        self.assertEqual(self.client.get("/api/cases/blind/source", headers=admin).json()["legal_provisions"], source["legal_provisions"])
        self._assert_status(self.client.get("/api/cases/blind/source", headers=ann), 403)

    def test_provision_metadata_is_hidden_from_annotators_and_preserved_in_storage_and_exports(self):
        source_law = [{"provision_id": "LP1", "title": "Model law", "content": "Model content"}]
        self._import_cases({"id": "law", "type": "self", "units": [], "legal_provisions": source_law})
        annotator = self._create_annotator()
        self._assign("law", annotator["id"])
        ann, admin = self._auth(self._login_annotator()), self._auth(self.admin_token)
        self.assertNotIn("legal_provisions", self.client.get("/api/cases/law/doc", headers=ann).json())
        human_law = [{"provision_id": "LP2", "title": "Expert title", "content": "Expert content", "status": "confirmed"}]
        for laws in (human_law, [], None):
            payload = {"id": "law", "units": [], "reasoning": [], "decisions": [], "annotation_editor_version": 2}
            if laws is not None:
                payload["legal_provisions"] = laws
            self._assert_status(self.client.put("/api/cases/law/draft", headers=ann, json=payload), 200)
            self.assertNotIn("legal_provisions", self.client.get("/api/cases/law/draft", headers=ann).json())
            self.assertEqual(main.storage.get_draft(annotator["id"], "law")["legal_provisions"], source_law)
            self._assert_status(self.client.post("/api/submit", headers=ann, json=dict(payload, case_id="law")), 200)
            self.assertNotIn("legal_provisions", self.client.get("/api/cases/law/submission", headers=ann).json())
            self.assertEqual(self.client.get("/api/cases/law/submissions", headers=admin).json()["submissions"][0]["legal_provisions"], source_law)
            self.assertEqual(self.client.get("/api/export/submissions", headers=admin).json()["submissions"][0]["legal_provisions"], source_law)
        self.assertEqual(main.storage.get_case_doc("law")["legal_provisions"], source_law)
        self._assert_status(self.client.put("/api/cases/law/draft", headers=ann, json={"legal_provisions": [], "annotation_editor_version": 1}), 409)
        self._assert_status(self.client.post("/api/submit", headers=ann, json={"case_id": "law", "legal_provisions": "bad", "annotation_editor_version": 2}), 200)
        self.assertEqual(main.storage.list_submissions()[0]["legal_provisions"], source_law)

    def test_legacy_expert_source_copies_are_hidden_but_saved_human_edits_are_kept(self):
        source = {"id": "legacy", "type": "expert", "units": [{"id": "C1", "type": "claim", "text": "Model claim"}],
                  "legal_provisions": [{"provision_id": "LP1", "title": "Model law", "content": "Model content"}]}
        self._import_cases(source)
        annotator = self._create_annotator()
        self._assign("legacy", annotator["id"])
        ann, admin = self._auth(self._login_annotator()), self._auth(self.admin_token)
        old = dict(source, case_id="legacy", units=source["units"] + [{"id": "C2", "type": "claim", "text": "Human edit"}])
        main.storage.save_draft(annotator["id"], "legacy", old)
        summary = {"annotator_id": annotator["id"], "annotator_name": "Annotator", "submitted_at": "2026-10-24", "file": "case_legacy_test.json"}
        main.storage.record_submission("legacy", summary, old)
        for path, headers in (("/api/cases/legacy/draft", ann), ("/api/cases/legacy/submission", ann)):
            restored = self.client.get(path, headers=headers).json()
            self.assertEqual([x["text"] for x in restored["units"]], ["Human edit"])
            self.assertNotIn("legal_provisions", restored)
            self.assertTrue(restored["legacy_suggestions_filtered"])
        exported = self.client.get("/api/export/submissions?type=expert", headers=admin).json()["submissions"][0]
        self.assertEqual(exported["legal_provisions"], source["legal_provisions"])
        self.assertEqual(len(main.storage.list_submissions()[0]["units"]), 2)
        self.assertEqual(main.storage.get_draft(annotator["id"], "legacy")["legal_provisions"], source["legal_provisions"])
        # New blind annotations can independently match model text exactly.
        fresh = dict(source, annotation_editor_version=2, case_id="legacy", legacy_suggestions_filtered=True)
        self._assert_status(self.client.put("/api/cases/legacy/draft", headers=ann, json=fresh), 200)
        self.assertNotIn("legal_provisions", self.client.get("/api/cases/legacy/draft", headers=ann).json())
        self.assertNotIn("legacy_suggestions_filtered", self.client.get("/api/cases/legacy/draft", headers=ann).json())

    def test_invalid_typed_import_is_rejected_before_writing(self):
        response = self.client.post("/api/cases", headers=self._auth(self.admin_token), json={"cases": [
            {"case_id": "valid", "type": "self", "claims": []},
            {"case_id": "invalid", "type": "unknown"},
        ]})
        self._assert_status(response, 400)
        self.assertIsNone(main.storage.get_case_doc("valid"))

    def test_corpus_cli_backs_up_existing_sources_and_preserves_human_work(self):
        import import_corpus
        old = {"id": "migrated", "type": "self", "units": [{"id": "C1", "text": "Old suggestion"}],
               "legal_provisions": []}
        self._import_cases(old)
        main.storage.save_draft("A1", "migrated", {"units": [{"id": "C2", "text": "Human work"}]})
        new = dict(old, type="expert", legal_provisions=[{"provision_id": "LP1", "content": "Supplied provision"}])
        source_file = Path(self._tempdir.name) / "corpus.json"
        main._write_json_file(source_file, [new])
        backup_dir = Path(self._tempdir.name) / "backups"
        args = ["import_corpus.py", "--file", str(source_file), "--url", "http://testserver", "--apply", "--backup-dir", str(backup_dir)]
        with patch.object(sys, "argv", args), patch.dict(os.environ, {"ADMIN_PASSWORD": "test-only"}), \
             patch.object(import_corpus, "login", return_value=self.admin_token), \
             patch.object(import_corpus.requests, "Session", return_value=self.client), \
             patch("builtins.print"):
            import_corpus.main()
        backups = list(backup_dir.glob("*.json"))
        self.assertEqual(len(backups), 1)
        backup = main._read_json_file(backups[0], {})
        self.assertEqual(backup["cases"][0]["type"], "self")
        self.assertEqual(backup["cases"][0]["legal_provisions"], [])
        self.assertEqual(main.storage.get_case_doc("migrated")["legal_provisions"], new["legal_provisions"])
        self.assertEqual(main.storage.get_draft("A1", "migrated")["units"][0]["text"], "Human work")
        self.assertFalse(main._annotation_settings()["case_overrides"]["migrated"])

    def test_auto_assignment_limits_writes_to_filtered_expert_cases(self):
        self.assertTrue(self.client.get("/").json()["scoped_auto_assign"])
        self._import_cases(
            {"id": "expert-1", "type": "expert", "units": []},
            {"id": "expert-2", "type": "expert", "units": []},
            {"id": "expert-done", "type": "expert", "units": []},
            {"id": "self-1", "type": "self", "units": []},
        )
        first = self._create_annotator("First")
        second = self._create_annotator("Second")
        main._set_case_status("expert-done", "completed", completed_by="previous")
        main.storage.save_assignments({"self-1": [first["id"]], "expert-2": [second["id"]]})
        admin = self._auth(self.admin_token)
        scope = {"type": "expert", "case_ids": ["expert-1", "expert-done", "self-1"]}
        response = self._assert_status(self.client.post("/api/cases/auto-assign", headers=admin, json=scope), 200).json()
        self.assertEqual(response["assigned"], 1)
        self.assertEqual(response["total_open"], 1)
        assignments = main.storage.read_assignments()
        self.assertEqual(assignments["self-1"], [first["id"]])
        self.assertEqual(assignments["expert-2"], [second["id"]])
        self.assertNotIn("expert-done", assignments)
        self._assert_status(self.client.post("/api/cases/auto-assign", headers=admin, json=scope), 200)
        self.assertEqual(set(main.storage.read_assignments()["expert-1"]), {first["id"], second["id"]})
        self.assertEqual(self.client.post("/api/cases/auto-assign", headers=admin, json=scope).json()["assigned"], 0)
        before = main.storage.read_assignments()
        self.assertEqual(self.client.post("/api/cases/auto-assign", headers=admin, json={"case_ids": []}).json()["assigned"], 0)
        self.assertEqual(main.storage.read_assignments(), before)
        for invalid in ({"type": "unknown"}, {"case_ids": "expert-1"}, {"case_ids": [123]}, {"case_ids": ["missing"]}):
            self._assert_status(self.client.post("/api/cases/auto-assign", headers=admin, json=invalid), 400)
            self.assertEqual(main.storage.read_assignments(), before)
        token = self._login_annotator("First")
        self._assert_status(self.client.post("/api/cases/auto-assign", headers=self._auth(token), json=scope), 403)

    def test_selected_recipients_only_get_unassigned_filtered_cases(self):
        self.assertTrue(self.client.get("/").json()["selective_auto_assign"])
        self._import_cases(
            *[{"id": f"expert-{i}", "type": "expert", "units": []} for i in range(6)],
            {"id": "manual", "type": "expert", "units": []},
            {"id": "done", "type": "expert", "units": []},
            {"id": "self", "type": "self", "units": []},
            {"id": "outside", "type": "expert", "units": []},
        )
        special = self._create_annotator("Special")
        first = self._create_annotator("First")
        second = self._create_annotator("Second")
        # Manual assignments must survive even when their recipient is not selected.
        main.storage.save_assignments({"manual": [special["id"]], "self": [first["id"]]})
        main._set_case_status("done", "completed", completed_by=special["id"])
        admin = self._auth(self.admin_token)
        scope = {"type": "expert", "case_ids": [f"expert-{i}" for i in range(6)] + ["manual", "done", "self"],
                 "annotator_ids": [first["id"], second["id"]], "unassigned_only": True}
        result = self._assert_status(self.client.post("/api/cases/auto-assign", headers=admin, json=scope), 200).json()
        self.assertEqual(result["assigned"], 6)
        assignments = main.storage.read_assignments()
        self.assertEqual(assignments["manual"], [special["id"]])
        self.assertEqual(assignments["self"], [first["id"]])
        self.assertNotIn("done", assignments)
        self.assertNotIn("outside", assignments)
        for i in range(6):
            self.assertEqual(len(assignments[f"expert-{i}"]), 1)
            self.assertIn(assignments[f"expert-{i}"][0], scope["annotator_ids"])
        workloads = [sum(aid in ids for ids in assignments.values()) for aid in scope["annotator_ids"]]
        self.assertLessEqual(abs(workloads[0] - workloads[1]), 1)
        # A stale client still listing just-assigned cases cannot assign them again.
        self.assertEqual(self.client.post("/api/cases/auto-assign", headers=admin, json=scope).json()["assigned"], 0)
        self.assertEqual(main.storage.read_assignments(), assignments)
        for invalid in ({"annotator_ids": []}, {"annotator_ids": None}, {"annotator_ids": "one"},
                        {"annotator_ids": [123]}, {"annotator_ids": ["missing"]}, {"unassigned_only": "true"}):
            self._assert_status(self.client.post("/api/cases/auto-assign", headers=admin, json={**scope, **invalid}), 400)
            self.assertEqual(main.storage.read_assignments(), assignments)
        # Explicit incremental API requests also retain people outside the recipient pool.
        self._assert_status(self.client.post("/api/cases/auto-assign", headers=admin,
            json={"case_ids": ["manual"], "annotator_ids": [first["id"]]}), 200)
        self.assertEqual(main.storage.read_assignments()["manual"], [special["id"], first["id"]])

    def test_duplicate_registry_rows_are_shown_and_assigned_once(self):
        self._import_cases({"id": "10025", "type": "self", "units": []})
        row = main.storage.read_cases()[0]
        # Simulate the old broken registry without passing through the new writer.
        main._write_json_file(main.storage.cases_file, [dict(row) for _ in range(4)])
        first = self._create_annotator("First")
        second = self._create_annotator("Second")
        admin = self._auth(self.admin_token)
        self.assertEqual(len(self.client.get("/api/cases", headers=admin).json()), 1)
        scope = {"case_ids": ["10025"] * 4, "annotator_ids": [first["id"], second["id"]], "unassigned_only": True}
        result = self._assert_status(self.client.post("/api/cases/auto-assign", headers=admin, json=scope), 200).json()
        self.assertEqual(result["assigned"], 1)
        self.assertEqual(result["total_open"], 1)
        self.assertEqual(len(main.storage.read_assignments()["10025"]), 1)
        self.assertEqual(self.client.post("/api/cases/auto-assign", headers=admin, json=scope).json()["assigned"], 0)
        # A re-import changes metadata, not completed status or another case.
        main._set_case_status("10025", "completed", first["id"])
        self._import_cases({"id": "10025", "title": "Updated title", "units": []},
                           {"id": "other", "units": []})
        self.assertEqual(main._registry_by_id()["10025"]["status"], "completed")
        self.assertEqual(main._registry_by_id()["10025"]["completed_by"], first["id"])
        self._assert_status(self.client.post("/api/cases/10025/reopen", headers=admin), 200)
        self.assertNotIn("completed_by", main._registry_by_id()["10025"])
        self.assertEqual(len(main.storage.read_cases()), 2)

    def test_auto_assignment_group_only_and_legacy_unscoped_requests(self):
        self._import_cases({"id": "expert", "type": "expert", "units": []},
                           {"id": "self", "type": "self", "units": []})
        annotator = self._create_annotator()
        admin = self._auth(self.admin_token)
        self._assert_status(self.client.post("/api/cases/auto-assign", headers=admin, json={"type": "expert"}), 200)
        self.assertEqual(main.storage.read_assignments(), {"expert": [annotator["id"]]})
        self._assert_status(self.client.post("/api/cases/auto-assign", headers=admin), 200)
        self.assertEqual(main.storage.read_assignments(), {"expert": [annotator["id"]], "self": [annotator["id"]]})

    def test_drafts_survive_a_new_login_and_are_visible_only_to_their_owner(self):
        self._import_cases({"id": "resume", "type": "expert", "units": []})
        owner = self._create_annotator("Owner")
        other = self._create_annotator("Other")
        for annotator in (owner, other):
            self._assign("resume", annotator["id"])
        auth = self._auth(self._login_annotator("Owner"))
        payload = {"id": "resume", "units": [{"id": "C1", "text": "Saved human work"}],
                   "reasoning": [], "decisions": [], "annotation_editor_version": 2,
                   "_editor_state": {"tab": "requests", "addingType": "request", "form": {"text": "Unfinished request"}}}
        saved = self._assert_status(self.client.put("/api/cases/resume/draft", headers=auth, json=payload), 200).json()
        self.assertTrue(saved["saved_at"].endswith("+00:00"))
        # A fresh client/session uses the persistent backend draft, not React state.
        with TestClient(main.app) as fresh:
            logged_in = fresh.post("/api/auth/annotator", json={"name": "Owner", "passcode": "pass-1234"}).json()
            headers = self._auth(logged_in["token"])
            restored = self._assert_status(fresh.get("/api/cases/resume/draft", headers=headers), 200).json()
            self.assertEqual(restored["units"], payload["units"])
            self.assertEqual(restored["_editor_state"], payload["_editor_state"])
            self.assertNotIn("legal_provisions", restored)
            case = fresh.get("/api/annotator/cases", headers=headers).json()["cases"][0]
            self.assertTrue(case["has_draft"])
            self.assertEqual(case["draft_saved_at"], saved["saved_at"])
        other_auth = self._auth(self._login_annotator("Other"))
        self._assert_status(self.client.get("/api/cases/resume/draft", headers=other_auth), 404)
        self.assertFalse(self.client.get("/api/annotator/cases", headers=other_auth).json()["cases"][0]["has_draft"])
        self._assert_status(self.client.post("/api/submit", headers=auth,
                                            json={"case_id": "resume", "units": payload["units"], "annotation_editor_version": 2}), 200)
        self._assert_status(self.client.get("/api/cases/resume/draft", headers=auth), 404)
        self.assertFalse(self.client.get("/api/annotator/cases", headers=auth).json()["cases"][0]["has_draft"])

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
