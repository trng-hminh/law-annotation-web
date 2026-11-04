# Legal Annotation

Vietnamese civil-case annotation application with a React/Vite frontend,
FastAPI backend, and MongoDB production storage.

## Live services

- Frontend: <https://trng-hminh.github.io/law-annotation-web/>
- Backend health check: <https://legal-annotation-backend.onrender.com/api/health>

The repository was renamed with hyphens. Old bookmarks using
`law_annotation_web` return GitHub Pages 404s and should be updated.

## Architecture

| Component | Location | Production service |
| --- | --- | --- |
| React frontend | `legal-annotation/` | GitHub Pages |
| FastAPI API | `backend/main.py` | Render |
| Persistent data | MongoDB collections | MongoDB |

The backend uses local JSON files under `backend/data/` only when
`MONGODB_URI` is absent. Those files and submitted data are intentionally
ignored by Git.

## Production configuration

Configure the following Render environment variables. Do not commit their
values.

| Variable | Required | Purpose |
| --- | --- | --- |
| `MONGODB_URI` | Yes | MongoDB connection URI |
| `MONGODB_DB` | Recommended | Database name; defaults to `legal_annotation` |
| `ADMIN_PASSWORD` | Required when bootstrapping an empty production database | Initial admin password |
| `ADMIN_USERNAME` | Optional | Initial admin username; defaults to `admin` |
| `SECRET_KEY` | Recommended | Stable signing secret for login sessions |
| `ALLOWED_ORIGINS` | Yes | Comma-separated browser origins, including `https://trng-hminh.github.io` |

The Pages workflow builds with the GitHub repository variable `VITE_API_BASE`.
Set it to `https://legal-annotation-backend.onrender.com` (without a trailing
slash). The deployed frontend is currently configured with this value.

## Local development

```sh
python3 -m venv backend/.venv
backend/.venv/bin/pip install -r backend/requirements.txt
ADMIN_PASSWORD='choose-a-local-password' SECRET_KEY='local-dev-secret' \
  backend/.venv/bin/uvicorn main:app --app-dir backend --reload
```

In a separate shell:

```sh
cd legal-annotation
npm ci
VITE_API_BASE=http://localhost:8000 npm run dev
```

For the production frontend build, run `npm run lint` and
`VITE_API_BASE=https://legal-annotation-backend.onrender.com npm run build`
from `legal-annotation/`.

## Case and PDF operations

- Admins import a JSON array (or an object containing `cases`) through the
  **Import JSON** button. Imports upsert by case ID; they do not delete cases
  absent from the new file. Test imports only with known, non-disposable case
  IDs until an explicit delete/replace workflow is added.
- Admins may upload a PDF only for an existing case. PDFs must contain a PDF
  header and are limited to **15 MiB** so they fit safely in MongoDB.
- Annotators can retrieve a PDF, case document, or draft only for cases assigned
  to them.
- Admins can download complete labeled submissions as JSON or a spreadsheet-safe
  CSV summary. CSV cells that could be interpreted as formulas are neutralized.

For batch uploads, use the supplied tool without embedding a password in source:

```sh
ADMIN_PASSWORD='your-admin-password' \
  backend/.venv/bin/python backend/upload_pdfs.py \
  --dir /absolute/path/to/pdfs \
  --url https://legal-annotation-backend.onrender.com \
  --user admin
```

Each filename must be `<case_id>.pdf`. Use `--dry` first to confirm the mapping.

## Verification and routine maintenance

Run the isolated integration suite; it uses temporary local storage and does
not contact Render or MongoDB:

```sh
backend/.venv/bin/python -m unittest backend/test_api_integration.py backend/test_case_registry.py backend/test_annotation_graph.py
```

Before each release:

1. Run the backend integration suite, frontend lint, and frontend production build.
2. Verify `/api/health` reports `{"status":"ok","storage":"mongodb"}`.
3. In the live app, sign in with an authorized admin account and use an existing
   test case to check JSON import, small-PDF upload/retrieval, and JSON/CSV
   export. These actions persist, so do not create throwaway production cases
   unless you are prepared to retain them.
4. Keep MongoDB backups enabled and periodically download an admin JSON export
   as an additional, portable record of submitted annotations.

Changing an admin password or annotator passcode now invalidates that account's
existing sessions. Users will need to sign in again after a deployment that
contains this change.

## Request–Opinion–Premise editor (schema v3)

