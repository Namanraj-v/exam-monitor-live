import re
import csv
import io
import json
import time
from datetime import datetime, timezone
from fastapi import APIRouter, Request, Response, HTTPException
from pydantic import BaseModel, Field, field_validator
from typing import Literal
from .auth import current
from .database import transaction
from .exams import (
    answers,
    evidence,
    expire,
    finish,
    grade,
    questions,
    save_report,
    session,
    uid,
)
from .fusion_engine import generate_report, heuristic_report
from .gemini_client import generate
from .verification_engine import verify_answer

router = APIRouter()


class Start(BaseModel):
    roll_no: str

    @field_validator("roll_no", mode="before")
    @classmethod
    def validate_roll(cls, value):
        if not isinstance(value, str) or not re.fullmatch(r"[0-9]{11}", value.strip()):
            raise HTTPException(422, "Roll number must be exactly 11 numeric digits.")
        return value.strip()

    candidate_name: str = Field(default="", max_length=160)
    reference_photo: str = Field(default="", max_length=210000)
    telemetry: dict = Field(default_factory=dict)


def student_view(db, s):
    qs = json.loads(s["question_snapshot_json"])
    for q in qs:
        q.pop("correct_option", None)
    return dict(
        id=s["id"],
        session_id=s["id"],
        exam_title=s["exam_title"],
        status=s["status"],
        questions=qs,
        answers=answers(db, s["id"]),
        remaining_seconds=max(
            0, int(s["started_at"] + s["duration_seconds"] - time.time())
        ),
        settings=db.one(
            "SELECT sensitivity,duration_seconds,exam_title FROM exam_settings"
        ),
    )


@router.post("/api/sessions/start")
@router.post("/api/sessions")
def start(p: Start, request: Request):
    u = current(request, "student")
    with transaction(True) as db:
        cfg = db.one("SELECT * FROM exam_settings")
        s = db.one(
            "SELECT * FROM sessions WHERE owner_user_id=? AND exam_title=?",
            (u["id"], cfg["exam_title"]),
        )
        if s and (
            s["status"] == "completed"
            or s["started_at"] + s["duration_seconds"] + 90 < time.time()
        ):
            raise HTTPException(409, "Attempt already closed")
        if not s:
            previous = db.one(
                "SELECT status FROM sessions WHERE roll_no=? AND exam_title=? AND owner_user_id<>? ORDER BY status DESC LIMIT 1",
                (p.roll_no, cfg["exam_title"], u["id"]),
            )
            if previous:
                raise HTTPException(
                    409,
                    "This roll number has already submitted this examination."
                    if previous["status"] == "completed"
                    else "This roll number already has an active attempt.",
                )
            if not p.reference_photo:
                raise HTTPException(422, "A live reference photo is required")
            qs = questions(db)
            if not qs:
                raise HTTPException(409, "No questions available")
            sid = uid()
            db.execute(
                "INSERT INTO sessions(id,candidate_name,roll_no,exam_title,started_at,status,owner_user_id,question_snapshot_json,telemetry_json,duration_seconds) VALUES(?,?,?,?,?,'active',?,?,?,?)",
                (
                    sid,
                    p.candidate_name or u["display_name"],
                    p.roll_no,
                    cfg["exam_title"],
                    time.time(),
                    u["id"],
                    json.dumps(qs),
                    json.dumps(p.telemetry),
                    cfg["duration_seconds"],
                ),
            )
            path = evidence(db, sid, p.reference_photo, "reference")
            db.execute(
                "UPDATE sessions SET reference_photo_path=? WHERE id=?", (path, sid)
            )
            s = session(db, sid, u)
        return student_view(db, s)


COOLDOWN = dict(
    phone_detected=6,
    multiple_persons=8,
    multiple_faces=8,
    no_face_detected=8,
    book_detected=10,
    head_turn=10,
    eye_gaze_away=10,
    camera_lost=10,
    microphone_lost=10,
    sustained_speech=18,
    brief_ambient_sound=25,
    tab_switch=4,
    window_blur=8,
    copy_paste=5,
    fullscreen_exit=5,
    context_menu=10,
    monitoring_gap=10,
    blocked_shortcut=5,
)


class Event(BaseModel):
    modality: Literal["video", "audio", "browser"]
    event_type: str = Field(max_length=80)
    severity: Literal["high", "medium", "low"]
    confidence: float = Field(default=1, ge=0, le=1)
    queue_delay_seconds: float = Field(default=0, ge=0, allow_inf_nan=False)
    details: dict = Field(default_factory=dict)
    snapshot: str | None = Field(default=None, max_length=210000)


