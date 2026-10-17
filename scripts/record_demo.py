"""Record the sustainability demo answers from a running Propus API.

Each answer is the real /query/stream output, stored verbatim as a fixture that
demo mode and the live-failure fallback replay. Nothing is typed by hand: to
change a recorded number, re-run this against the live API.

    python scripts/record_demo.py <api-base-url>

The URL is an argument so it never lands in the repo.
"""

import datetime
import json
import pathlib
import sys
import urllib.request

OUT = pathlib.Path(__file__).resolve().parents[1] / "apps/web/lib/demo/recorded"

QUESTIONS = {
    "heat": "Which busy stops are on the hottest surfaces in Delhi?",
    "coverage_gap": "Where do people live far from any bus stop or metro station?",
    "refusal": "What is the air quality in Dwarka?",
}


def record(api: str, question: str) -> dict:
    req = urllib.request.Request(
        f"{api.rstrip('/')}/query/stream",
        data=json.dumps({"message": question}).encode(),
        headers={"Content-Type": "application/json"},
    )
    steps, results, done = [], [], None
    with urllib.request.urlopen(req, timeout=120) as resp:
        for frame in resp.read().decode().split("\n\n"):
            line = next((l for l in frame.split("\n") if l.startswith("data:")), None)
            if not line:
                continue
            ev = json.loads(line[5:].strip())
            if ev["event"] == "reasoning_step":
                steps.append(ev["step"])
            elif ev["event"] == "result":
                results.append({"payload": ev["payload"], "methodology": ev.get("methodology")})
            elif ev["event"] == "error":
                raise SystemExit(f"live agent returned an error for {question!r}: {ev['message']}")
            elif ev["event"] == "done":
                done = ev
    if not results or done is None:
        raise SystemExit(f"incomplete stream for {question!r}")
    return {
        "question": question,
        "recordedAt": datetime.datetime.now(datetime.timezone.utc).date().isoformat(),
        "steps": steps,
        "results": results,
    }


if __name__ == "__main__":
    if len(sys.argv) != 2:
        raise SystemExit(__doc__)
    OUT.mkdir(parents=True, exist_ok=True)
    for slug, question in QUESTIONS.items():
        data = record(sys.argv[1], question)
        (OUT / f"{slug}.json").write_text(json.dumps(data, indent=2, ensure_ascii=False) + "\n")
        kinds = [r["payload"]["kind"] for r in data["results"]]
        print(f"{slug}: {len(data['steps'])} steps, results {kinds}")
