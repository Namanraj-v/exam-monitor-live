"""Check a live proctor account, Gemini health, and a completed session's fusion."""

import argparse
import os
import sys

import httpx
from dotenv import load_dotenv


def main():
    load_dotenv()
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--base-url", default="http://127.0.0.1:7860")
    parser.add_argument(
        "--session-id",
        help="Completed session to analyze; defaults to latest completed session",
    )
    args = parser.parse_args()
    if not all(os.getenv(k) for k in ("ADMIN_USERNAME", "ADMIN_PASSWORD")):
        parser.error("Set ADMIN_USERNAME and ADMIN_PASSWORD to the proctor credentials")
    with httpx.Client(base_url=args.base_url, timeout=80) as client:
        client.post(
            "/api/auth/login",
            json={
                "username": os.environ["ADMIN_USERNAME"],
                "role": "proctor",
                "proctor_pin": os.getenv("PROCTOR_PIN", ""),
                "password": os.environ["ADMIN_PASSWORD"],
            },
        ).raise_for_status()
        health = client.get("/api/health/ai").raise_for_status().json()
        print("AI health:", health)
        sessions = client.get("/api/sessions").raise_for_status().json()
        sid = args.session_id or next(
            (s["id"] for s in sessions if s["status"] == "completed"), None
        )
        if not sid:
            print("Fusion requires one completed session.", file=sys.stderr)
            return 1
        response = client.post(f"/api/sessions/{sid}/fusion").raise_for_status().json()
        print(
            "Fusion:",
            response["engine_used"],
            response["verdict"],
            response["suspicion_score"],
        )
        return int(not health["ok"] or response["engine_used"] != "gemini-fusion")


if __name__ == "__main__":
    raise SystemExit(main())
