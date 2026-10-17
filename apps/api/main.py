"""
apps/api/main.py
-----------------
FastAPI layer for Propus — typed result contract (CLAUDE.md §6/§6a).

Endpoints:
    POST /query/stream   — SSE stream of typed PropusEvent for a live query
    GET  /query/demo      — hardcoded PropusResult[] (B1 round-trip proof,
                             no DB/LLM required)
    GET  /health          — health check

The frontend never renders from raw SQL or raw agent text: every response
is a typed PropusResult, produced by apps/api/formatters.py from the
existing ADK agent's tool outputs (apps/api/agent.py).

Usage:
    uvicorn apps.api.main:app --host 0.0.0.0 --port 8000 --reload
"""

from __future__ import annotations

import json
import logging
import os
import time
import uuid
from contextlib import aclosing, asynccontextmanager
from pathlib import Path

from dotenv import load_dotenv
from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware
from fastapi.middleware.gzip import GZipMiddleware
from fastapi.responses import StreamingResponse
from pydantic import BaseModel, Field, field_validator

load_dotenv(Path(__file__).resolve().parents[2] / ".env")

logging.basicConfig(level=logging.INFO, format="%(asctime)s [%(levelname)s] %(message)s")
log = logging.getLogger(__name__)

# Import style must work whether this module is loaded as part of the
# `apps.api` package (local dev: `uvicorn apps.api.main:app` from repo
# root — see docs/RUNNING.md) or as a top-level module (some hosts start
# `uvicorn main:app` from inside apps/api/). Try relative first, fall back
# to absolute — do this for every same-package import in this file.
try:
    from .formatters import METHODOLOGY, format_refusal, format_tool_response
    from .querylog import record as log_query
    from .schemas import (
        BarChartResult,
        BarSeriesPoint,
        DataTableResult,
        DoneEvent,
        ErrorEvent,
        PlanEvent,
        ReasoningStepEvent,
        ResultEvent,
        StatCard,
        StatCardsResult,
    )
except ImportError:
    from formatters import METHODOLOGY, format_refusal, format_tool_response
    from querylog import record as log_query
    from schemas import (
        BarChartResult,
        BarSeriesPoint,
        DataTableResult,
        DoneEvent,
        ErrorEvent,
        PlanEvent,
        ReasoningStepEvent,
        ResultEvent,
        StatCard,
        StatCardsResult,
    )

DATABASE_URL = os.environ.get("AGENT_DATABASE_URL") or os.environ.get("DATABASE_URL", "")
_runners: dict[str, tuple] = {}  # tier -> (runner, model_name)


def get_runner(tier: str = "advanced"):
    """One cached runner per tier: 'simple' → open-source via Groq,
    'advanced' → Gemini (see agent.MODEL_CHAIN / SIMPLE_MODEL_CHAIN)."""
    if tier not in _runners:
        try:
            try:
                from .agent import create_runner, pick_model
            except ImportError:
                from agent import create_runner, pick_model
            model = pick_model(tier)
            _runners[tier] = (create_runner(model=model, tier=tier), model)
            log.info(f"Agent initialized — tier={tier} model={model}")
        except Exception as e:
            log.error(f"Failed to initialize agent (tier={tier}): {e}")
            return None, None
    return _runners[tier]


@asynccontextmanager
async def lifespan(app: FastAPI):
    log.info("Propus API starting up...")
    yield
    log.info("Propus API shutting down.")


# Comma-separated list of allowed web origins, set at deploy time to the web
# service URL. Unset (local dev) falls back to "*".
_CORS_ORIGINS = [o.strip() for o in os.environ.get("CORS_ORIGINS", "").split(",") if o.strip()] or ["*"]

app = FastAPI(
    title="Propus Delhi Transit Intelligence API",
    version="2.0.0",
    description="Typed-result agent API over Delhi GTFS + PostGIS data (CLAUDE.md §6)",
    lifespan=lifespan,
)

app.add_middleware(GZipMiddleware, minimum_size=1024)
app.add_middleware(
    CORSMiddleware,
    allow_origins=_CORS_ORIGINS,
    allow_methods=["*"],
    allow_headers=["*"],
)


_ID_PATTERN = r"^[A-Za-z0-9_.:-]+$"


