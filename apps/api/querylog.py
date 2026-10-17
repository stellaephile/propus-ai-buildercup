"""
apps/api/querylog.py
--------------------
Best-effort Firestore query log (TASKS S7). One document per answered question:
timestamp, question text (truncated), tools called, result kinds, outcome,
latency, mode and model. No user id, session id or IP is stored.

Off unless QUERY_LOG_COLLECTION is set (the Cloud Run deploy sets it), so local
runs and tests never touch Firestore. A failed write is logged and dropped: the
log must never slow down or break an answer, so writes run on a background
thread.
"""

from __future__ import annotations

import datetime
import logging
import os
from concurrent.futures import ThreadPoolExecutor

log = logging.getLogger("propus.querylog")

_pool = ThreadPoolExecutor(max_workers=1, thread_name_prefix="querylog")
_client = None


def _write(collection: str, doc: dict) -> None:
    global _client
    try:
        if _client is None:
            from google.cloud import firestore

            _client = firestore.Client()
        _client.collection(collection).add(doc)
    except Exception as exc:  # noqa: BLE001 - logging must never raise
        log.warning("query log write failed: %s", exc)


def record(
    *,
    query_id: str,
    question: str,
    tools: list[str],
    result_kinds: list[str],
    outcome: str,
    ms: int,
    mode: str,
    model: str | None,
) -> None:
    collection = os.environ.get("QUERY_LOG_COLLECTION")
    if not collection:
        return
    doc = {
        "ts": datetime.datetime.now(datetime.timezone.utc),
        "query_id": query_id,
        "question": question[:500],
        "tools": tools,
        "result_kinds": result_kinds,
        "outcome": outcome,  # "results" | "refusal" | "error"
        "ms": ms,
        "mode": mode,
        "model": model,
    }
    _pool.submit(_write, collection, doc)