The editor now follows **Requests | Opinions | Premises | Reasoning | Decisions | Links**.
Requests are the main workspace. Each Request can reference shared Premises and
Opinions; each Opinion can reference shared Premises. Editing a shared item
updates every place that references its ID. Quotes are stored in full, including
line breaks; shortened summaries are display-only.

- **Requests:** create/edit the request and `asserted_by`, lifecycle status
  (`ACTIVE`, `WITHDRAWN`, `PARTIALLY_WITHDRAWN`) and `modification_spans`. Use
  **Chọn / thêm luận cứ** and **Chọn / thêm ý kiến** within the card.
- **Pickers:** tick existing items or create an item with **Lưu & gắn** without
  switching tabs. Premises default to matching at least one of the parent's
  presenters. Change the presenter filter or search as needed. Already-linked
  items remain visible so they can be unticked. Unticking does not delete them.
- **Opinions:** independently edit/confirm opinions and attach premises.
  **Đang gắn với** is read-only; Request–Opinion links are changed only in Requests.
- **Premises:** a shared inventory with read-only **Đang hỗ trợ** relationships.
  Unlinked premises are retained in drafts, submissions and the normal JSON export.
- **Links:** retains both Request–Reasoning and Request–Decision links and Outcome,
  including `DISCONTINUED`. Annotation confirmation is stored separately from
  the Request's procedural lifecycle.
- Self outcome suggestions recognize `ACCEPTED`, `PARTIALLY_ACCEPTED`, `REJECTED`
  and `DISCONTINUED` (plus legacy `PARTIAL`). Old imported source mirrors that
  lost a label are repaired on read when `request_outcomes` still contains it;
  this does not rewrite the database. Existing human drafts are not overwritten.
  For a blank draft outcome, Links offers **Dùng outcome gợi ý** only when Self
  suggestions are enabled and the Request ID, quote and presenters still match
  the source. Expert cases never receive this option.
- Party corrections, case notes, draft autosave, **Tạm dừng**, expert blank mode,
  and admin editing remain available. Inline picker forms also survive refresh
  and pause/reopen. Finish or cancel the active form/picker before changing tabs.

### Data and backwards compatibility

New drafts/submissions use `annotation_schema_version: 3` and canonical
`requests`, `opinions`, `premises`, `reasonings`, `decisions`,
`request_reasoning_links`, `request_decision_links`, `request_outcomes` arrays.
`premise_ids` and `opinion_ids` contain IDs, not embedded copies. Reverse links
are derived, not separately stored. Span metadata, existing vote metadata, notes,
parties and source `legal_provisions` are preserved. `annotation_status` records
confirmation; Request `status` is the lifecycle. Editor-only `units` is a transient
adapter, not a second authoritative copy in new saved/exported records.

Old Claims are **not automatically relabelled**. The editor displays a review
queue: choose Opinion or Premise for each old Claim, and keep each old Request
as a Request or convert a response to Opinion. Unclassified Claims remain in
`legacy_units` while drafting and block completion. Converted items retain
`legacy_source` for audit. When a Request becomes an Opinion, its court links and
Outcome are no longer active; they remain in the source snapshot, shown read-only
for comparison. Attach the Opinion to the appropriate Request and review Links.

Existing source records and other users' work are not bulk rewritten. Historical
submissions keep their old format until their owner reviews and resubmits them;
an export during rollout can therefore contain both legacy and v3 submissions.
Do not re-import submissions as source data to perform a migration. Back up the
database before rollout, and have annotators review their existing work in the
new editor. Normal downloads still export **submitted work only**, not drafts.

### Deployment order

1. Deploy the backend changes to Render first; its root `/` response must include
   `"annotation_schema_version": 3`.
2. Deploy the frontend through the existing GitHub Pages workflow, then reload
   open browser tabs. The new frontend refuses to open cases against an older
   backend rather than saving a partial graph.
3. Old clients cannot overwrite v3 source/work with legacy payloads. No MongoDB
   collection reset or destructive migration is needed. Test using an authorized
   test case before asking annotators to resume production work.

### Separate publication copy, only after all annotation is finished

Do **not** prune unused premises during annotation. Once the entire dataset is
finished and reviewed, create a separate output file:

```sh
backend/.venv/bin/python backend/prepare_publication.py \
  --input submissions.json --output publication.json \
  --confirm-annotation-complete
```