class QueryRequest(BaseModel):
    # Bounds keep a bad or hostile request from reaching the model: an empty
    # question, a 1 MB paste, or an id that is really a payload.
    message: str = Field(..., min_length=1, max_length=500, description="User's natural language question")
    session_id: str = Field(default_factory=lambda: str(uuid.uuid4()), min_length=1, max_length=64, pattern=_ID_PATTERN)
    user_id: str = Field(default="web_user", min_length=1, max_length=64, pattern=_ID_PATTERN)

    @field_validator("message")
    @classmethod
    def _message_not_blank(cls, v: str) -> str:
        v = v.strip()
        if not v:
            raise ValueError("message must not be blank")
        return v


@app.get("/health")
async def health():
    return {
        "status": "ok",
        "service": "propus-api",
        "database": "configured" if DATABASE_URL else "not configured",
        "version": "2.0.0",
    }


# ---------------------------------------------------------------------------
# B1 round-trip proof — hardcoded, no DB/LLM dependency
# ---------------------------------------------------------------------------

@app.get("/query/demo")
async def query_demo():
    """A hardcoded data_table PropusResult — proves the contract round-trips
    API → frontend without needing a live DB or LLM (TASKS.md B1 DoD)."""
    result = DataTableResult(
        columns=["Ward", "Bus Stops", "Transit Score"],
        rows=[
            ["SANGAM VIHAR", 0, 0.0],
            ["TIGRI", 0, 0.0],
            ["KASHMERE GATE", 110, 0.6842],
        ],
        evidence="Observed",
        alertRows=[0, 1],
        rowIds=["ward_sangam_vihar", "ward_tigri", "ward_kashmere_gate"],
    )
    return {"kind": result.kind, "result": result.model_dump(mode="json")}


# ---------------------------------------------------------------------------
# Typed SSE stream
# ---------------------------------------------------------------------------

# Analysis tools that answer a question by themselves. The model's closing prose
# is never shown (only refusals use it), so once every tool called so far is one
# of these and its results are in, the second model call is skipped. Lookup tools
# (geocode_*, get_ward_rs_profile, reverse_geocode, ...) may need a follow-up tool
# call, so a turn that used one still runs to completion.
_SELF_CONTAINED_TOOLS = frozenset({
    "find_underserved_areas", "get_ward_density_ranking", "get_pop_walk_access",
    "coverage_gap", "stop_heat_exposure", "compare_transit_access",
    "get_metro_catchment", "simulate_network_change",
})


def _sse(event: BaseModel) -> str:
    return f"data: {json.dumps(event.model_dump(mode='json'))}\n\n"


