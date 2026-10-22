"""Git ops: one branch per job, one commit per agent step.

The repo is the factory's long-term memory: every plan, file, fix, and
verdict is a commit on the job's branch. Merge to main on delivery.
"""
import subprocess

from . import events

REPO = None  # set by orchestrator to the factory repo path


def _run(args, cwd, check=True):
    import os
    env = dict(os.environ,
               GIT_COMMITTER_NAME="factory",
               GIT_COMMITTER_EMAIL="factory@attack-on-software")
    return subprocess.run(
        ["git"] + args, cwd=cwd, capture_output=True, text=True,
        timeout=60, check=check, env=env,
    )


def branch(job_id):
    name = f"job/{job_id}"
    _run(["checkout", "-b", name], cwd=REPO, check=False)
    _run(["checkout", name], cwd=REPO, check=False)
    events.emit(job_id, "git.branch", "orchestrator", {"branch": name})
    return name


def commit(job_id, message, actor="orchestrator"):
    import os
    _run(["add", "-f", "factory", f"jobs/{job_id}"], cwd=REPO, check=False)
    r = _run(["commit", "-m", message,
              "--author", f"{actor} <factory@attack-on-software>"],
             cwd=REPO, check=False)
    if r.returncode == 0:
        sha = _run(["rev-parse", "--short", "HEAD"], cwd=REPO).stdout.strip()
        events.emit(job_id, "git.commit", actor, {"sha": sha, "message": message})
        return sha
    return None


def job_path(job_id):
    import os
    return os.path.join(REPO, "runs", job_id)
