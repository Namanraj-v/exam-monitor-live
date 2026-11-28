import base64
import csv
import io
import time
from pathlib import Path

import pytest
from fastapi.testclient import TestClient

from app.database import transaction
from app.fusion_engine import heuristic_report
from app.main import app


PASSWORD = "long-password"
PHOTO = (
    "data:image/jpeg;base64,"
    + base64.b64encode(Path(__file__).with_name("evidence.jpg").read_bytes()).decode()
)


@pytest.fixture
def clients(tmp_path, monkeypatch):
    for key, value in {
        "DATABASE_URL": "",
        "SQLITE_PATH": str(tmp_path / "test.db"),
        "ADMIN_USERNAME": "proctor",
        "ADMIN_PASSWORD": PASSWORD,
        "EXAM_ACCESS_CODE": "",
        "GEMINI_API_KEY": "",
        "MAX_EVIDENCE_PER_SESSION": "8",
    }.items():
        monkeypatch.setenv(key, value)
    with TestClient(app) as admin:
        assert (
            admin.post(
                "/api/auth/login",
                json={"username": "proctor", "password": PASSWORD, "role": "proctor"},
            ).status_code
            == 200
        )
        student = TestClient(app)
        try:
            yield admin, student
        finally:
            student.close()


def register(client, name="student", **kwargs):
    return client.post(
        "/api/auth/register", json={"username": name, "password": PASSWORD, **kwargs}
    )


def begin(student):
    assert register(student).status_code == 200
    return (
        student.post(
            "/api/sessions", json={"roll_no": "00000000101", "reference_photo": PHOTO}
        )
        .raise_for_status()
        .json()
    )


def test_access_code_auth_and_rate_limit(clients):
    admin, student = clients
    settings = admin.get("/api/settings").json()
    settings["access_code"] = "cohort"
    assert admin.put("/api/settings", json=settings).status_code == 200
    assert student.get("/api/auth/status").json()["access_code_required"]
    assert register(student).status_code == 403
    assert register(student, access_code="cohort").status_code == 200
    assert "access_code" not in student.get("/api/settings").json()
    for _ in range(15):
        assert (
            student.post(
                "/api/auth/login", json={"username": "absent", "password": PASSWORD}
            ).status_code
            == 401
        )
    assert (
        student.post(
            "/api/auth/login", json={"username": "absent", "password": PASSWORD}
        ).status_code
        == 429
    )
    assert register(student, "other", access_code="cohort").status_code == 200
    assert student.post("/api/auth/logout").status_code == 200
    assert student.get("/api/settings").status_code == 401


def test_student_privacy_and_event_cooldown(clients):
    admin, student = clients
    started = begin(student)
    sid = started["id"]
    for result in [started, student.get(f"/api/sessions/{sid}").json()]:
        assert not {
            "suspicion_score",
            "verdict",
            "evidence",
            "events",
            "report",
        }.intersection(result)
        assert all("correct_option" not in q for q in result["questions"])
    for path in (
        "/api/questions",
        "/api/sessions",
        "/api/health/ai",
        "/api/export/results.csv",
    ):
        assert student.get(path).status_code == 403
    event = {
        "modality": "video",
        "severity": "high",
        "event_type": "phone_detected",
        "snapshot": PHOTO,
    }
    for _ in range(2):
        assert student.post(f"/api/sessions/{sid}/events", json=event).json() == {
            "ok": True
        }
    detail = admin.get(f"/api/sessions/{sid}").json()
    assert len(detail["events"]) == 1
    path = detail["events"][0]["snapshot_path"]
    assert student.get(path).status_code == 403
    assert (
        admin.get(path).content == Path(__file__).with_name("evidence.jpg").read_bytes()
    )
    assert register(student, "different").status_code == 200
    assert student.get(f"/api/sessions/{sid}").status_code == 404