async def _stream_query(message: str, session_id: str, user_id: str, mode: str):
    start = time.monotonic()
    query_id = str(uuid.uuid4())

    try:
        from .agent import classify_complexity, _is_rate_limit
    except ImportError:
        from agent import classify_complexity, _is_rate_limit

    tier = classify_complexity(message)
    runner, model_used = get_runner(tier)
    if runner is None:
        yield _sse(ErrorEvent(message="Propus is not available right now. Please try again shortly.", recoverable=False))
        return

    yield _sse(ReasoningStepEvent(step="Analysing your question..."))

    accumulated: list[tuple] = []  # (PropusResult, methodology|None)
    final_text: list[str] = []  # the model's last text turn (used only for refusals)
    tools_called: list[str] = []  # for the Firestore query log
    marks: list[tuple[str, int]] = []  # (stage, ms since request start), logged once per request

    def _mark(stage: str) -> None:
        marks.append((stage, int((time.monotonic() - start) * 1000)))

    async def _run_agent(active_runner):
        """Stream the agent loop, appending formatted results to `accumulated`
        and yielding reasoning-step SSE frames."""
        try:
            from .agent import run_query_events
        except ImportError:
            from agent import run_query_events

        _mark("agent_start")
        async with aclosing(run_query_events(message, session_id, user_id, active_runner)) as events:
            async for event in events:
                if event.is_final_response() and event.content and event.content.parts:
                    final_text[:] = [event.content.parts[0].text or ""]
                    _mark("final_text")
                for call in event.get_function_calls():
                    tools_called.append(call.name)
                    _mark(f"call:{call.name}")
                    yield _sse(ReasoningStepEvent(step=f"Calling {call.name}..."))

                for resp in event.get_function_responses():
                    tool_name = resp.name
                    _mark(f"resp:{tool_name}")
                    tool_response = resp.response
                    args = getattr(resp, "args", None) or {}
                    try:
                        results = format_tool_response(tool_name, tool_response, args)
                    except Exception as fmt_exc:
                        log.error(f"Formatter error for {tool_name}: {fmt_exc}", exc_info=True)
                        results = [StatCardsResult(cards=[
                            StatCard(label="Could not display this result", value="Something went wrong building this result. Try the question again.",
                                     evidence="Calculated", alert=True)
                        ])]
                    methodology = METHODOLOGY.get(tool_name)
                    for r in results:
                        accumulated.append((r, methodology))
                    yield _sse(ReasoningStepEvent(step=f"{tool_name} → {len(results)} result(s)"))
                responses = event.get_function_responses()
                failed = any(isinstance(r.response, dict) and "error" in r.response for r in responses)
                # A failed tool call keeps the second turn: the model may recover.
                if accumulated and responses and not failed and all(t in _SELF_CONTAINED_TOOLS for t in tools_called):
                    _mark("early_stop")
                    return

    async def _run_advanced_with_fallback(skip_model: str | None = None):
        """Walk agent.MODEL_CHAIN, only moving to the next model on a
        retriable error (429/quota/503/UNAVAILABLE/overloaded — see
        agent._is_rate_limit). A real bug in the query still surfaces
        immediately instead of being masked by five silent retries.
        `skip_model` avoids re-trying a model that was already attempted
        and just failed (e.g. the initial advanced-tier runner)."""
        try:
            from .agent import MODEL_CHAIN, create_runner
        except ImportError:
            from agent import MODEL_CHAIN, create_runner

        nonlocal model_used
        last_exc = None
        for model in MODEL_CHAIN:
            if model == skip_model:
                continue
            try:
                fallback_runner = create_runner(model=model, tier="advanced")
                async for frame in _run_agent(fallback_runner):
                    yield frame
                model_used = model
                _runners["advanced"] = (fallback_runner, model)  # cache the model that worked
                return
            except Exception as exc:
                last_exc = exc
                if accumulated or not _is_rate_limit(exc):
                    raise
                log.warning(f"{model} unavailable ({exc}) — trying next model in chain")
                yield _sse(ReasoningStepEvent(step=f"{model} unavailable, trying next model..."))
        raise last_exc

    try:
        try:
            async for frame in _run_agent(runner):
                yield frame
        except Exception as oss_exc:
            if accumulated:
                # Typed results are already computed from real tool calls —
                # a failed summary turn must never discard them.
                log.warning(f"Model failed after results were computed ({oss_exc}) — shipping results")
            elif tier == "simple":
                # An open-source-tier failure must not kill the query:
                # escalate to the Gemini chain (with its own fallback).
                log.warning(f"Simple-tier model failed ({oss_exc}) — escalating to Gemini")
                yield _sse(ReasoningStepEvent(step="Escalating to a larger model..."))
                async for frame in _run_advanced_with_fallback():
                    yield frame
            elif _is_rate_limit(oss_exc):
                # Initial advanced-tier attempt hit a retriable error —
                # walk the rest of the Gemini chain instead of failing.
                log.warning(f"{model_used} unavailable ({oss_exc}) — trying next model in chain")
                async for frame in _run_advanced_with_fallback(skip_model=model_used):
                    yield frame
            else:
                raise

        if not accumulated:
            for r in format_refusal(final_text[0] if final_text else None):
                accumulated.append((r, None))

        yield _sse(PlanEvent(kinds=[r.kind for r, _ in accumulated]))
        for i, (result, methodology) in enumerate(accumulated):
            yield _sse(ResultEvent(index=i, payload=result, methodology=methodology))

        ms = int((time.monotonic() - start) * 1000)
        # One line per request so slow ones can be read stage by stage in Cloud Logging.
        log.info("perf %s", json.dumps({"query_id": query_id, "tier": tier, "model": model_used,
                                        "total_ms": ms, "stages": marks}))
        log_query(query_id=query_id, question=message, tools=tools_called,
                  result_kinds=[r.kind for r, _ in accumulated],
                  outcome="results" if tools_called else "refusal",
                  ms=ms, mode=mode, model=model_used)
        yield _sse(DoneEvent(query_id=query_id, ms=ms, mode=mode, model=model_used))

    except Exception as exc:
        log.error(f"Query stream error: {exc}", exc_info=True)
        log_query(query_id=query_id, question=message, tools=tools_called, result_kinds=[],
                  outcome="error", ms=int((time.monotonic() - start) * 1000), mode=mode, model=model_used)
        yield _sse(ErrorEvent(message="Propus could not finish this analysis. Please try again.", recoverable=True))


@app.post("/query/stream")
async def query_stream(req: QueryRequest):
    return StreamingResponse(
        _stream_query(req.message, req.session_id, req.user_id, mode="live"),
        media_type="text/event-stream",
        headers={"Cache-Control": "no-cache", "X-Accel-Buffering": "no"},
    )