This offline command validates v3 records, removes only premises not referenced
by any Request or Opinion, and refuses to overwrite an existing output file.
It never modifies the input, database, or normal export. Court links are retained;
constructing prediction inputs with a deliberate target-leakage policy is a
separate downstream task.

## Import grouped cases and provision details

The importer recognizes `type: "self"` (also `self_annotate`) and `type: "expert"`.
Importing sets gợi ý on for self cases and off for expert cases. Reimporting
reapplies these dataset defaults. Expert cases always start blank for both
admins and annotators; neither global nor per-case switches can enable model
suggestions for Expert. The switches still control Self and untyped cases.
Changes affect newly opened cases.

`legal_provisions` is retained per case, including `provision_id`, `title`, and
`content`. **Điều luật is case metadata, not an annotation task.** It is hidden
from annotators in both groups and excluded from annotation progress. The
backend retains the source provision details when saving drafts/submissions,
even though the annotator never receives or submits them. Admin exports and
the admin submission viewer retain this metadata. Client payloads cannot alter
or erase it. The app does not generate or verify law content.

The imported source remains available only through the admin `/source` endpoint
for backups and import verification. Annotator `/doc`, `/draft`, and
`/submission` responses omit `legal_provisions`. Expert cases still start with
all actual annotation fields blank, regardless of suggestion toggles.

Deploy the updated frontend and backend before importing. The admin **Import
JSON** control accepts the raw grouped JSON and imports in batches of ten. For
a backup before updating existing source cases, use the CLI instead:

```sh
# Offline validation only; no password or database connection needed.
backend/.venv/bin/python backend/import_corpus.py --file cases_to_annotate_326.json

# Prompts for your actual admin password, backs up source cases/settings,
# imports in batches, then verifies groups, suggestions, and provision text.
backend/.venv/bin/python backend/import_corpus.py \
  --file cases_to_annotate_326.json \
  --url https://legal-annotation-backend.onrender.com --user admin --apply
```

The backup is written under ignored `backups/`; retain it privately. The import
updates source documents and preserves assignments, progress, drafts, and
submissions. It does not delete existing cases outside the imported corpus.

## Upload the grouped PDFs

After importing the cases, validate both PDF folders:

```sh
backend/.venv/bin/python backend/upload_pdfs.py \
  --dir pdf_cases --recursive --manifest cases_to_annotate_326.json --dry
```

Then run the upload (prompts for your actual admin password):

```sh
backend/.venv/bin/python backend/upload_pdfs.py \
  --dir pdf_cases --recursive --manifest cases_to_annotate_326.json \
  --url https://legal-annotation-backend.onrender.com --user admin
```

The tool maps both `ban_3184.pdf` and `3184.pdf` to case `3184`, checks group
folders against the JSON, and rejects duplicate IDs and oversized files. To
upload one group at a time, use `--dir pdf_cases/self_annotate` or
`--dir pdf_cases/expert`. PDFs must be uploaded via the API, not to GitHub Pages.
The corpus, PDFs, and backups are excluded from Git.

## Download completed annotations

### Repair duplicate case registry entries

Deploy the updated backend first. Its case list and auto-assignment operate on
unique case IDs, even before legacy MongoDB rows are repaired. Imports and case
status changes now update individual records; they no longer delete and reinsert
the entire registry. `/` reports `unique_case_registry: true` on this version.

Inspect the actual MongoDB registry from the repository root:

```bash
backend/.venv/bin/python backend/repair_case_registry.py
```

The script uses `MONGODB_URI` if configured; otherwise it prompts for the URI
without displaying it. Use the same connection and database as Render. If the
URI includes a database name, that name takes precedence, matching the backend.
Inspection is read-only and reports raw rows versus unique case IDs.

Before applying, pause the Render backend service (and any import scripts or
other database writers). Keep writes paused until verification finishes:

```bash
backend/.venv/bin/python backend/repair_case_registry.py --apply --maintenance-confirmed
```

This writes a private Extended JSON backup under `backups/`, consolidates only
identical registry copies into records keyed by case ID, then creates a unique
`case_id` index and verifies the result. It does not touch PDFs, source documents,
drafts, submissions, or assignments. If duplicate metadata conflicts, it stops
without choosing which copy to discard; inspect the listed IDs before retrying.
Retain the backup: it contains all original registry fields and MongoDB IDs for
recovery. Do not delete or re-import the entire corpus to repair duplicates.

Resume the updated backend, then refresh the dashboard. If earlier auto-assignment
added unwanted recipients, review and remove those recipients individually;
the repair deliberately preserves assignments because it cannot distinguish
intentional manual assignments from earlier unintended ones.