def test_question_crud_lock_snapshot_grading_and_export(clients):
    admin, student = clients
    base = {
        "type": "mcq",
        "text": "A plus B?",
        "options": ["A", "B"],
        "correct_option": 1,
        "marks": 4,
    }
    qid = admin.post(
        "/api/questions/import", json={"mode": "replace", "questions": [base]}
    ).json()["ids"][0]
    subject = {"type": "subjective", "text": "Explain your answer."}
    subid = admin.post("/api/questions", json=subject).json()["id"]
    assert (
        admin.post(f"/api/questions/{subid}/move", json={"direction": "up"}).status_code
        == 200
    )
    assert admin.get("/api/questions").json()[0]["id"] == subid
    sid = begin(student)["id"]
    route = f"/api/sessions/{sid}"
    assert admin.delete(f"/api/questions/{qid}").status_code == 409
    assert admin.put(f"/api/questions/{qid}", json=base).status_code == 409
    assert (
        admin.post(
            "/api/questions/import", json={"mode": "replace", "questions": [base]}
        ).status_code
        == 409
    )
    assert (
        student.put(
            route + "/answers", json={"answers": {qid: 1, subid: "Because."}}
        ).status_code
        == 200
    )
    resumed = student.post("/api/sessions", json={"roll_no": "00000000101"}).json()
    assert resumed["id"] == sid and resumed["answers"] == {qid: "1", subid: "Because."}
    assert student.post(route + "/complete").json() == {"ok": True}
    assert (
        student.post("/api/sessions", json={"roll_no": "00000000101"}).status_code
        == 409
    )
    assert (
        admin.put(
            f"/api/questions/{qid}", json={**base, "correct_option": 0, "marks": 2}
        ).status_code
        == 200
    )
    assert admin.delete(f"/api/questions/{subid}").status_code == 200
    detail = admin.get(route).json()
    assert detail["mcq_score"] == detail["mcq_max"] == 4
    assert detail["report"]["engine_used"] == "local-rule-engine"
    export = admin.get("/api/export/results.csv").content
    assert export.startswith(b"\xef\xbb\xbf")
    (row,) = csv.DictReader(io.StringIO(export.decode("utf-8-sig")))
    assert row["Explain your answer."] == "Because." and float(row["MCQ Score"]) == 4


def test_timer_and_submission_grace(clients):
    admin, student = clients
    sid = begin(student)["id"]
    route = f"/api/sessions/{sid}"
    with transaction(True) as db:
        db.execute(
            "UPDATE sessions SET started_at=?,duration_seconds=1 WHERE id=?",
            (time.time() - 2, sid),
        )
    assert student.get(route).json()["remaining_seconds"] == 0
    assert student.put(route + "/answers", json={"answers": {}}).status_code == 200
    with transaction(True) as db:
        db.execute(
            "UPDATE sessions SET started_at=? WHERE id=?", (time.time() - 100, sid)
        )
    assert student.put(route + "/answers", json={"answers": {}}).status_code == 409
    assert admin.get("/api/sessions").json()[0]["status"] == "completed"


def test_evidence_cap_eviction_and_reserve(clients):
    admin, student = clients
    sid = begin(student)["id"]
    route = f"/api/sessions/{sid}"

    def event(kind, modality="video"):
        with transaction(True) as db:
            db.execute(
                "UPDATE events SET timestamp=timestamp-30 WHERE session_id=?", (sid,)
            )
        return student.post(
            route + "/events",
            json={
                "event_type": kind,
                "modality": modality,
                "severity": "medium",
                "snapshot": PHOTO,
            },
        )

    assert event("head_turn").status_code == 200
    old = admin.get(route).json()["events"][0]["snapshot_path"]
    assert event("book_detected").status_code == 200
    assert admin.get(old).status_code == 404
    assert len(admin.get(route).json()["evidence"]) == 2
    for _ in range(8):
        assert event("phone_detected").status_code == 200
    detail = admin.get(route).json()
    assert (
        len(detail["evidence"]) == 8
        and admin.get(detail["reference_photo_path"]).status_code == 200
    )
    assert all(
        not e["snapshot_path"] or admin.get(e["snapshot_path"]).status_code == 200
        for e in detail["events"]
    )


def test_fusion_assigns_events_once_and_suppresses_isolated_low():
    def signal(i, t, kind, modality, severity):
        return dict(
            id=i, timestamp=t, event_type=kind, modality=modality, severity=severity
        )

    events = [
        signal(1, 0, "phone_detected", "video", "high"),
        signal(2, 15, "tab_switch", "browser", "medium"),
        signal(3, 16, "sustained_speech", "audio", "medium"),
        signal(4, 40, "window_blur", "browser", "low"),
    ]
    result = heuristic_report(events)
    assert (
        result["suspicion_score"] == 25 + 12 + 8 + 1.5 + 15
        and result["verdict"] == "High Suspicion"
    )
    assert len(result["corroborated_incidents"]) == 1
    assert result["suppressed_false_positives"][0]["event_id"] == 4
    assert heuristic_report([])["verdict"] == "Clean"
    assert heuristic_report(events * 10)["suspicion_score"] == 100


