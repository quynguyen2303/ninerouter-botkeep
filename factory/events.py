"""Event log: every agent action appends a timestamped JSON event.

Events are the factory's source of truth. The dashboard, metrics, and audit
trail all read from here. One JSONL file per job: jobs/<id>/events.jsonl
"""
import json
import os
import time
import uuid

JOBS_DIR = os.environ.get(
    "JOBS_DIR",
    os.path.join(os.path.dirname(os.path.dirname(os.path.abspath(__file__))), "jobs"),
)


def _path(job_id):
    return os.path.join(JOBS_DIR, job_id, "events.jsonl")


def emit(job_id, type, actor="orchestrator", data=None):
    """Append an event. Returns the event dict."""
    event = {
        "id": uuid.uuid4().hex[:8],
        "ts": time.time(),
        "job": job_id,
        "type": type,
        "actor": actor,
        "data": data or {},
    }
    os.makedirs(os.path.dirname(_path(job_id)), exist_ok=True)
    with open(_path(job_id), "a") as f:
        f.write(json.dumps(event) + "\n")
    return event


def read(job_id, types=None):
    """Read events for a job, optionally filtered by type prefix."""
    p = _path(job_id)
    if not os.path.exists(p):
        return []
    out = []
    with open(p) as f:
        for line in f:
            line = line.strip()
            if not line:
                continue
            try:
                e = json.loads(line)
            except Exception:
                continue
            if types and not any(e["type"].startswith(t) for t in types):
                continue
            out.append(e)
    return out


def latest(job_id, type):
    """Latest event of a given type, or None."""
    evs = read(job_id, [type])
    return evs[-1] if evs else None


def summary(job_id):
    """Compact status derived purely from events."""
    evs = read(job_id)
    if not evs:
        return {"status": "unknown", "events": 0}
    types = [e["type"] for e in evs]
    if "job.delivered" in types:
        status = "delivered"
    elif "job.failed" in types:
        status = "failed"
    elif any(t.startswith("review.") for t in types):
        status = "in_review"
    elif any(t.startswith("task.") for t in types):
        status = "building"
    elif any(t.startswith("plan.") for t in types):
        status = "planning"
    else:
        status = "created"
    tasks_done = len([t for t in types if t == "task.completed"])
    tasks_total = len([t for t in types if t == "task.created"])
    return {
        "status": status,
        "events": len(evs),
        "tasks_done": tasks_done,
        "tasks_total": tasks_total,
        "started": evs[0]["ts"],
        "updated": evs[-1]["ts"],
    }