@router.post("/api/sessions/{sid}/events")
def event(sid: str, p: Event, request: Request):
    u = current(request, "student")
    with transaction(True, sid) as db:
        attempt = session(db, sid, u, True)
        now = time.time()
        observed = max(attempt["started_at"], now - p.queue_delay_seconds)
        if p.event_type not in COOLDOWN:
            raise HTTPException(422, "Unknown observation")
        seconds = (
            10
            if p.details.get("reason") == "suspected_person_swap"
            else COOLDOWN[p.event_type]
        )
        if not db.one(
            "SELECT id FROM events WHERE session_id=? AND event_type=? AND timestamp>? AND timestamp<?",
            (sid, p.event_type, observed - seconds, observed + seconds),
        ):
            path = evidence(db, sid, p.snapshot, p.event_type)
            db.execute(
                "INSERT INTO events VALUES(?,?,?,?,?,?,?,?,?)",
                (
                    uid(),
                    sid,
                    observed,
                    p.modality,
                    p.event_type,
                    p.severity,
                    p.confidence,
                    json.dumps(p.details),
                    path,
                ),
            )
    return {"ok": True}


class AnswerBatch(BaseModel):
    answers: dict[str, str | int]


@router.put("/api/sessions/{sid}/answers")
def save_answers(sid: str, p: AnswerBatch, request: Request):
    u = current(request, "student")
    with transaction(True, sid) as db:
        s = session(db, sid, u, True)
        qs = {q["id"]: q for q in json.loads(s["question_snapshot_json"])}
        for key, value in p.answers.items():
            q = qs.get(key)
            if (
                not q
                or len(str(value)) > 50000
                or (
                    q["type"] == "mcq"
                    and str(value) not in map(str, range(len(q["options"])))
                )
            ):
                raise HTTPException(422, "Invalid answer")
            db.execute(
                "INSERT INTO answers VALUES(?,?,?,?,?,NULL) ON CONFLICT(session_id,question_id) DO UPDATE SET answer_text=excluded.answer_text",
                (uid(), sid, key, q["type"], str(value)),
            )
    return {"ok": True}


@router.post("/api/sessions/{sid}/complete")
def complete(sid: str, request: Request):
    u = current(request, "student")
    with transaction(True, sid) as db:
        finish(db, session(db, sid, u))
    return {"ok": True}


def all_answers(db):
    grouped = {}
    for row in db.all("SELECT session_id,question_id,answer_text FROM answers"):
        grouped.setdefault(row["session_id"], {})[row["question_id"]] = row[
            "answer_text"
        ]
    return grouped


def summary(db, s, ans=None):
    qs = json.loads(s["question_snapshot_json"])
    score, total = grade(qs, answers(db, s["id"]) if ans is None else ans)
    return {
        **{
            k: s[k]
            for k in (
                "id",
                "candidate_name",
                "roll_no",
                "exam_title",
                "status",
                "started_at",
                "ended_at",
                "verdict",
                "suspicion_score",
                "reference_photo_path",
            )
        },
        "mcq_score": score,
        "mcq_max": total,
    }


@router.get("/api/sessions")
def sessions(request: Request):
    current(request, "proctor")
    with transaction(True) as db:
        expire(db)
    with transaction() as db:
        by_session = all_answers(db)
        return [
            summary(db, s, by_session.get(s["id"], {}))
            for s in db.all("SELECT * FROM sessions ORDER BY started_at DESC")
        ]


@router.get("/api/sessions/{sid}")
def detail(sid: str, request: Request):
    u = current(request)
    with transaction() as db:
        s = session(db, sid, u)
        if u["role"] == "student":
            return student_view(db, s)
        events = db.all(
            "SELECT * FROM events WHERE session_id=? ORDER BY timestamp", (sid,)
        )
        for e in events:
            e["details"] = json.loads(e.pop("details_json"))
        report = db.one(
            "SELECT * FROM fusion_reports WHERE session_id=? ORDER BY created_at DESC LIMIT 1",
            (sid,),
        )
        if report:
            for key in ("corroborated_incidents", "suppressed_false_positives"):
                report[key] = json.loads(report.pop(key + "_json"))
        return dict(
            summary(db, s),
            questions=json.loads(s["question_snapshot_json"]),
            answers=answers(db, sid),
            events=events,
            report=report or heuristic_report(events),
            telemetry=json.loads(s["telemetry_json"]),
            evidence=[
                dict(r, path="/snapshots/" + r["filename"])
                for r in db.all(
                    "SELECT filename,created_at FROM evidence_images WHERE session_id=? ORDER BY created_at",
                    (sid,),
                )
            ],
            verifications={
                r["question_id"]: json.loads(r["verification_json"])
                for r in db.all(
                    "SELECT * FROM answers WHERE session_id=? AND verification_json IS NOT NULL",
                    (sid,),
                )
            },
        )