def test_origin_and_validation(clients):
    admin, student = clients
    req = {"username": "sample", "password": PASSWORD}
    assert (
        student.post(
            "/api/auth/register",
            json=req,
            headers={"Origin": "https://unrelated.invalid"},
        ).status_code
        == 403
    )
    assert (
        admin.post(
            "/api/questions",
            json={"type": "mcq", "text": "x", "options": ["x"], "correct_option": 3},
        ).status_code
        == 422
    )
    result = student.post(
        "/api/auth/register", json=req, headers={"X-Forwarded-Proto": "https"}
    )
    assert {"secure", "httponly", "samesite=lax"} <= {
        item.strip().lower() for item in result.headers["set-cookie"].split(";")
    }


def test_ai_health_and_fusion_without_credentials(clients, monkeypatch):
    admin, student = clients
    monkeypatch.setenv("GOOGLE_API_KEY", "")
    health = admin.get("/api/health/ai").raise_for_status().json()
    assert health["ok"] is False and health["provider"] == "gemini" and health["error"]
    sid = begin(student)["id"]
    route = f"/api/sessions/{sid}"
    assert admin.post(route + "/fusion").status_code == 409
    assert student.post(route + "/complete").status_code == 200
    report = admin.post(route + "/fusion").raise_for_status().json()
    assert (
        report["engine_used"] == "local-rule-engine" and report["suspicion_score"] == 0
    )
    assert report["verdict"] == "Clean"


def test_local_setup_only_on_fresh_loopback_install(tmp_path, monkeypatch):
    for key, value in {
        "DATABASE_URL": "",
        "SQLITE_PATH": str(tmp_path / "fresh.db"),
        "ADMIN_USERNAME": "",
        "ADMIN_PASSWORD": "",
        "SPACE_ID": "",
    }.items():
        monkeypatch.setenv(key, value)
    credentials = {"username": "localadmin", "password": PASSWORD}
    with TestClient(app, base_url="http://localhost") as local:
        assert local.get("/api/auth/status").json()["setup_required"]
        assert (
            local.post(
                "/api/auth/setup",
                json=credentials,
                headers={"X-Forwarded-Proto": "https"},
            ).status_code
            == 403
        )
        assert (
            local.post("/api/auth/setup", json=credentials)
            .raise_for_status()
            .json()["user"]["role"]
            == "proctor"
        )
        assert not local.get("/api/auth/status").json()["setup_required"]
        assert (
            local.post(
                "/api/auth/setup", json={"username": "second", "password": PASSWORD}
            ).status_code
            == 403
        )


def test_portals_pin_and_lockout(clients, monkeypatch):
    admin, student = clients
    monkeypatch.setenv("PROCTOR_PIN", "007911")
    assert student.get("/proctor").status_code == 200
    assert student.get("/api/auth/status").json()["proctor_pin_required"]
    credentials = dict(username="proctor", password=PASSWORD)
    assert student.post("/api/auth/login", json=credentials).status_code == 401
    assert (
        register(student, "testrole", role="proctor").json()["user"]["role"]
        == "student"
    )
    assert (
        student.post(
            "/api/auth/login",
            json=dict(
                username="testrole",
                password=PASSWORD,
                role="proctor",
                proctor_pin="007911",
            ),
        ).status_code
        == 401
    )
    credentials.update(role="proctor", proctor_pin="007911")
    assert student.post("/api/auth/login", json=credentials).status_code == 200
    for i in range(5):
        result = student.post(
            "/api/auth/login", json={**credentials, "proctor_pin": "wrong"}
        )
        assert result.status_code == (429 if i == 4 else 401)
    assert student.post("/api/auth/login", json=credentials).status_code == 429
    with transaction(True) as db:
        db.execute(
            "UPDATE proctor_login_limits SET locked_until=0,failures='[]' WHERE username='proctor'"
        )
    assert student.post("/api/auth/login", json=credentials).status_code == 200


