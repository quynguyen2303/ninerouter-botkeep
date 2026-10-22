"""Agent wrappers: each model call emits events before/after.

Roles map to the squad:
  commander -> planner (Llama 3.3 70B)
  vanguard  -> builder (Qwen 2.5 Coder)
  captain   -> reviewer (Gemini Flash)
  scribe    -> writer (Gemini Flash)
"""
import sys
import os

sys.path.insert(0, os.path.join(os.path.dirname(os.path.dirname(os.path.abspath(__file__))), "lib"))
from router import Router  # noqa: E402

from . import events  # noqa: E402

_router = None


def router():
    global _router
    if _router is None:
        _router = Router()
    return _router


def ask(job_id, role, prompt, actor=None, **kw):
    """Call the model for a role, emitting events. Returns text."""
    actor = actor or role
    model = router().config["models"][role]
    events.emit(job_id, "agent.called", actor,
                {"role": role, "model": model, "prompt_chars": len(prompt)})
    try:
        text = router().ask(role, prompt, **kw)
    except Exception as e:
        events.emit(job_id, "agent.error", actor, {"role": role, "error": str(e)[:300]})
        raise
    events.emit(job_id, "agent.replied", actor,
                {"role": role, "model": model, "response_chars": len(text)})
    return text
