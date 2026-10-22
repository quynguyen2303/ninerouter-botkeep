"""Task model: the planner produces a task DAG; workers claim and complete tasks.

Research rule: single-threaded writes. Tasks run sequentially in dependency
order; independent reads may fan out, but only one writer touches files.
"""
import json
import os

from . import events

TASKS_FILE = "tasks.json"


def _path(job_id):
    return os.path.join(events.JOBS_DIR, job_id, TASKS_FILE)


def create(job_id, task_defs):
    """task_defs: [{id, title, kind, files, depends_on, build_prompt}]"""
    tasks = []
    for i, d in enumerate(task_defs):
        tasks.append({
            "id": d.get("id", f"t{i+1}"),
            "title": d.get("title", f"task {i+1}"),
            "kind": d.get("kind", "build"),  # build | verify | review | fix
            "files": d.get("files", []),
            "depends_on": d.get("depends_on", []),
            "build_prompt": d.get("build_prompt", ""),
            "status": "pending",
        })
    with open(_path(job_id), "w") as f:
        json.dump(tasks, f, indent=1)
    for t in tasks:
        events.emit(job_id, "task.created", "commander", {"task": t["id"], "title": t["title"]})
    return tasks


def load(job_id):
    p = _path(job_id)
    return json.load(open(p)) if os.path.exists(p) else []


def save(job_id, tasks):
    with open(_path(job_id), "w") as f:
        json.dump(tasks, f, indent=1)


def ready(job_id):
    """Tasks whose dependencies are complete and which are still pending."""
    tasks = {t["id"]: t for t in load(job_id)}
    out = []
    for t in tasks.values():
        if t["status"] != "pending":
            continue
        if all(tasks[d]["status"] == "done" for d in t["depends_on"] if d in tasks):
            out.append(t)
    return out


def claim(job_id, task_id, actor):
    tasks = load(job_id)
    for t in tasks:
        if t["id"] == task_id:
            t["status"] = "in_progress"
            t["actor"] = actor
    save(job_id, tasks)
    events.emit(job_id, "task.claimed", actor, {"task": task_id})


def complete(job_id, task_id, actor, note=""):
    tasks = load(job_id)
    for t in tasks:
        if t["id"] == task_id:
            t["status"] = "done"
    save(job_id, tasks)
    events.emit(job_id, "task.completed", actor, {"task": task_id, "note": note})


def fail(job_id, task_id, actor, error=""):
    tasks = load(job_id)
    for t in tasks:
        if t["id"] == task_id:
            t["status"] = "failed"
    save(job_id, tasks)
    events.emit(job_id, "task.failed", actor, {"task": task_id, "error": error[:300]})
