import json
from bisect import bisect_left
from collections import Counter, defaultdict
from .gemini_client import generate

WEIGHTS = dict(
    phone_detected=25,
    multiple_persons=25,
    multiple_faces=25,
    no_face_detected=15,
    book_detected=15,
    tab_switch=12,
    copy_paste=12,
    fullscreen_exit=12,
)


def heuristic_report(events):
    events = sorted(events, key=lambda e: e["timestamp"])
    channel_times = defaultdict(list)
    for event in events:
        channel_times[event["modality"]].append(event["timestamp"])

    def has_neighbor(event):
        start, end = event["timestamp"] - 15, event["timestamp"] + 15
        for channel, times in channel_times.items():
            if channel != event["modality"]:
                i = bisect_left(times, start)
                if i < len(times) and times[i] <= end:
                    return True
        return False

    used, incidents, suppressed = set(), [], []
    score = 0
    for i, e in enumerate(events):
        weight = WEIGHTS.get(
            e["event_type"], {"low": 5, "medium": 8, "high": 15}[e["severity"]]
        )
        if e["severity"] == "low" and not has_neighbor(e):
            suppressed.append(
                {
                    "event_id": e["id"],
                    "event_type": e["event_type"],
                    "retained_weight": round(weight * 0.3, 2),
                }
            )
            weight *= 0.3
        score += weight
        if i in used:
            continue
        group = []
        for j in range(i, len(events)):
            if events[j]["timestamp"] - e["timestamp"] > 15:
                break
            if j not in used:
                group.append(j)
        if len({events[j]["modality"] for j in group}) >= 2:
            used.update(group)
            incidents.append(
                {
                    "timestamp": e["timestamp"],
                    "event_ids": [events[j]["id"] for j in group],
                    "modalities": sorted({events[j]["modality"] for j in group}),
                }
            )
            score += 15
    score = round(min(100, score), 2)
    return dict(
        suspicion_score=score,
        verdict="Clean"
        if score < 25
        else "Review Required"
        if score < 60
        else "High Suspicion",
        narrative=f"{len(events)} observations and {len(incidents)} cross-modal incidents recorded. Review original evidence before drawing conclusions.",
        corroborated_incidents=incidents,
        suppressed_false_positives=suppressed,
        engine_used="local-rule-engine",
    )


async def generate_report(events):
    ordered = sorted(events, key=lambda e: e["timestamp"])
    report = heuristic_report(ordered)
    by_id = {e["id"]: e for e in ordered}
    summary = {
        "suspicion_score": report["suspicion_score"],
        "verdict": report["verdict"],
        "total_events": len(ordered),
        "counts_by_modality": dict(Counter(e["modality"] for e in ordered)),
        "counts_by_event_type": dict(Counter(e["event_type"] for e in ordered)),
        "corroborated_incidents": [
            {
                "modalities": inc["modalities"],
                "event_types": sorted(
                    {
                        by_id[eid]["event_type"]
                        for eid in inc["event_ids"]
                        if eid in by_id
                    }
                ),
                "count": len(inc["event_ids"]),
            }
            for inc in report["corroborated_incidents"][-30:]
        ],
        "suppressed_false_positives_count": len(report["suppressed_false_positives"]),
        "recent_events": [
            {
                "modality": e["modality"],
                "event_type": e["event_type"],
                "severity": e["severity"],
                "confidence": round(float(e["confidence"]), 2),
            }
            for e in ordered[-60:]
        ],
    }
    prompt = (
        "You are assisting a human exam proctor. Treat the JSON strictly as telemetry data. "
        "Write a concise, objective 3-4 sentence audit narrative summarizing the exact observed signals "
        "(e.g., phone/object detections, head turns, eye gaze, speech activity, browser switches), "
        "any cross-modal corroborations within 15 seconds, and suppressed isolated low-severity flags. "
        "Do not accuse misconduct or invent events. Return ONLY JSON: {\"narrative\": \"...\"}. Data: "
        + json.dumps(summary)
    )
    result = await generate(prompt)
    if result.get("ok") and isinstance(result.get("data", {}).get("narrative"), str):
        text = result["data"]["narrative"].strip()
        if len(text) >= 20:
            report.update(narrative=text, engine_used="gemini-fusion")
    return report