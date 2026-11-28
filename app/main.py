import hmac
import json
import os
import time
from contextlib import asynccontextmanager
from typing import Literal

from fastapi import FastAPI, HTTPException, Request, Response
from fastapi.exceptions import RequestValidationError
from fastapi.responses import JSONResponse, FileResponse
from fastapi.staticfiles import StaticFiles
from pydantic import BaseModel, Field
from . import auth, database as store
from .database import ROOT, transaction
from .exams import (
    Question,
    guard_builder,
    insert_question,
    questions,
    update_attachment,
)


@asynccontextmanager
async def lifespan(app):
    store.initialize()
    with transaction(True) as db:
        db.execute(
            "INSERT INTO exam_settings(id,exam_title,duration_seconds,access_code,sensitivity,negative_marking,updated_at) VALUES(1,?,?,?,?,?,?) ON CONFLICT(id) DO NOTHING",
            (
                "Computer Science Examination",
                3600,
                os.getenv("EXAM_ACCESS_CODE", ""),
                "standard",
                0,
                time.time(),
            ),
        )
        if not db.one("SELECT id FROM questions LIMIT 1"):
            for q in json.loads((ROOT / "exam_config.json").read_text()):
                insert_question(db, Question(**q))
        name = os.getenv("ADMIN_USERNAME", "").strip().lower()
        pw = os.getenv("ADMIN_PASSWORD", "")
        if (
            name
            and len(pw) >= 8
            and not db.one("SELECT id FROM users WHERE username=?", (name,))
        ):
            auth.create_user(
                db,
                name,
                os.getenv("ADMIN_DISPLAY_NAME", "Exam Proctor"),
                auth.password_hash(pw),
                "proctor",
            )
    yield
    if store.pool:
        store.pool.close()
        store.pool = None


app = FastAPI(title="Exam Monitor", lifespan=lifespan)


@app.exception_handler(RequestValidationError)
async def invalid_request(request, error):
    # Avoid reflecting evidence, answer text or passwords into error responses.
    messages = [
        {"loc": item["loc"], "msg": item["msg"], "type": item["type"]}
        for item in error.errors()
    ]
    return JSONResponse({"detail": messages}, status_code=422)


@app.middleware("http")
async def security(request, call_next):
    origin = request.headers.get("origin")
    if origin and request.method not in {"GET", "HEAD", "OPTIONS"}:
        scheme = (
            request.headers.get("x-forwarded-proto", request.url.scheme)
            .split(",")[0]
            .strip()
        )
        allowed = {
            scheme + "://" + request.headers.get(name, "").split(",")[0].strip()
            for name in ("host", "x-forwarded-host")
        }
        if origin not in allowed and origin != os.getenv("PUBLIC_BASE_URL", "").rstrip(
            "/"
        ):
            return JSONResponse({"detail": "Origin denied"}, 403)
    response = await call_next(request)
    response.headers.update(
        {
            "X-Content-Type-Options": "nosniff",
            "Referrer-Policy": "same-origin",
            "Permissions-Policy": "camera=(self), microphone=(self)",
        }
    )
    if request.url.path.startswith(("/api", "/snapshots")):
        response.headers["Cache-Control"] = "no-store"
    return response


class Credentials(BaseModel):
    username: str = Field(min_length=1, max_length=80)
    password: str = Field(min_length=1, max_length=512)
    display_name: str = Field(default="", max_length=160)
    role: Literal["student", "proctor"] = "student"
    proctor_pin: str = Field(default="", max_length=512)
    access_code: str = Field(default="", max_length=128)


def local_setup(r):
    return (
        not os.getenv("ADMIN_USERNAME", "").strip()
        and not store.pool
        and r.url.hostname in {"localhost", "127.0.0.1", "::1", "testserver"}
        and r.client
        and r.client.host in {"127.0.0.1", "::1", "testclient"}
        and not any(k.startswith("x-forwarded") for k in r.headers)
        and not os.getenv("SPACE_ID")
    )


@app.get("/api/auth/status")
def status(request: Request):
    user = auth.current(request, optional=True)
    with transaction() as db:
        attempt = (
            db.one(
                "SELECT s.id,s.status FROM sessions s JOIN exam_settings e ON e.exam_title=s.exam_title WHERE s.owner_user_id=?",
                (user["id"],),
            )
            if user and user["role"] == "student"
            else None
        )
        return dict(
            user=user,
            current_exam_status=attempt["status"] if attempt else "none",
            current_session_id=attempt["id"] if attempt else None,
            proctor_pin_required=bool(os.getenv("PROCTOR_PIN")),
            setup_required=bool(
                local_setup(request)
                and not db.one("SELECT id FROM users WHERE role='proctor' LIMIT 1")
            ),
            access_code_required=bool(
                db.one("SELECT access_code FROM exam_settings")["access_code"]
                or os.getenv("EXAM_ACCESS_CODE")
            ),
        )


