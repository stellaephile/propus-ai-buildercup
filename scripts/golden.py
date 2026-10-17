"""Golden question set: run it against a Propus API and report pass/fail and latency.

    python scripts/golden.py <api-base-url> [--budget-ms N]

Per question it checks:
  - the stream ends with `done` and has no `error` event
  - the tools called, in order, are exactly the expected ones
  - the expected result kinds are all present
  - total time (`done.ms`) is within the budget
  - a refusal returns the "Not available" card and contains no number

What it cannot check: the model's prose never reaches the client (only typed
results do), so "every number in the prose appears in the tool output" holds by
construction for the formatter cards and is checked directly only for refusals.

Exit status is 0 only if every question passes. The URL is an argument so it
never lands in the repo.
"""

import json
import pathlib
import re
import sys
import urllib.request

GOLDEN = pathlib.Path(__file__).resolve().parents[1] / "fixtures/golden.json"


def run(api: str, question: str) -> dict:
    req = urllib.request.Request(
        f"{api.rstrip('/')}/query/stream",
        data=json.dumps({"message": question}).encode(),
        headers={"Content-Type": "application/json"},
    )
    try:
        body = urllib.request.urlopen(req, timeout=120).read().decode()
    except Exception as exc:  # noqa: BLE001 - any transport failure is a failed question
        return {"transport_error": type(exc).__name__}
    events = [
        json.loads(line[5:])
        for frame in body.split("\n\n")
        for line in frame.split("\n")
        if line.startswith("data:")
    ]
    steps = [e["step"] for e in events if e["event"] == "reasoning_step"]
    calls = [m.group(1) for s in steps for m in [re.match(r"Calling (\w+)", s)] if m]
    tools = [t for i, t in enumerate(calls) if i == 0 or t != calls[i - 1]]  # drop immediate retries
    results = [e["payload"] for e in events if e["event"] == "result"]
    return {
        "tools": tools,
        "kinds": [r["kind"] for r in results],
        "results": results,
        "error": next((e["message"] for e in events if e["event"] == "error"), None),
        "done": next((e for e in events if e["event"] == "done"), None),
    }


def check(q: dict, r: dict, budget_ms: int) -> list[str]:
    if "transport_error" in r:
        return [f"request failed ({r['transport_error']})"]
    problems = []
    if r["error"]:
        problems.append(f"error event: {r['error']}")
    if not r["done"]:
        problems.append("no done event")
    if r["tools"] != q["tools"]:
        problems.append(f"tools {r['tools']} != {q['tools']}")
    missing = [k for k in q["kinds"] if k not in r["kinds"]]
    if missing:
        problems.append(f"missing result kinds {missing}")
    if r["done"] and r["done"]["ms"] > budget_ms:
        problems.append(f"{r['done']['ms']} ms > {budget_ms} ms budget")
    if q.get("refusal"):
        card = (r["results"][0]["cards"][0] if r["results"] else {})
        if card.get("label") != "Not available in Propus data":
            problems.append("refusal card missing")
        if re.search(r"\d", str(card.get("value", ""))):
            problems.append("refusal contains a number")
    return problems


def main() -> int:
    args = sys.argv[1:]
    if not args or args[0].startswith("-"):
        print(__doc__)
        return 2
    api = args[0]
    spec = json.loads(GOLDEN.read_text())
    budget = int(args[args.index("--budget-ms") + 1]) if "--budget-ms" in args else spec["time_budget_ms"]
    rows, failed = [], 0
    for q in spec["questions"]:
        r = run(api, q["question"])
        problems = check(q, r, budget)
        failed += bool(problems)
        ms = r["done"]["ms"] if r.get("done") else None
        rows.append((q["id"], "PASS" if not problems else "FAIL", ms, "; ".join(problems)))
    print("| Question | Result | Time (ms) | Notes |\n|---|---|---|---|")
    for qid, res, ms, note in rows:
        print(f"| {qid} | {res} | {ms if ms is not None else '-'} | {note} |")
    print(f"\n{len(rows) - failed}/{len(rows)} passed (time budget {budget} ms)")
    return 1 if failed else 0


if __name__ == "__main__":
    sys.exit(main())