def test_roll_and_completed_refresh(clients):
    _, student = clients
    assert register(student).status_code == 200
    for roll in ("12", "0123456789A", "123456789012"):
        assert (
            student.post("/api/sessions/start", json={"roll_no": roll}).status_code
            == 422
        )
    body = {"roll_no": " 00123456789 ", "reference_photo": PHOTO}
    sid = student.post("/api/sessions/start", json=body).raise_for_status().json()["id"]
    assert student.get("/api/auth/status").json()["current_exam_status"] == "active"
    student.post(f"/api/sessions/{sid}/complete").raise_for_status()
    assert student.get("/api/auth/status").json()["current_exam_status"] == "completed"
    assert register(student, "another").status_code == 200
    assert student.get("/api/auth/status").json()["current_exam_status"] == "none"
    res = student.post("/api/sessions/start", json=body)
    assert (
        res.status_code == 409
        and res.json()["detail"]
        == "This roll number has already submitted this examination."
    )


def test_optional_question_image_and_frozen_attempt(clients):
    admin, student = clients
    question = {"type": "subjective", "text": "Describe the diagram.", "image": PHOTO}
    qid = admin.post("/api/questions", json=question).raise_for_status().json()["id"]
    attempt = begin(student)
    frozen = next(q for q in attempt["questions"] if q["id"] == qid)
    url = "/api/question-images/" + frozen["image_id"]
    student_url = url + "?session_id=" + attempt["id"]
    assert student.get(url).status_code == 403
    assert (
        student.get(student_url).content
        == Path(__file__).with_name("evidence.jpg").read_bytes()
    )
    assert student.get(url + "?session_id=invalid").status_code == 404
    student.post("/api/sessions/" + attempt["id"] + "/complete").raise_for_status()
    del question["image"]
    admin.put("/api/questions/" + qid, json=question).raise_for_status()

    def current_image():
        return next(
            q["image_id"] for q in admin.get("/api/questions").json() if q["id"] == qid
        )

    assert current_image() == frozen["image_id"]
    assert (
        admin.put(
            "/api/questions/" + qid, json={**question, "image": "invalid"}
        ).status_code
        == 422
    )
    assert current_image() == frozen["image_id"]
    admin.put(
        "/api/questions/" + qid, json={**question, "image": None}
    ).raise_for_status()
    assert current_image() is None
    assert admin.get(url).status_code == 200
    assert student.get(student_url).status_code == 200


def test_negative_marking_toggle_grading_snapshot_and_export(clients):
    admin, student = clients
    q_right, q_wrong, q_skip = admin.post(
        "/api/questions/import",
        json={
            "mode": "replace",
            "questions": [
                {
                    "type": "mcq",
                    "text": "Q1",
                    "options": ["A", "B"],
                    "correct_option": 0,
                    "marks": 5,
                },
                {
                    "type": "mcq",
                    "text": "Q2",
                    "options": ["A", "B"],
                    "correct_option": 1,
                    "marks": 3,
                },
                {
                    "type": "mcq",
                    "text": "Q3",
                    "options": ["A", "B"],
                    "correct_option": 0,
                    "marks": 2,
                },
                {"type": "subjective", "text": "Q4", "marks": 4},
            ],
        },
    ).json()["ids"][:3]

    settings = admin.get("/api/settings").json()
    assert settings["negative_marking"] is False
    settings["negative_marking"] = True
    admin.put("/api/settings", json=settings).raise_for_status()
    assert admin.get("/api/settings").json()["negative_marking"] is True

    started = begin(student)
    sid = started["id"]
    assert started["settings"]["negative_marking"] is True
    assert admin.put("/api/settings", json={**settings, "negative_marking": False}).status_code == 409

    student.put(
        f"/api/sessions/{sid}/answers",
        json={"answers": {q_right: 0, q_wrong: 0}},
    ).raise_for_status()
    student.post(f"/api/sessions/{sid}/complete").raise_for_status()

    detail = admin.get(f"/api/sessions/{sid}").json()
    assert detail["negative_marking"] is True
    assert detail["mcq_score"] == 0.75
    assert detail["mcq_max"] == 3

    # Turning negative marking off for the next exam preserves completed attempt score
    settings["negative_marking"] = False
    admin.put("/api/settings", json=settings).raise_for_status()
    assert admin.get(f"/api/sessions/{sid}").json()["mcq_score"] == 0.75

    # Next attempt with negative marking turned off uses question marks (5)
    assert register(student, "student2").status_code == 200
    sid2 = (
        student.post(
            "/api/sessions",
            json={"roll_no": "00000000102", "reference_photo": PHOTO},
        )
        .raise_for_status()
        .json()["id"]
    )
    student.put(
        f"/api/sessions/{sid2}/answers",
        json={"answers": {q_right: 0, q_wrong: 0}},
    ).raise_for_status()
    student.post(f"/api/sessions/{sid2}/complete").raise_for_status()
    detail2 = admin.get(f"/api/sessions/{sid2}").json()
    assert detail2["negative_marking"] is False
    assert detail2["mcq_score"] == 5
    assert detail2["mcq_max"] == 10

    # Net negative score when only wrong answers are selected under negative marking
    settings["negative_marking"] = True
    admin.put("/api/settings", json=settings).raise_for_status()
    assert register(student, "student3").status_code == 200
    sid3 = (
        student.post(
            "/api/sessions",
            json={"roll_no": "00000000103", "reference_photo": PHOTO},
        )
        .raise_for_status()
        .json()["id"]
    )
    student.put(
        f"/api/sessions/{sid3}/answers",
        json={"answers": {q_wrong: 0}},
    ).raise_for_status()
    student.post(f"/api/sessions/{sid3}/complete").raise_for_status()
    assert admin.get(f"/api/sessions/{sid3}").json()["mcq_score"] == -0.25

    export = admin.get("/api/export/results.csv").content.decode("utf-8-sig")
    rows = {r["Roll No"]: r for r in csv.DictReader(io.StringIO(export))}
    assert float(rows["00000000101"]["MCQ Score"]) == 0.75
    assert float(rows["00000000102"]["MCQ Score"]) == 5.0
    assert float(rows["00000000103"]["MCQ Score"]) == -0.25


