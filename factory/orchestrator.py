#!/usr/bin/env python3
"""Attack on Software v2 — event-sourced orchestrator.

Usage:
    python3 -m factory.orchestrator new "Job name" --spec spec.md [--auto-approve]
    python3 -m factory.orchestrator run <job-id> [--auto-approve]
    python3 -m factory.orchestrator status <job-id>
    python3 -m factory.orchestrator events <job-id> [--type prefix]

Pipeline: intake -> plan -> [human gate: plan approval] -> tasks -> build ->
verify -> review -> (fix loop) -> deliver. Every step emits events; every
agent step commits to the job's git branch.
"""
import json
import os
import re
import shutil
import subprocess
import sys
import uuid

from . import agents, events, gitops, tasks

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
gitops.REPO = ROOT


def _job_path(job_id):
    return os.path.join(events.JOBS_DIR, job_id)


def cmd_new(name, spec_path, auto_approve=False):
    job_id = uuid.uuid4().hex[:8]
    jd = _job_path(job_id)
    os.makedirs(os.path.join(jd, "src"), exist_ok=True)
    shutil.copy(spec_path, os.path.join(jd, "spec.md"))
    events.emit(job_id, "job.created", "human", {"name": name})
    print(f"Job {job_id} created: {name}")
    return job_id


def cmd_status(job_id):
    print(json.dumps(events.summary(job_id), indent=1))


def cmd_events(job_id, type_prefix=None):
    for e in events.read(job_id, [type_prefix] if type_prefix else None):
        import datetime
        ts = datetime.datetime.fromtimestamp(e["ts"]).strftime("%H:%M:%S")
        print(f"{ts} [{e['actor']}] {e['type']} {json.dumps(e['data'])[:120]}")


def stage_plan(job_id):
    spec = open(os.path.join(_job_path(job_id), "spec.md")).read()
    events.emit(job_id, "plan.started", "commander", {})
    prompt = (
        "You are a software architect. Given this spec, produce a task list as a JSON array. "
        "Each item: {\"id\": \"t1\", \"title\": \"...\", \"kind\": \"build\", "
        "\"files\": [\"relative/path\"], \"depends_on\": [], "
        "\"build_prompt\": \"detailed prompt for the coder\"}. "
        "Keep it to 1-6 tasks, order them so dependencies come first. "
        "Reply with ONLY the JSON array.\n\nSPEC:\n" + spec
    )
    raw = agents.ask(job_id, "planner", prompt, actor="commander", temperature=0.3)
    m = re.search(r"\[.*\]", raw, re.S)
    defs = json.loads(m.group(0)) if m else []
    tasks.create(job_id, defs)
    events.emit(job_id, "plan.proposed", "commander", {"tasks": len(defs)})
    gitops.commit(job_id, f"plan: {len(defs)} tasks", actor="commander")
    return defs


def gate_plan_approval(job_id, auto_approve):
    """Human gate: plan must be approved before building."""
    if auto_approve:
        events.emit(job_id, "plan.approved", "human", {"mode": "auto"})
        return True
    defs = tasks.load(job_id)
    print("\n=== PLAN PROPOSAL ===")
    for t in defs:
        print(f"  {t['id']}: {t['title']} -> {', '.join(t['files'])}")
    ans = input("Approve plan? [y/N] ").strip().lower()
    ok = ans == "y"
    events.emit(job_id, "plan.approved" if ok else "plan.rejected", "human", {})
    return ok


def stage_build(job_id):
    jd = _job_path(job_id)
    while True:
        ready = tasks.ready(job_id)
        if not ready:
            break
        t = ready[0]  # single-threaded writes: one task at a time
        tasks.claim(job_id, t["id"], "vanguard")
        try:
            code = agents.ask(
                job_id, "builder",
                t["build_prompt"] + "\n\nReply with ONLY the file contents, no markdown fences, no explanation.",
                actor="vanguard", temperature=0.2)
            code = re.sub(r"^```\w*\n?", "", code.strip())
            code = re.sub(r"\n?```$", "", code.strip())
            for rel in t["files"] or ["output.txt"]:
                rel = rel[4:] if rel.startswith("src/") else rel
                p = os.path.join(jd, "src", rel)
                os.makedirs(os.path.dirname(p), exist_ok=True)
                with open(p, "w") as f:
                    f.write(code + "\n")
                events.emit(job_id, "file.written", "vanguard",
                            {"file": rel, "chars": len(code), "task": t["id"]})
            tasks.complete(job_id, t["id"], "vanguard")
            gitops.commit(job_id, f"build: {t['title']}", actor="vanguard")
        except Exception as e:
            tasks.fail(job_id, t["id"], "vanguard", str(e))
            events.emit(job_id, "job.failed", "orchestrator", {"stage": "build", "error": str(e)[:200]})
            return False
    return True