@app.post("/api/auth/register")
@app.post("/api/auth/setup")
@app.post("/api/auth/login")
def authenticate(p: Credentials, request: Request, response: Response):
    action = request.url.path.rsplit("/", 1)[-1]
    name = p.username.strip().lower()
    if not name:
        raise HTTPException(400, "Invalid request")
    if action == "setup":
        with transaction() as db:
            if not local_setup(request) or db.one(
                "SELECT id FROM users WHERE role='proctor' LIMIT 1"
            ):
                raise HTTPException(403, "Setup unavailable")
    if action == "login" and p.role == "proctor":
        return auth.proctor_login(name, p.password, p.proctor_pin, request, response)
    auth.throttle(name)
    if action == "login":
        with transaction() as db:
            user = db.one(
                "SELECT * FROM users WHERE username=? AND role='student'", (name,)
            )
        if not user or not hmac.compare_digest(
            user["password_hash"],
            auth.password_hash(p.password, user["password_hash"].split(":")[0]),
        ):
            raise HTTPException(401, "Invalid credentials")
    else:
        if len(p.password) < 8:
            raise HTTPException(422, "Password must have at least eight characters")
        hashed = auth.password_hash(p.password)
    with transaction(True, None if action == "setup" else "auth:" + name) as db:
        if action == "setup":
            if not local_setup(request) or db.one(
                "SELECT id FROM users WHERE role='proctor' LIMIT 1"
            ):
                raise HTTPException(403, "Setup unavailable")
        if action == "register":
            code = db.one("SELECT access_code FROM exam_settings")[
                "access_code"
            ] or os.getenv("EXAM_ACCESS_CODE", "")
            if code and code != p.access_code:
                raise HTTPException(403, "Incorrect access code")
        if action != "login":
            user = auth.create_user(
                db,
                name,
                p.display_name.strip() or name,
                hashed,
                "proctor" if action == "setup" else "student",
            )
        return auth.issue(db, user, request, response)


@app.post("/api/auth/logout")
def logout(request: Request, response: Response):
    with transaction(True) as db:
        db.execute(
            "DELETE FROM login_sessions WHERE token_hash=?",
            (auth.digest(request.cookies.get("exam_session", "")),),
        )
    response.delete_cookie("exam_session")
    return {"ok": True}


class Settings(BaseModel):
    exam_title: str = Field(min_length=1, max_length=200)
    duration_seconds: int = Field(ge=1, le=86400)
    role: Literal["student", "proctor"] = "student"
    proctor_pin: str = Field(default="", max_length=512)
    access_code: str = Field(default="", max_length=128)
    sensitivity: Literal["standard", "sensitive"] = "standard"
    negative_marking: bool = False


@app.get("/api/settings")
def settings(request: Request):
    u = auth.current(request)
    with transaction() as db:
        s = db.one("SELECT * FROM exam_settings")
        s["negative_marking"] = bool(s.get("negative_marking"))
        if u["role"] != "proctor":
            s.pop("access_code")
        return s


@app.put("/api/settings")
def update_settings(p: Settings, request: Request):
    auth.current(request, "proctor")
    with transaction(True) as db:
        guard_builder(db)
        db.execute(
            "UPDATE exam_settings SET exam_title=?,duration_seconds=?,access_code=?,sensitivity=?,negative_marking=?,updated_at=?",
            (
                p.exam_title,
                p.duration_seconds,
                p.access_code,
                p.sensitivity,
                int(p.negative_marking),
                time.time(),
            ),
        )
    return {"ok": True}


@app.get("/api/questions")
def list_questions(request: Request):
    auth.current(request, "proctor")
    with transaction() as db:
        return questions(db)


@app.post("/api/questions")
def add_question(p: Question, request: Request):
    auth.current(request, "proctor")
    with transaction(True) as db:
        guard_builder(db)
        return {"id": insert_question(db, p)}


class Import(BaseModel):
    questions: list[Question] = Field(min_length=1, max_length=150)
    mode: Literal["append", "replace"] = "append"


@app.post("/api/questions/import")
def bulk(p: Import, request: Request):
    auth.current(request, "proctor")
    with transaction(True) as db:
        guard_builder(db)
        if p.mode == "replace":
            db.execute("DELETE FROM questions")
        return {"ids": [insert_question(db, q) for q in p.questions]}


@app.put("/api/questions/{qid}")
def edit(qid: str, p: Question, request: Request):
    auth.current(request, "proctor")
    with transaction(True) as db:
        guard_builder(db)
        if not db.execute(
            "UPDATE questions SET type=?,text=?,options_json=?,correct_option=?,marks=? WHERE id=?",
            (p.type, p.text, json.dumps(p.options), p.correct_option, p.marks, qid),
        ).rowcount:
            raise HTTPException(404, "Unknown question")
        update_attachment(db, qid, p)
    return {"ok": True}


@app.delete("/api/questions/{qid}")
def delete(qid: str, request: Request):
    auth.current(request, "proctor")
    with transaction(True) as db:
        guard_builder(db)
        db.execute("DELETE FROM questions WHERE id=?", (qid,))
    return {"ok": True}


@app.post("/api/questions/{qid}/move")
def move(qid: str, p: dict, request: Request):
    auth.current(request, "proctor")
    with transaction(True) as db:
        guard_builder(db)
        rows = questions(db)
        i = next((i for i, q in enumerate(rows) if q["id"] == qid), None)
        if i is None or p.get("direction") not in {"up", "down"}:
            raise HTTPException(422, "Invalid move")
        j = i + (-1 if p["direction"] == "up" else 1)
        if 0 <= j < len(rows):
            for a, b in ((i, j), (j, i)):
                db.execute(
                    "UPDATE questions SET position=? WHERE id=?",
                    (rows[b]["position"], rows[a]["id"]),
                )
    return {"ok": True}


from .session_routes import router


@app.get("/proctor", include_in_schema=False)
def proctor_portal():
    return FileResponse(ROOT / "app" / "static" / "index.html")


app.include_router(router)
app.mount("/", StaticFiles(directory=ROOT / "app" / "static", html=True), name="site")
