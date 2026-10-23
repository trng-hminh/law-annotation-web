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
backend/.venv/bin/python -m unittest backend/test_api_integration.py
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

## Import grouped cases and provision details

The importer recognizes `type: "self"` (also `self_annotate`) and `type: "expert"`.
Importing sets gợi ý on for self cases and off for expert cases. Reimporting
reapplies these dataset defaults. Expert cases always start blank for both
admins and annotators; neither global nor per-case switches can enable model
suggestions for Expert. The switches still control Self and untyped cases.
Changes affect newly opened cases.

`legal_provisions` is retained per case, including `provision_id`, `title`, and
`content`. **Điều luật is an annotation section** with add, edit, delete, and
confirm controls. Self cases can start with imported suggestions; Expert cases
start with an empty list. Drafts, submissions, and exports store the human's
current list, including intentional deletions. Model text never replaces those
edits. The app does not generate or verify law content.

The imported source remains available only through the admin `/source` endpoint
for backups and import verification. Normal `/doc` editor responses hide all
suggestion fields (including laws) for Expert cases.

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

The admin **Tất cả nhóm / Self / Expert** selector also filters the case list.
**Phân công** applies only to open cases matching the selected group, search,
and status filters, across all matching pages. Each click adds one additional
annotator per eligible case. Cases outside the filters retain their existing
assignments. Deploy both frontend and backend for this behavior; the frontend
blocks assignment if the backend does not yet support filtered assignment.

In the admin dashboard, select **Tất cả nhóm**, **Self**, or **Expert** beside
the export buttons, then choose **Tải dữ liệu (JSON)** or **Tải summary (CSV)**.
JSON contains the full human submissions, case type, and full provision text.
CSV is a summary with the type and number of provisions. Exports contain
submitted work only; unfinished drafts are not included.

Admin API equivalents (Bearer token required):

- `/api/export/submissions?type=self`
- `/api/export/submissions?type=expert`
- `/api/export/submissions.csv?type=expert`

Missing law annotations are exported as empty, never backfilled from the model.
For Expert work saved with the older editor, exact source-copy items are hidden
on restore/export, while new or edited items are retained. Original stored
records are not changed by this read-time cleanup; a notice appears in the
editor when legacy suggestions were hidden. Independently entered annotations
saved with the new editor are preserved even when their wording matches the
model. Deploy both frontend and backend, then refresh existing browser tabs.
