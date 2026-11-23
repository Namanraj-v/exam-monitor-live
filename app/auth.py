import hmac
import json
import os
import hashlib
import secrets
import time
from uuid import uuid4
from fastapi import HTTPException, Request
from .database import transaction


def password_hash(password, salt=None):
    salt = salt or secrets.token_hex(16)
    digest = hashlib.pbkdf2_hmac(
        "sha256", password.encode(), bytes.fromhex(salt), 150000
    )
    return salt + ":" + digest.hex()


def create_user(db, username, display_name, hashed, role):
    uid = str(uuid4())
    if not db.execute(
        "INSERT INTO users VALUES(?,?,?,?,?,?) ON CONFLICT(username) DO NOTHING",
        (uid, username, display_name, hashed, role, time.time()),
    ).rowcount:
        raise HTTPException(409, "Username already exists")
    return dict(id=uid, username=username, display_name=display_name, role=role)


def throttle(username):
    now = time.time()
    with transaction(True, "auth:" + username) as db:
        row = db.one("SELECT * FROM auth_counts WHERE username=?", (username,))
        if row and now - row["started"] < 60 and row["count"] >= 15:
            raise HTTPException(429, "Try again in one minute")
        fresh = not row or now - row["started"] >= 60
        db.execute(
            "INSERT INTO auth_counts VALUES(?,?,?) ON CONFLICT(username) DO UPDATE SET started=excluded.started,count=excluded.count",
            (
                username,
                now if fresh else row["started"],
                1 if fresh else row["count"] + 1,
            ),
        )


def digest(token):
    return hashlib.sha256(token.encode()).hexdigest()


def issue(db, user, request, response):
    token = secrets.token_urlsafe(32)
    db.execute(
        "INSERT INTO login_sessions VALUES(?,?,?)",
        (digest(token), user["id"], time.time() + 43200),
    )
    response.set_cookie(
        "exam_session",
        token,
        max_age=43200,
        httponly=True,
        samesite="lax",
        secure=request.url.scheme == "https"
        or request.headers.get("x-forwarded-proto") == "https",
    )
    return {"user": {k: user[k] for k in ("id", "username", "display_name", "role")}}


def current(request: Request, role=None, optional=False):
    with transaction() as db:
        user = db.one(
            "SELECT u.id,u.username,u.display_name,u.role FROM users u JOIN login_sessions s ON s.user_id=u.id WHERE s.token_hash=? AND s.expires_at>?",
            (digest(request.cookies.get("exam_session", "")), time.time()),
        )
    if not user and not optional:
        raise HTTPException(401, "Sign in required")
    if role and (not user or user["role"] != role):
        raise HTTPException(403, "Access denied")
    return user


def proctor_login(name, password, pin, request, response):
    # Serialize checks across workers so concurrent failures cannot bypass the limit.
    with transaction(True, "proctor:" + name) as db:
        now = time.time()
        state = db.one("SELECT * FROM proctor_login_limits WHERE username=?", (name,))
        if state and state["locked_until"] > now:
            raise HTTPException(429, "Proctor login locked. Try again in 15 minutes.")
        failures = (
            [t for t in json.loads(state["failures"]) if t > now - 900] if state else []
        )
        user = db.one(
            "SELECT * FROM users WHERE username=? AND role='proctor'", (name,)
        )
        required = os.getenv("PROCTOR_PIN", "")
        valid_pin = not required or hmac.compare_digest(required.encode(), pin.encode())
        if (
            user
            and hmac.compare_digest(
                user["password_hash"],
                password_hash(password, user["password_hash"].split(":")[0]),
            )
            and valid_pin
        ):
            db.execute("DELETE FROM proctor_login_limits WHERE username=?", (name,))
            return issue(db, user, request, response)
        failures.append(now)
        locked = len(failures) >= 5
        db.execute(
            "INSERT INTO proctor_login_limits VALUES(?,?,?) ON CONFLICT(username) DO UPDATE SET failures=excluded.failures,locked_until=excluded.locked_until",
            (name, json.dumps(failures), now + 900 if locked else 0),
        )
    # Commit the failure before raising the HTTP error.
    raise HTTPException(
        429 if locked else 401,
        "Proctor login locked. Try again in 15 minutes."
        if locked
        else "Invalid credentials",
    )