### Export submissions

The admin **Tất cả nhóm / Self / Expert** selector also filters the case list.
Use **Chỉ chưa phân công** to toggle the unassigned-only view, combined with the
group, search, and status filters. **Phân công** opens a recipient picker: select
the annotators who should receive the remaining cases, then click the assignment
button. It assigns only open, unassigned cases matching the filters across all
pages, balancing existing open-case workloads among the selected people. Manual
and other existing assignments are preserved, even if you click again. Deploy
both frontend and backend; the frontend blocks this action on older backends.

In the admin dashboard, select **Tất cả nhóm**, **Self**, or **Expert** beside
the export buttons, then choose **Tải dữ liệu (JSON)** or **Tải summary (CSV)**.
JSON contains the full human submissions, case type, and full provision text.
CSV is a summary with the type and number of provisions. Exports contain
submitted work only; unfinished drafts are not included.

Admin API equivalents (Bearer token required):

- `/api/export/submissions?type=self`
- `/api/export/submissions?type=expert`
- `/api/export/submissions.csv?type=expert`

Exports include provision details from the source case as metadata, including
for older submissions that lack the field.
For Expert work saved with the older editor, exact source-copy items are hidden
on restore/export, while new or edited items are retained. Original stored
records are not changed by this read-time cleanup; a notice appears in the
editor when legacy suggestions were hidden. Independently entered annotations
saved with the new editor are preserved even when their wording matches the
model. Deploy both frontend and backend, then refresh existing browser tabs.

## Draft recovery

Admin and annotator changes and unfinished add/edit form inputs are backed up immediately
in this browser, separately for each account and case. The app synchronizes
pending work to the backend after a short typing pause and retries failed saves
when the connection returns. Returning to the case list or logging out waits
for pending saves first. Refreshing or signing in again resumes the last open
case, restoring its server draft and any newer pending browser backup.

The case header distinguishes **saved in this browser**, **saving**, and
**saved on the server**. Only a server-saved draft is available on another
browser/device. Offline pending work requires the same browser until it syncs.
Cases with drafts show **Có nháp / Tiếp tục nháp** on the annotator dashboard.
Admins see **Có nháp của tôi** for their own drafts; each admin's draft and
submission recovery is separate from other users. Deploy the backend with
`admin_drafts: true` before using the updated admin editor.

**Tạm dừng**, next to **Hoàn tất case**, saves the complete draft (including
unfinished form inputs) to the server and returns to the dashboard. It does not
submit or complete the case. If synchronization fails, the editor stays open
with a warning so the user can retry. **Hoàn tất case** submits the annotations.
Use **Lưu** to finish a form before submitting; unfinished input remains a draft
and is not included in a completed submission.

Claims expose **Sửa asserted_by**; requests expose **Sửa requested_by /
modification spans**. Select one or more parties in the editor. A request can
contain multiple editable `modification_spans` (text passages describing changes
to the request); leave the list empty when none apply. These fields survive
draft recovery and are included in submission JSON.

**Ghi chú case** holds each user's own notes for the case (up to 20,000 characters).
Notes autosave with the draft, appear in the admin submission viewer, and are
included as `notes` in both submission JSON and CSV summary exports. They are
not a shared note that another annotator can overwrite.

The login page includes the external Google Docs annotation procedure beside
the built-in workflow guide.

Frontend draft recovery tests: `cd legal-annotation && npm test`.

## Correct parties and missing people

In the case header, choose **Sửa đương sự / người liên quan**. In the left panel,
edit names and procedural roles or choose **Thêm người / đương sự**. Supported
roles include plaintiff, defendant, related party, witness, representative, and
other/unknown. Party IDs stay fixed when roles change; all existing Claims and
Requests retain their links, and their tags, colours, and actor choices update
immediately. Colours follow the selected role, not the ID prefix.

Changes autosave with the current admin/annotator's draft, survive **Tạm dừng**
and login recovery, and are included in the submission's `parties` and JSON
exports. They do not overwrite the imported source or another user's work.
The admin submission viewer displays the complete corrected roster, including
people not yet referenced by an annotation.

Remove unused people with **Xoá người**. For a person referenced by a saved or
unfinished annotation, first change its `asserted_by` / `requested_by` choices
(or cancel the unfinished form); deletion is blocked until those references
are removed. Complete the names of newly added people before submitting.
