import hashlib
import base64
import binascii
import json
import os
import time
from uuid import uuid4
from fastapi import HTTPException
from pydantic import BaseModel, Field, model_validator
from typing import Literal
from .fusion_engine import heuristic_report


def uid():
    return uuid4().hex


class Question(BaseModel):
    type: Literal["mcq", "subjective"]
    text: str = Field(min_length=1, max_length=12000)
    marks: float = Field(default=1, gt=0, le=1000, allow_inf_nan=False)
    options: list[str] = Field(default_factory=list, max_length=6)
    correct_option: int | None = None
    image: str | None = Field(default=None, max_length=2796250)

    @model_validator(mode="after")
    def validate_options(self):
        if self.type == "mcq" and (
            len(self.options) < 2
            or self.correct_option not in range(len(self.options))
            or any(not o.strip() or len(o) > 4000 for o in self.options)
        ):
            raise ValueError("Provide 2–6 choices and a valid correct option")
        return self


def questions(db):
    rows = db.all(
        "SELECT q.*,a.image_id FROM questions q LEFT JOIN question_attachments a ON a.question_id=q.id ORDER BY q.position,q.id"
    )
    for q in rows:
        q["options"] = json.loads(q.pop("options_json"))
    return rows


def insert_question(db, q):
    key = uid()
    pos = db.one("SELECT COALESCE(MAX(position),0)+1 AS n FROM questions")["n"]
    db.execute(
        "INSERT INTO questions VALUES(?,?,?,?,?,?,?,?)",
        (
            key,
            pos,
            q.type,
            q.text,
            json.dumps(q.options),
            q.correct_option,
            q.marks,
            time.time(),
        ),
    )
    update_attachment(db, key, q)
    return key


def update_attachment(db, key, question):
    # Omitted during a text-only update. Explicit null removes the attachment.
    if "image" not in question.model_fields_set:
        return
    db.execute("DELETE FROM question_attachments WHERE question_id=?", (key,))
    if question.image is None:
        return
    header, _, payload = question.image.partition(",")
    try:
        data = base64.b64decode(payload, validate=True)
    except (ValueError, binascii.Error):
        raise HTTPException(422, "Invalid question image.")
    formats = {
        "data:image/png;base64": ("image/png", b"\x89PNG\r\n\x1a\n"),
        "data:image/jpeg;base64": ("image/jpeg", b"\xff\xd8\xff"),
    }
    if (
        header not in formats
        or not data.startswith(formats[header][1])
        or len(data) > 2 * 1024 * 1024
    ):
        raise HTTPException(422, "Choose a PNG or JPEG image up to 2 MB.")
    image_id = hashlib.sha256(data).hexdigest()
    db.execute(
        "INSERT INTO question_images VALUES(?,?,?) ON CONFLICT(id) DO NOTHING",
        (image_id, formats[header][0], data),
    )
    db.execute("INSERT INTO question_attachments VALUES(?,?)", (key, image_id))


def save_report(db, sid, r):
    db.execute(
        "INSERT INTO fusion_reports VALUES(?,?,?,?,?,?,?,?,?)",
        (
            uid(),
            sid,
            time.time(),
            r["suspicion_score"],
            r["verdict"],
            r["narrative"],
            json.dumps(r["corroborated_incidents"]),
            json.dumps(r["suppressed_false_positives"]),
            r["engine_used"],
        ),
    )
    db.execute(
        "UPDATE sessions SET suspicion_score=?,verdict=? WHERE id=?",
        (r["suspicion_score"], r["verdict"], sid),
    )


def finish(db, s):
    if s["status"] == "active":
        save_report(
            db,
            s["id"],
            heuristic_report(
                db.all("SELECT * FROM events WHERE session_id=?", (s["id"],))
            ),
        )
        db.execute(
            "UPDATE sessions SET status='completed',ended_at=? WHERE id=?",
            (time.time(), s["id"]),
        )


def expire(db):
    for s in db.all(
        "SELECT * FROM sessions WHERE status='active' AND started_at+duration_seconds+90<?",
        (time.time(),),
    ):
        finish(db, s)


def guard_builder(db):
    expire(db)
    if db.one("SELECT id FROM sessions WHERE status='active' LIMIT 1"):
        raise HTTPException(
            409, "Changes are locked while students are taking the examination."
        )


def session(db, sid, user, active=False):
    s = db.one("SELECT * FROM sessions WHERE id=?", (sid,))
    if not s or (user["role"] != "proctor" and s["owner_user_id"] != user["id"]):
        raise HTTPException(404, "Session not found")
    if active and (
        s["status"] != "active"
        or time.time() > s["started_at"] + s["duration_seconds"] + 90
    ):
        raise HTTPException(409, "Submission window closed")
    return s


def answers(db, sid):
    return {
        r["question_id"]: r["answer_text"]
        for r in db.all(
            "SELECT question_id,answer_text FROM answers WHERE session_id=?", (sid,)
        )
    }


def grade(qs, ans):
    mcq = [q for q in qs if q["type"] == "mcq"]
    return sum(
        q["marks"] for q in mcq if str(ans.get(q["id"])) == str(q["correct_option"])
    ), sum(q["marks"] for q in mcq)


CRITICAL = {"multiple_persons", "multiple_faces", "phone_detected", "no_face_detected"}


def evidence(db, sid, data, kind):
    if not data:
        return None
    try:
        raw = base64.b64decode(
            data.removeprefix("data:image/jpeg;base64,"), validate=True
        )
    except (ValueError, binascii.Error):
        raise HTTPException(422, "Invalid JPEG encoding")
    if (
        len(raw) > 150 * 1024
        or not raw.startswith(b"\xff\xd8")
        or not raw.endswith(b"\xff\xd9")
    ):
        raise HTTPException(422, "Expected a JPEG up to 150 KB")
    cap = max(7, int(os.getenv("MAX_EVIDENCE_PER_SESSION", "15")))
    rows = db.all(
        "SELECT filename FROM evidence_images WHERE session_id=? ORDER BY created_at",
        (sid,),
    )
    expendable = [
        r["filename"]
        for r in rows
        if r["filename"].split("-")[0] not in CRITICAL | {"reference"}
    ]
    if kind not in CRITICAL | {"reference"} and cap == 7:
        return None
    if (kind not in CRITICAL | {"reference"} and len(expendable) >= cap - 7) or len(
        rows
    ) >= cap:
        if not expendable:
            return None
        db.execute(
            "UPDATE events SET snapshot_path=NULL WHERE snapshot_path=?",
            ("/snapshots/" + expendable[0],),
        )
        db.execute("DELETE FROM evidence_images WHERE filename=?", (expendable[0],))
    name = kind + "-" + uid() + ".jpg"
    db.execute(
        "INSERT INTO evidence_images VALUES(?,?,?,?,?)",
        (name, sid, "image/jpeg", raw, time.time()),
    )
    return "/snapshots/" + name