def stage_verify(job_id):
    jd = _job_path(job_id)
    events.emit(job_id, "verify.started", "orchestrator", {})
    import shutil as _sh
    node = _sh.which("node")
    ok_all = True
    for root, _, files in os.walk(os.path.join(jd, "src")):
        for fn in files:
            p = os.path.join(root, fn)
            rel = os.path.relpath(p, jd)
            if fn.endswith(".py"):
                r = subprocess.run([sys.executable, "-m", "py_compile", p],
                                   capture_output=True, text=True, timeout=30)
            elif fn.endswith(".js") and node:
                r = subprocess.run([node, "--check", p],
                                   capture_output=True, text=True, timeout=30)
            else:
                continue
            ok = r.returncode == 0
            ok_all = ok_all and ok
            events.emit(job_id, "verify." + ("passed" if ok else "failed"),
                        "orchestrator", {"file": rel, "error": r.stderr.strip()[:200]})
    gitops.commit(job_id, "verify", actor="orchestrator")
    return ok_all


def _bundle(job_id):
    jd = _job_path(job_id)
    parts = []
    for root, _, files in os.walk(os.path.join(jd, "src")):
        for fn in sorted(files):
            if not fn.endswith((".py", ".js", ".html", ".css", ".md", ".txt", ".json")):
                continue
            p = os.path.join(root, fn)
            try:
                parts.append(f"--- {os.path.relpath(p, jd)} ---\n" + open(p).read())
            except UnicodeDecodeError:
                continue
    return "\n".join(parts)


def stage_review(job_id):
    spec = open(os.path.join(_job_path(job_id), "spec.md")).read()
    events.emit(job_id, "review.requested", "orchestrator", {})
    review = agents.ask(
        job_id, "reviewer",
        "You are a senior code reviewer. Spec:\n" + spec +
        "\n\nCode:\n" + _bundle(job_id) +
        "\n\nGive a short review: 1) does it meet the spec, 2) bugs found, "
        "3) one-line verdict PASS/FAIL.",
        actor="captain", temperature=0.3)
    verdict = "FAIL" if "FAIL" in review.upper().split("VERDICT")[-1][:80] else "PASS"
    events.emit(job_id, "review.verdict", "captain",
                {"verdict": verdict, "review": review[:2000]})
    with open(os.path.join(_job_path(job_id), "review.md"), "w") as f:
        f.write(review)
    gitops.commit(job_id, f"review: {verdict}", actor="captain")
    return verdict, review


def stage_fix(job_id, review):
    events.emit(job_id, "fix.started", "vanguard", {})
    prompt = (
        "Fix this codebase per the review. Rewrite EACH file completely. "
        "Reply in this exact format per file:\n### FILE: <relative/path>\n<contents>\n### END FILE\n\n"
        "REVIEW:\n" + review + "\n\nCODE:\n" + _bundle(job_id))
    out = agents.ask(job_id, "builder", prompt, actor="vanguard",
                     temperature=0.2, max_tokens=4000)
    jd = _job_path(job_id)
    n = 0
    for m in re.finditer(r"### FILE:\s*(\S+)\s*\n(.*?)### END FILE", out, re.S):
        rel, code = m.group(1), m.group(2)
        rel = rel[4:] if rel.startswith("src/") else rel
        code = re.sub(r"^```\w*\n?", "", code.strip())
        code = re.sub(r"\n?```$", "", code.strip())
        p = os.path.join(jd, "src", rel)
        os.makedirs(os.path.dirname(p), exist_ok=True)
        with open(p, "w") as f:
            f.write(code + "\n")
        events.emit(job_id, "file.written", "vanguard", {"file": rel, "fix": True})
        n += 1
    events.emit(job_id, "fix.completed", "vanguard", {"files": n})
    gitops.commit(job_id, "fix: review feedback applied", actor="vanguard")


def cmd_run(job_id, auto_approve=False):
    gitops.branch(job_id)
    events.emit(job_id, "job.started", "orchestrator", {})
    defs = stage_plan(job_id)
    if not defs:
        events.emit(job_id, "job.failed", "orchestrator", {"stage": "plan"})
        return
    if not gate_plan_approval(job_id, auto_approve):
        print("Plan rejected. Job paused.")
        return
    if not stage_build(job_id):
        print("Build failed.")
        return
    stage_verify(job_id)
    verdict, review = stage_review(job_id)
    if verdict == "FAIL":
        stage_fix(job_id, review)
        stage_verify(job_id)
        verdict, _ = stage_review(job_id)
    events.emit(job_id, "job.delivered", "orchestrator", {"review": verdict})
    gitops.commit(job_id, f"deliver: {verdict}", actor="orchestrator")
    print(f"\nDelivered with review verdict: {verdict}")


def main():
    if len(sys.argv) < 3 and not (len(sys.argv) == 2):
        print(__doc__)
        sys.exit(1)
    c = sys.argv[1]
    auto = "--auto-approve" in sys.argv
    if c == "new":
        name = sys.argv[2]
        spec_path = sys.argv[sys.argv.index("--spec") + 1]
        cmd_new(name, spec_path, auto)
    elif c == "run":
        cmd_run(sys.argv[2], auto)
    elif c == "status":
        cmd_status(sys.argv[2])
    elif c == "events":
        tp = sys.argv[3] if len(sys.argv) > 3 and not sys.argv[3].startswith("--") else None
        cmd_events(sys.argv[2], tp)
    else:
        print(__doc__)


if __name__ == "__main__":
    main()
