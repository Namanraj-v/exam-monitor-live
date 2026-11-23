"""Exercise independent student clients on a disposable SQLite app or staging server."""

import argparse
import asyncio
import base64
import csv
import io
import math
import os
import secrets
import tempfile
import time
from contextlib import AsyncExitStack
from pathlib import Path

import httpx


def check(condition, message):
    if not condition:
        raise RuntimeError(message)


def percentile(times, fraction):
    ordered = sorted(times)
    return ordered[max(0, math.ceil(fraction * len(ordered)) - 1)] if times else 0


async def run(args):
    prefix = "load-" + secrets.token_hex(6)
    password = secrets.token_urlsafe(16)
    timings, completed = [], {}
    snapshot = (
        "data:image/jpeg;base64,"
        + base64.b64encode(
            (Path(__file__).parent / "tests/evidence.jpg").read_bytes()
        ).decode()
    )
    async with AsyncExitStack() as stack:
        transport = None
        base = args.base_url
        if args.in_process:
            temp = stack.enter_context(tempfile.TemporaryDirectory())
            os.environ.update(
                DATABASE_URL="",
                SQLITE_PATH=str(Path(temp) / "load.db"),
                ADMIN_USERNAME=prefix,
                ADMIN_PASSWORD=password,
                EXAM_ACCESS_CODE="",
                GEMINI_API_KEY="",
            )
            from app.main import app

            await stack.enter_async_context(app.router.lifespan_context(app))
            base = "http://localhost"
            transport = httpx.ASGITransport(app=app)
        client = await stack.enter_async_context(
            httpx.AsyncClient(
                base_url=base,
                transport=transport,
                timeout=120,
                limits=httpx.Limits(
                    max_connections=args.students + 1,
                    max_keepalive_connections=args.students,
                ),
            )
        )

        # httpx stores received cookies on the shared client. Override the Cookie header on
        # every request, including anonymous ones, to keep candidate identities isolated.
        async def call(method, path, cookie="", status=200, **kwargs):
            start = time.perf_counter()
            try:
                response = await client.request(
                    method, path, headers={"Cookie": cookie}, **kwargs
                )
            finally:
                timings.append((time.perf_counter() - start) * 1000)
            check(
                response.status_code == status,
                f"{method} {path}: HTTP {response.status_code}, expected {status}",
            )
            return response

        login = await call(
            "POST",
            "/api/auth/login",
            json={
                "username": os.environ["ADMIN_USERNAME"],
                "role": "proctor",
                "proctor_pin": os.getenv("PROCTOR_PIN", ""),
                "password": os.environ["ADMIN_PASSWORD"],
            },
        )
        admin = "exam_session=" + login.cookies["exam_session"]
        questions = (await call("GET", "/api/questions", admin)).json()
        expected = sum(q["marks"] for q in questions if q["type"] == "mcq")
        check(expected > 0, "Staging exam must contain at least one MCQ")
        answers = {
            q["id"]: (
                q["correct_option"] if q["type"] == "mcq" else "Load test response."
            )
            for q in questions
        }

        async def student(i):
            username = f"{prefix}-{i}"
            auth = await call(
                "POST",
                "/api/auth/register",
                json={
                    "username": username,
                    "display_name": f"Load student {i}",
                    "password": password,
                    "access_code": os.getenv("EXAM_ACCESS_CODE", ""),
                },
            )
            cookie = "exam_session=" + auth.cookies["exam_session"]
            body = {
                "roll_no": f"{(int(prefix[5:], 16) + i) % 100000000000:011d}",
                "reference_photo": snapshot,
            }
            started = (await call("POST", "/api/sessions", cookie, json=body)).json()
            sid = started["id"]
            session = f"/api/sessions/{sid}"
            resumed = (await call("POST", "/api/sessions", cookie, json=body)).json()
            check(resumed["id"] == sid, "Resume changed session")
            for payload in (started, resumed):
                check(
                    all("correct_option" not in q for q in payload["questions"]),
                    "Answer key leaked",
                )
                check(
                    {
                        "events",
                        "report",
                        "evidence",
                        "suspicion_score",
                        "verdict",
                    }.isdisjoint(payload),
                    "Audit metadata leaked",
                )
            event = await call(
                "POST",
                session + "/events",
                cookie,
                json={
                    "modality": "browser",
                    "event_type": "tab_switch",
                    "severity": "medium",
                    "snapshot": snapshot,
                    "details": {"source": "load-test"},
                },
            )
            check(event.json() == {"ok": True}, "Event response leaked metadata")
            await call("PUT", session + "/answers", cookie, json={"answers": answers})
            await call("POST", session + "/complete", cookie)
            await call("GET", "/snapshots/test.jpg", cookie, status=403)
            completed[username] = expected

        start = time.perf_counter()
        results = await asyncio.gather(
            *(student(i) for i in range(args.students)), return_exceptions=True
        )
        errors = [str(r) for r in results if isinstance(r, BaseException)]
        export = await call("GET", "/api/export/results.csv", admin)
        check(export.content.startswith(b"\xef\xbb\xbf"), "Missing CSV BOM")
        rows = {
            r["Username"]: r
            for r in csv.DictReader(io.StringIO(export.content.decode("utf-8-sig")))
        }
        for username, score in completed.items():
            row = rows.get(username, {})
            if (
                row.get("Status") != "completed"
                or float(row.get("MCQ Score", -1)) != score
                or float(row.get("MCQ Max", -1)) != score
                or row.get("Browser Flags") != "1"
            ):
                errors.append(f"Incorrect export for {username}")
        elapsed = time.perf_counter() - start
        successes = max(0, args.students - len(errors))
        print(
            f"{successes}/{args.students} students ({successes / args.students:.1%}), {len(timings)} requests, "
            f"{elapsed:.2f}s elapsed, p50 {percentile(timings, 0.50):.1f} ms, p95 {percentile(timings, 0.95):.1f} ms"
        )
        print(f"Errors: {len(errors)}")
        for error in errors[:20]:
            print(error)
        return int(bool(errors))


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    target = parser.add_mutually_exclusive_group(required=True)
    target.add_argument("--in-process", action="store_true")
    target.add_argument(
        "--base-url",
        help="Dedicated staging URL. Creates permanent test users and attempts.",
    )
    parser.add_argument("--students", type=int, default=250)
    args = parser.parse_args()
    if args.students < 1:
        parser.error("--students must be positive")
    if args.base_url and not all(
        os.getenv(k) for k in ("ADMIN_USERNAME", "ADMIN_PASSWORD")
    ):
        parser.error("Set ADMIN_USERNAME and ADMIN_PASSWORD for staging")
    raise SystemExit(asyncio.run(run(args)))