def test_teacher_uploads_mcq_with_answers_and_matches_mcq_only(clients):
    admin, student = clients
    # Teacher uploads MCQs using answer letters/text plus a subjective question (which must not be auto-graded)
    ids = admin.post(
        "/api/questions/import",
        json={
            "mode": "replace",
            "questions": [
                {
                    "type": "mcq",
                    "text": "Protocol with handshake?",
                    "options": ["UDP", "TCP", "ICMP"],
                    "answer": "B",
                    "marks": 2,
                },
                {
                    "type": "mcq",
                    "text": "ACID A stands for?",
                    "options": ["Atomicity", "Availability"],
                    "answer": "atomicity",
                    "marks": 3,
                },
                {
                    "type": "subjective",
                    "text": "Explain TCP congestion control.",
                    "marks": 10,
                    "correct_option": 0,
                },
            ],
        },
    ).raise_for_status().json()["ids"]
    q_tcp, q_acid, q_subj = ids

    stored = {q["id"]: q for q in admin.get("/api/questions").json()}
    assert stored[q_tcp]["correct_option"] == 1
    assert stored[q_acid]["correct_option"] == 0
    assert stored[q_subj]["correct_option"] is None

    # Missing/unmatched MCQ answer is rejected
    assert (
        admin.post(
            "/api/questions",
            json={
                "type": "mcq",
                "text": "Bad answer?",
                "options": ["Yes", "No"],
                "answer": "Maybe",
            },
        ).status_code
        == 422
    )

    sid = begin(student)["id"]
    student.put(
        f"/api/sessions/{sid}/answers",
        json={"answers": {q_tcp: 1, q_acid: 1, q_subj: "AIMD window"}},
    ).raise_for_status()
    student.post(f"/api/sessions/{sid}/complete").raise_for_status()

    detail = admin.get(f"/api/sessions/{sid}").json()
    assert detail["mcq_score"] == 2
    assert detail["mcq_max"] == 5
    assert detail["mcq_correct"] == 1
    assert detail["mcq_incorrect"] == 1
    assert detail["mcq_unanswered"] == 0
    assert detail["mcq_total"] == 2
    assert detail["subjective_count"] == 1

    export = admin.get("/api/export/results.csv").content.decode("utf-8-sig")
    (row,) = csv.DictReader(io.StringIO(export))
    assert float(row["MCQ Score"]) == 2
    assert float(row["MCQ Max"]) == 5
    assert int(row["MCQ Correct"]) == 1
    assert int(row["MCQ Incorrect"]) == 1
    assert int(row["MCQ Unanswered"]) == 0
