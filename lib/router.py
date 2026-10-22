"""9router client for the software factory. Reads the gateway key from the local 9router DB."""
import json, os, sqlite3, time, urllib.request

FACTORY_ROOT = os.environ.get("FACTORY_ROOT", "/home/hatch/workspace/software-factory")
METRICS_PATH = os.environ.get("METRICS_PATH", os.path.join(FACTORY_ROOT, "metrics.jsonl"))
ROUTER_DB = os.environ.get("ROUTER_DB", "/home/hatch/.9router/db/data.sqlite")
ROUTER_KEY = os.environ.get("ROUTER_KEY")  # if set, skip DB lookup
ROUTER_BASE = os.environ.get("ROUTER_BASE")  # if set, override config gateway


def _gateway_key(key_name="software-factory"):
    if ROUTER_KEY:
        return ROUTER_KEY
    conn = sqlite3.connect(f"file:{ROUTER_DB}?mode=ro", uri=True)
    row = conn.execute("SELECT key FROM apiKeys WHERE name=?", (key_name,)).fetchone()
    conn.close()
    if not row:
        raise RuntimeError(f"gateway key '{key_name}' not found")
    return row[0]


def _log_metric(entry):
    try:
        with open(METRICS_PATH, "a") as f:
            f.write(json.dumps(entry) + "\n")
    except Exception:
        pass


class Router:
    def __init__(self, key_name="software-factory", timeout=120):
        with open(os.path.join(FACTORY_ROOT, "config.json")) as f:
            self.config = json.load(f)
        self.base = ROUTER_BASE or self.config["gateway"]
        self.key = _gateway_key(key_name)
        self.timeout = timeout

    def chat(self, model, messages, max_tokens=None, temperature=0.7):
        cfg = self.config
        prompt_text = "\n".join(m.get("content", "") for m in messages)
        body = {
            "model": model,
            "messages": messages,
            "max_tokens": max_tokens or cfg["limits"]["max_tokens_per_call"],
            "temperature": temperature,
        }
        req = urllib.request.Request(
            self.base + "/v1/chat/completions",
            data=json.dumps(body).encode(),
            headers={"Content-Type": "application/json", "Authorization": f"Bearer {self.key}"},
        )
        t0 = time.time()
        raw = urllib.request.urlopen(req, timeout=self.timeout).read().decode()
        dur = round(time.time() - t0, 1)
        if raw.strip().startswith("data:"):
            parts = []
            for line in raw.split("\n"):
                line = line.strip()
                if line.startswith("data:") and "[DONE]" not in line:
                    try:
                        chunk = json.loads(line[5:])
                        parts.append(chunk["choices"][0].get("delta", {}).get("content", ""))
                    except Exception:
                        pass
            text = "".join(parts)
        else:
            text = json.loads(raw.split("data:")[0])["choices"][0]["message"]["content"]
        _log_metric({
            "ts": time.time(), "model": model,
            "prompt_chars": len(prompt_text), "response_chars": len(text),
            "est_tokens": (len(prompt_text) + len(text)) // 4,
            "duration_s": dur,
        })
        return text

    def ask(self, role, prompt, **kw):
        model = self.config["models"][role]
        return self.chat(model, [{"role": "user", "content": prompt}], **kw)
