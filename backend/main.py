from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware
from pathlib import Path
from datetime import datetime
import json


app = FastAPI()


# Cho phép React frontend gọi backend
app.add_middleware(
    CORSMiddleware,
    allow_origins=["http://localhost:5173"],
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)


SUBMISSIONS_DIR = Path("submissions")
SUBMISSIONS_DIR.mkdir(exist_ok=True)


@app.get("/")
def root():
    return {
        "message": "Legal annotation backend is running"
    }


@app.post("/api/submit")
async def submit_case(data: dict):

    case_id = str(data.get("case_id", "unknown"))

    timestamp = datetime.now().strftime(
        "%Y%m%d_%H%M%S"
    )

    filename = (
        SUBMISSIONS_DIR
        / f"case_{case_id}_{timestamp}.json"
    )

    data["received_at"] = datetime.now().isoformat()

    filename.write_text(
        json.dumps(
            data,
            ensure_ascii=False,
            indent=2
        ),
        encoding="utf-8"
    )

    return {
        "success": True,
        "case_id": case_id,
        "file": filename.name
    }