@router.get("/api/question-images/{image_id}")
def question_image(image_id: str, request: Request, session_id: str | None = None):
    user = current(request)
    with transaction() as db:
        if user["role"] != "proctor":
            if not session_id:
                raise HTTPException(403)
            attempt = session(db, session_id, user)
            if not any(
                q.get("image_id") == image_id
                for q in json.loads(attempt["question_snapshot_json"])
            ):
                raise HTTPException(404)
        image = db.one(
            "SELECT content_type,data FROM question_images WHERE id=?", (image_id,)
        )
        if not image:
            raise HTTPException(404)
        return Response(bytes(image["data"]), media_type=image["content_type"])


@router.get("/snapshots/{filename}")
def snapshot(filename: str, request: Request):
    current(request, "proctor")
    with transaction() as db:
        r = db.one("SELECT data FROM evidence_images WHERE filename=?", (filename,))
        if not r:
            raise HTTPException(404)
        return Response(bytes(r["data"]), media_type="image/jpeg")


@router.post("/api/sessions/{sid}/fusion")
async def fusion(sid: str, request: Request):
    u = current(request, "proctor")
    with transaction() as db:
        s = session(db, sid, u)
        if s["status"] != "completed":
            raise HTTPException(409, "Submit the examination first")
        events = db.all("SELECT * FROM events WHERE session_id=?", (sid,))
    report = await generate_report(events)
    with transaction(True, sid) as db:
        save_report(db, sid, report)
    return report


@router.post("/api/sessions/{sid}/verify/{qid}")
async def verify(sid: str, qid: str, request: Request):
    u = current(request, "proctor")
    with transaction() as db:
        s = session(db, sid, u)
        if s["status"] != "completed":
            raise HTTPException(409, "Submit the examination first")
        q = next(
            (
                q
                for q in json.loads(s["question_snapshot_json"])
                if q["id"] == qid and q["type"] == "subjective"
            ),
            None,
        )
        if not q:
            raise HTTPException(404)
        answer = answers(db, sid).get(qid, "")
        paste_count = db.one(
            "SELECT COUNT(*) AS n FROM events WHERE session_id=? AND event_type='copy_paste'",
            (sid,),
        )["n"]
    result = await verify_answer(q["text"], answer, paste_count)
    with transaction(True, sid) as db:
        db.execute(
            "UPDATE answers SET verification_json=? WHERE session_id=? AND question_id=?",
            (json.dumps(result), sid, qid),
        )
    return result


@router.get("/api/health/ai")
async def health(request: Request):
    current(request, "proctor")
    r = await generate('Return JSON {"ok":true}')
    return {k: r[k] for k in ("ok", "provider", "model_used", "status_code", "error")}


@router.get("/api/export/results.csv")
def export(request: Request):
    current(request, "proctor")
    output = io.StringIO(newline="")
    writer = csv.writer(output)

    def date(t):
        return datetime.fromtimestamp(t, timezone.utc).isoformat() if t else ""

    def safe(value):
        return (
            "'" + value
            if isinstance(value, str)
            and value.lstrip().startswith(("=", "+", "-", "@"))
            else value
        )

    with transaction() as db:
        rows = db.all(
            "SELECT s.*,u.username FROM sessions s JOIN users u ON u.id=s.owner_user_id ORDER BY s.started_at"
        )
        by_session = all_answers(db)
        signals = {}
        for row in db.all(
            "SELECT session_id,modality,COUNT(*) AS n FROM events GROUP BY session_id,modality"
        ):
            signals.setdefault(row["session_id"], {})[row["modality"]] = row["n"]
        columns = {}
        for s in rows:
            for q in json.loads(s["question_snapshot_json"]):
                if q["type"] == "subjective":
                    columns[(q["id"], q["text"])] = q["text"]
        writer.writerow(
            [
                "Roll No",
                "Candidate Name",
                "Username",
                "Status",
                "Started (UTC)",
                "Submitted (UTC)",
                "MCQ Score",
                "MCQ Max",
                "Suspicion Score",
                "Verdict",
                "Video Flags",
                "Audio Flags",
                "Browser Flags",
                *map(safe, columns.values()),
            ]
        )
        for s in rows:
            qs = json.loads(s["question_snapshot_json"])
            ans = by_session.get(s["id"], {})
            counts = signals.get(s["id"], {})
            subject = {(q["id"], q["text"]): ans.get(q["id"], "") for q in qs}
            writer.writerow(
                map(
                    safe,
                    [
                        s["roll_no"],
                        s["candidate_name"],
                        s["username"],
                        s["status"],
                        date(s["started_at"]),
                        date(s["ended_at"]),
                        *grade(qs, ans),
                        s["suspicion_score"],
                        s["verdict"],
                        *[counts.get(k, 0) for k in ("video", "audio", "browser")],
                        *[subject.get(k, "") for k in columns],
                    ],
                )
            )
    return Response(
        "\ufeff" + output.getvalue(),
        media_type="text/csv",
        headers={"Content-Disposition": "attachment; filename=exam-results.csv"},
    )
