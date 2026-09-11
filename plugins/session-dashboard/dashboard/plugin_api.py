"""Session Dashboard plugin — backend API routes.

Mounted at /api/plugins/session-dashboard/ by the dashboard plugin system.

Read-only analytics over the Hermes session store (state.db): per-session
token/cache/cost aggregates, tool-call breakdowns, and file-change
derivation from tool-call arguments.

All queries are read-only. No writes, no state mutation.
"""

from __future__ import annotations

import json
import logging
import os
import sqlite3
from pathlib import Path
from typing import Any, Optional

from fastapi import APIRouter, HTTPException, Query

logger = logging.getLogger(__name__)

router = APIRouter()

# Tool names whose `path`/`file_path` argument records a file touched.
FILE_TOOLS = {"write_file", "patch", "read_file", "search_files"}
WRITE_TOOLS = {"write_file", "patch"}
# Tools that produce artifacts saved to disk (output path in args or result).
ARTIFACT_TOOLS = {"image_generate", "text_to_speech"}


def _trim_error(s: str, n: int = 120, ellipsis: str = "…") -> str:
    s = str(s).strip()
    return s if len(s) <= n else s[: n - 1] + ellipsis


def _failure_detail(tool_name: str, content: Any) -> str:
    """Best-effort 'what actually went wrong' from a failed tool result.

    Structured error first (terminal BLOCKED/timed-out, patch write
    denials, memory-limit errors), else the tail of the output — the
    meaningful part (stderr, exit note) sits at the end. The short
    _detect_failure message keeps the row compact; this carries the story.
    """
    if not isinstance(content, str) or not content.strip():
        return ""
    try:
        data = json.loads(content)
    except (json.JSONDecodeError, TypeError):
        data = None
    if isinstance(data, dict):
        err = data.get("error") or data.get("message")
        if isinstance(err, str) and err.strip():
            return _trim_error(err, 700)
        # Batch tools (web_extract, web_search): the per-result error is the
        # failure text; the dict itself has no top-level error.
        results = data.get("results")
        if isinstance(results, list) and results and isinstance(results[0], dict):
            err = results[0].get("error")
            if isinstance(err, str) and err.strip():
                return _trim_error(err, 700)
        out = data.get("output")
        if isinstance(out, str) and out.strip():
            return _trim_error(out, 700, ellipsis="…")
    return _trim_error(content, 700, ellipsis="…")


def _detect_failure(tool_name: str, result: Any) -> tuple[bool, str]:
    """Mirror agent/display.py::_detect_tool_failure (v2.1 semantics).

    Kept local so the plugin doesn't import the whole agent package at
    mount time. Same signals: file mutations that landed are successes,
    terminal exit_code != 0 fails, structured {"error":...} fails, and a
    generic Error/failed heuristic for string results.
    """
    if result is None or not isinstance(result, str):
        return False, ""
    # File mutations: a landed write/patch result is a success even if the
    # text contains the word "error" (e.g. a diff mention).
    if tool_name in WRITE_TOOLS:
        try:
            data = json.loads(result.strip())
        except Exception:
            data = None
        if isinstance(data, dict) and not data.get("error"):
            if tool_name == "write_file" and "bytes_written" in data:
                return False, ""
            if tool_name == "patch" and data.get("success") is True:
                return False, ""
    try:
        data = json.loads(result)
    except Exception:
        data = None

    if tool_name == "terminal":
        if isinstance(data, dict):
            ec = data.get("exit_code")
            if ec is not None and ec != 0:
                err = data.get("error")
                if err:
                    return True, f"[exit {ec}] {_trim_error(err)}"
                return True, f"[exit {ec}]"
        return False, ""

    if isinstance(data, dict):
        err = data.get("error") or data.get("message")
        if err and (data.get("success") is False or "error" in data):
            return True, _trim_error(err)

    lower = result[:500].lower()
    if '"error"' in lower or '"failed"' in lower or result.startswith("Error"):
        return True, "[error]"
    return False, ""


def _state_db_path() -> Path:
    home = os.environ.get("HERMES_HOME") or os.path.expanduser("~/.hermes")
    profile = os.environ.get("HERMES_PROFILE") or ""
    if profile:
        p = Path(home) / "profiles" / profile / "state.db"
    else:
        p = Path(home) / "state.db"
    if not p.exists():
        raise HTTPException(status_code=500, detail=f"state.db not found at {p}")
    return p


def _connect() -> sqlite3.Connection:
    db = _state_db_path()
    conn = sqlite3.connect(f"file:{db}?mode=ro", uri=True, timeout=5)
    conn.row_factory = sqlite3.Row
    return conn


_SESSION_COLS = """
    id, source, model, started_at, ended_at, end_reason,
    message_count, tool_call_count,
    input_tokens, output_tokens, cache_read_tokens, cache_write_tokens,
    reasoning_tokens, estimated_cost_usd, actual_cost_usd, cost_status,
    title, display_name, pinned, archived, parent_session_id, profile_name,
    last_activity_at
"""


def _session_row_to_dict(row: sqlite3.Row) -> dict[str, Any]:
    d = dict(row)
    d["duration_s"] = None
    if d.get("started_at") is not None:
        end = d.get("ended_at") or d.get("last_activity_at") or d.get("started_at")
        if end is not None:
            d["duration_s"] = round(max(0.0, end - d["started_at"]), 1)
    # Cache hit rate: share of prompt tokens served from cache. A low rate on
    # a long session means the context kept churning (retries, model
    # switches, compression resets each re-bill the full prompt).
    d["cache_hit_rate"] = None
    ir = d.get("input_tokens") or 0
    cr = d.get("cache_read_tokens") or 0
    if ir + cr > 0:
        d["cache_hit_rate"] = round(cr / (ir + cr), 4)
    return d


@router.get("/health")
async def health() -> dict:
    return {"ok": True}


@router.get("/sessions")
async def list_sessions(
    limit: int = Query(50, ge=1, le=500),
    offset: int = Query(0, ge=0),
    source: Optional[str] = Query(None),
    q: Optional[str] = Query(None, max_length=200),
    sort: str = Query("recent", pattern="^(recent|failed)$"),
) -> dict:
    """Session list with token/cache/cost aggregates.

    q: substring filter on session title or id (LIKE).
    sort=failed: order by number of failed tool calls (Python-side
    _detect_failure, the same detector the detail view uses) descending,
    and attach a per-session failed_count.
    """
    where, params = "", []
    conds = []
    if source:
        conds.append("source = ?")
        params.append(source)
    if q:
        conds.append("(title LIKE ? OR id LIKE ?)")
        params.append(f"%{q}%")
        params.append(f"%{q}%")
    if conds:
        where = "WHERE " + " AND ".join(conds)
    try:
        conn = _connect()
        if sort == "failed":
            # Failure counts need the Python detector (SQL can't replicate
            # it over non-JSON tool content). Scan once, sort in memory.
            all_rows = conn.execute(
                f"SELECT {_SESSION_COLS} FROM sessions {where}", params
            ).fetchall()
            trows = conn.execute(
                "SELECT session_id, tool_name, content FROM messages "
                "WHERE role = 'tool' AND tool_name IS NOT NULL"
            ).fetchall()
            failed_by_session: dict[str, int] = {}
            for tr in trows:
                failed, _ = _detect_failure(tr["tool_name"] or "", tr["content"])
                if failed:
                    failed_by_session[tr["session_id"]] = (
                        failed_by_session.get(tr["session_id"], 0) + 1
                    )
            all_rows.sort(
                key=lambda r: (
                    failed_by_session.get(r["id"], 0),
                    r["started_at"] or 0,
                ),
                reverse=True,
            )
            total = len(all_rows)
            rows = all_rows[offset : offset + limit]
            dicts = []
            for r in rows:
                d = _session_row_to_dict(r)
                d["failed_count"] = failed_by_session.get(r["id"], 0)
                dicts.append(d)
            conn.close()
            return {"total": total, "sessions": dicts}

        rows = conn.execute(
            f"SELECT {_SESSION_COLS} FROM sessions {where} "
            f"ORDER BY started_at DESC LIMIT ? OFFSET ?",
            [*params, limit, offset],
        ).fetchall()
        total = conn.execute(
            f"SELECT COUNT(*) FROM sessions {where}", params
        ).fetchone()[0]
        conn.close()
    except sqlite3.Error as e:
        logger.exception("session list query failed")
        raise HTTPException(status_code=500, detail=f"query failed: {e}")
    return {
        "total": total,
        "sessions": [_session_row_to_dict(r) for r in rows],
    }


@router.get("/search")
async def search_sessions(
    q: str = Query(..., min_length=1, max_length=200),
    limit: int = Query(25, ge=1, le=100),
) -> dict:
    """Full-text search over message content using the state.db FTS5 index.

    Mirrors hermes_state_search.py::_run_trigram_search: quote each
    non-operator token so FTS5 specials are neutralised, search the
    substring-capable trigram index, and return per-session aggregates
    (count + a snippet from the best match).
    """
    tokens = q.split()
    parts = []
    for tok in tokens:
        if tok.upper() in {"AND", "OR", "NOT"}:
            parts.append(tok)
        else:
            parts.append('"' + tok.replace('"', '""') + '"')
    fts_query = " ".join(parts)

    try:
        conn = _connect()
        # Prefer the trigram index (substring matches); fall back to the
        # standard unicode61 index if trigram is unavailable.
        fts_table = "messages_fts_trigram"
        try:
            conn.execute(f"SELECT 1 FROM {fts_table} LIMIT 0")
        except sqlite3.Error:
            fts_table = "messages_fts"
        # Per-message rows (snippet() is incompatible with GROUP BY), then
        # aggregate to one row per session in Python.
        rows = conn.execute(
            f"""
            SELECT
                s.id AS session_id,
                s.title,
                s.source,
                s.started_at,
                m.timestamp,
                snippet({fts_table}, -1, '>>>', '<<<', '...', 40) AS snippet
            FROM {fts_table}
            JOIN messages m ON m.id = {fts_table}.rowid
            JOIN sessions s ON s.id = m.session_id
            WHERE {fts_table} MATCH ?
            ORDER BY m.timestamp DESC
            LIMIT 500
            """,
            [fts_query],
        ).fetchall()
        conn.close()
    except sqlite3.Error as e:
        logger.exception("session search failed")
        raise HTTPException(status_code=500, detail=f"search failed: {e}")

    # One result per session: newest matching message wins; cap at limit.
    by_session: dict[str, dict[str, Any]] = {}
    for r in rows:
        sid = r["session_id"]
        if sid in by_session:
            continue
        d = dict(r)
        if d.get("started_at") is not None:
            d["started_at"] = round(float(d["started_at"]), 3)
        by_session[sid] = d
        if len(by_session) >= limit:
            break
    return {"query": q, "results": list(by_session.values())}


@router.get("/sessions/{session_id}")
async def session_detail(session_id: str) -> dict:
    """Full per-session view: aggregates, tool calls, files touched."""
    try:
        conn = _connect()
        row = conn.execute(
            f"SELECT {_SESSION_COLS} FROM sessions WHERE id = ?", (session_id,)
        ).fetchone()
        if row is None:
            conn.close()
            raise HTTPException(status_code=404, detail=f"session {session_id} not found")

        s = _session_row_to_dict(row)

        # Tool calls: assistant messages with tool_calls JSON.
        trows = conn.execute(
            "SELECT tool_calls, timestamp FROM messages "
            "WHERE session_id = ? AND role = 'assistant' AND tool_calls IS NOT NULL "
            "ORDER BY timestamp",
            (session_id,),
        ).fetchall()

        # Tool results: role='tool' messages carry tool_name + result content.
        # Detect failures per call id so we can annotate tool calls and
        # aggregate a per-tool failure count. Timestamp + content length ride
        # along: latency is (result_timestamp - call_timestamp) and the chars
        # the result pushed into context are the only honest cost proxy
        # (messages.token_count is NULL throughout state.db).
        rrows = conn.execute(
            "SELECT tool_call_id, tool_name, content, timestamp FROM messages "
            "WHERE session_id = ? AND role = 'tool' AND tool_name IS NOT NULL "
            "ORDER BY timestamp",
            (session_id,),
        ).fetchall()
        result_by_call: dict[str, dict[str, Any]] = {}
        for rr in rrows:
            failed, err = _detect_failure(rr["tool_name"] or "", rr["content"])
            result_by_call[rr["tool_call_id"] or ""] = {
                "name": rr["tool_name"],
                "failed": failed,
                "error": err,
                "ts": rr["timestamp"],
                "chars": len(rr["content"] or ""),
                "detail": _failure_detail(rr["tool_name"] or "", rr["content"])
                if failed
                else "",
            }

        tool_calls: list[dict[str, Any]] = []
        for tr in trows:
            try:
                calls = json.loads(tr["tool_calls"])
            except (json.JSONDecodeError, TypeError):
                continue
            if not isinstance(calls, list):
                continue
            for tc in calls:
                if not isinstance(tc, dict):
                    continue
                fn = tc.get("function") or {}
                name = fn.get("name") or tc.get("name") or "unknown"
                args_raw = fn.get("arguments") or "{}"
                try:
                    args = json.loads(args_raw) if isinstance(args_raw, str) else args_raw
                except (json.JSONDecodeError, TypeError):
                    args = {}
                call_id = tc.get("id", "")
                res = result_by_call.get(call_id)
                tool_calls.append({
                    "name": name,
                    "timestamp": tr["timestamp"],
                    "id": call_id,
                    "args": args if isinstance(args, dict) else {"raw": str(args)},
                    "failed": bool(res and res["failed"]),
                    "error": (res or {}).get("error", ""),
                    "detail": (res or {}).get("detail", ""),
                })

        # Aggregate by tool name.
        by_tool: dict[str, dict[str, Any]] = {}
        files: dict[str, dict[str, Any]] = {}
        failed_calls: list[dict[str, Any]] = []
        for tc in tool_calls:
            agg = by_tool.setdefault(
                tc["name"], {"name": tc["name"], "count": 0, "failed": 0}
            )
            agg["count"] += 1
            if tc["failed"]:
                agg["failed"] += 1
                failed_calls.append({
                    "name": tc["name"],
                    "timestamp": tc["timestamp"],
                    "id": tc["id"],
                    "error": tc["error"],
                    "detail": tc["detail"],
                })
            if tc["name"] in FILE_TOOLS or tc["name"] in WRITE_TOOLS:
                path = (
                    tc["args"].get("path")
                    or tc["args"].get("file_path")
                    or tc["args"].get("workdir")
                )
                if path and isinstance(path, str):
                    f = files.setdefault(path, {
                        "path": path,
                        "touched": 0,
                        "writes": 0,
                        "tools": set(),
                    })
                    f["touched"] += 1
                    f["tools"].add(tc["name"])
                    if tc["name"] in WRITE_TOOLS:
                        f["writes"] += 1
            # Artifact-producing tools: report their output file if provided.
            if tc["name"] in ARTIFACT_TOOLS:
                out = tc["args"].get("output_path") or tc["args"].get("image_url")
                if out and isinstance(out, str) and out.startswith(("/", "~")):
                    f = files.setdefault(out, {
                        "path": out, "touched": 1, "writes": 1, "tools": {tc["name"]},
                    })

        for f in files.values():
            f["tools"] = sorted(f["tools"])
        files_sorted = sorted(files.values(), key=lambda x: -x["writes"])

        # --- Loop fingerprints: calls repeated verbatim inside one session.
        # A tool retried 5× is ONE fix (raise the timeout, stop re-reading the
        # skill, shrink the command), not 5 independent failures — grouping
        # turns a flat failure list into a work item.
        prints: dict[tuple[str, str], dict[str, Any]] = {}
        for tc in tool_calls:
            try:
                canon = json.dumps(tc["args"], sort_keys=True, default=str)[:160]
            except (TypeError, ValueError):
                canon = str(tc["args"])[:160]
            fp = prints.setdefault(
                (tc["name"], canon),
                {
                    "name": tc["name"],
                    "args": canon,
                    "count": 0,
                    "failed": 0,
                },
            )
            fp["count"] += 1
            if tc["failed"]:
                fp["failed"] += 1
        loops = sorted(
            (fp for fp in prints.values() if fp["count"] >= 3),
            key=lambda x: (-x["count"], -x["failed"]),
        )[:20]
        s["loops"] = loops

        # --- Per-tool latency × context bloat: the two costs a tool imposes
        # that token totals hide. Latency joins the call to its result row by
        # call id; result chars /4 estimates what it pushed into context.
        tool_agg: dict[str, dict[str, Any]] = {}
        for tc in tool_calls:
            res = result_by_call.get(tc["id"]) or {}
            st = tool_agg.setdefault(
                tc["name"],
                {"name": tc["name"], "count": 0, "lat": [], "chars": [], "failed": 0},
            )
            st["count"] += 1
            if tc["failed"]:
                st["failed"] += 1
            t0, t1 = tc["timestamp"], res.get("ts")
            if t0 and t1 and t1 >= t0:
                st["lat"].append(t1 - t0)
            if res.get("chars") is not None:
                st["chars"].append(res["chars"])

        def _pct(vals: list[float], q: float) -> Optional[float]:
            if not vals:
                return None
            sv = sorted(vals)
            return round(sv[min(len(sv) - 1, int(q * len(sv)))], 2)

        s["tool_stats"] = sorted(
            (
                {
                    "name": st["name"],
                    "count": st["count"],
                    "failed": st["failed"],
                    "latency_p50": _pct(st["lat"], 0.5),
                    "latency_p90": _pct(st["lat"], 0.9),
                    "chars_p50": int(_pct(st["chars"], 0.5) or 0),
                    "tokens_est": sum(st["chars"]) // 4,
                }
                for st in tool_agg.values()
            ),
            key=lambda x: -x["tokens_est"],
        )

        # --- Context curve: cumulative estimated tokens by message order, with
        # the turn where growth spiked and the turn that burned the most
        # reasoning (both name a specific turn to go look at).
        crows = conn.execute(
            "SELECT role, timestamp, "
            "LENGTH(COALESCE(content,'')) AS clen, "
            "LENGTH(COALESCE(reasoning,'')) AS rlen, "
            "LENGTH(COALESCE(reasoning_content,'')) AS rclen "
            "FROM messages WHERE session_id = ? ORDER BY timestamp, id",
            (session_id,),
        ).fetchall()
        curve: list[int] = []
        ctx = 0
        peak_growth = {"index": None, "tokens": 0}
        peak_reason = {"index": None, "tokens": 0}
        tools_by_ts: dict[str, list[str]] = {}
        for tc in tool_calls:
            if tc["timestamp"]:
                tools_by_ts.setdefault(str(round(tc["timestamp"], 1)), []).append(tc["name"])
        for i, cr in enumerate(crows):
            grow = (cr["clen"] or 0) // 4
            ctx += grow
            if grow > peak_growth["tokens"]:
                peak_growth = {"index": i, "tokens": grow}
            rtok = max(cr["rlen"] or 0, cr["rclen"] or 0) // 4
            if rtok > peak_reason["tokens"]:
                peak_reason = {
                    "index": i,
                    "tokens": rtok,
                    "context_tokens": ctx,
                    "timestamp": cr["timestamp"],
                    "tools": tools_by_ts.get(str(round(cr["timestamp"] or 0, 1)), []),
                }
            curve.append(ctx)
        # Downsample for a sparkline: at most ~60 points.
        step = max(1, len(curve) // 60)
        s["context_curve"] = curve[::step][-60:]
        s["context_total_tokens"] = ctx
        s["context_peak"] = peak_growth
        s["reasoning_peak_turn"] = peak_reason

        # Subagents: async_delegations spawned from this session (delegate_task
        # / parallel batches), plus the child sessions they produced.
        # Must run before the summary so the count is available.
        drows = conn.execute(
            "SELECT delegation_id, state, dispatched_at, completed_at, "
            "event_json, result_json FROM async_delegations "
            "WHERE origin_session = ? OR parent_session_id = ? "
            "ORDER BY dispatched_at",
            (session_id, session_id),
        ).fetchall()
        # Child sessions (the unnamed rows subagents produce) — match each
        # delegation to its child session by start time: the delegation's
        # dispatched_at is within a couple of seconds of the child session's
        # started_at (the session id's timestamp is UTC; dispatched_at is a
        # local epoch — compare numerically, pick the closest child).
        crows = conn.execute(
            f"SELECT {_SESSION_COLS} FROM sessions WHERE parent_session_id = ? "
            "ORDER BY started_at",
            (session_id,),
        ).fetchall()
        child_rows = list(crows)
        s["child_sessions"] = [_session_row_to_dict(r) for r in child_rows]

        # Lineage is NOT one relationship. `parent_session_id` is written by
        # three different things: a delegate_task run (source 'subagent'), a
        # /compress continuation (the child OPENS with the CONTEXT COMPACTION
        # handoff), or a session the user continued in a fresh chat. Only the
        # first is a subagent — 29 children here, 9 of them subagents.
        def _lineage_kind(source: Optional[str], first_msg: str) -> str:
            if source == "subagent":
                return "subagent"
            if (first_msg or "").startswith("[CONTEXT COMPACTION"):
                return "compaction"
            return "continued"

        kid_ids = [r["id"] for r in child_rows if r["id"]]
        kid_first: dict[str, str] = {}
        if kid_ids:
            ph = ",".join("?" * len(kid_ids))
            # Bare columns ride along with MIN() in SQLite — the row that won.
            for fr in conn.execute(
                f"SELECT session_id, content FROM messages WHERE role = 'user' "
                f"AND session_id IN ({ph}) GROUP BY session_id",
                kid_ids,
            ).fetchall():
                kid_first[fr["session_id"]] = fr["content"] or ""
        for cs in s["child_sessions"]:
            cs["kind"] = _lineage_kind(cs.get("source"), kid_first.get(cs["id"], ""))

        def _match_child(dispatch: Any) -> Optional[str]:
            if dispatch is None:
                return None
            best: Optional[str] = None
            best_gap: float = float("inf")
            for cr in child_rows:
                st = cr["started_at"]
                if st is None:
                    continue
                try:
                    gap = abs(float(st) - float(dispatch))
                except (TypeError, ValueError):
                    continue
                if gap < best_gap:
                    best_gap = gap
                    best = cr["id"]
            return best if best_gap <= 10 else None

        subagents: list[dict[str, Any]] = []
        for dr in drows:
            info: dict[str, Any] = {
                "delegation_id": dr["delegation_id"],
                "state": dr["state"] or "unknown",
                "dispatched_at": dr["dispatched_at"],
                "completed_at": dr["completed_at"],
                "summary": "",
                "model": "",
                "api_calls": 0,
                "duration_s": None,
                "tokens": {},
                "status": "",
                "child_session_id": _match_child(dr["dispatched_at"]),
            }
            try:
                results = json.loads(dr["result_json"] or "{}").get("results") or []
            except (json.JSONDecodeError, TypeError):
                results = []
            if results and isinstance(results[0], dict):
                r0 = results[0]
                info["summary"] = str(r0.get("summary") or "")[:400]
                info["model"] = str(r0.get("model") or "")
                info["api_calls"] = int(r0.get("api_calls") or 0)
                info["duration_s"] = r0.get("duration_seconds")
                info["status"] = str(r0.get("status") or "")
                toks = r0.get("tokens")
                if isinstance(toks, dict):
                    info["tokens"] = {
                        k: int(v) for k, v in toks.items() if isinstance(v, (int, float))
                    }
            if info["dispatched_at"] is not None and info["completed_at"] is not None:
                try:
                    info["duration_s"] = round(
                        max(0.0, float(info["completed_at"]) - float(info["dispatched_at"])), 1
                    )
                except (TypeError, ValueError):
                    pass
            subagents.append(info)
        s["subagents"] = subagents

        # Waste-layer events (token-efficiency lens): 503 retries, model
        # switches, and context compactions all re-bill or reset the prompt
        # cache — each is a detectable marker in the message stream.
        erows = conn.execute(
            "SELECT role, content, display_kind, timestamp FROM messages "
            "WHERE session_id = ? AND ("
            "  content LIKE 'you hit a 503%'"
            "  OR display_kind = 'model_switch'"
            "  OR content LIKE '[CONTEXT COMPACTION%'"
            ") ORDER BY timestamp",
            (session_id,),
        ).fetchall()
        events = []
        for er in erows:
            content = er["content"] or ""
            kind = er["display_kind"]
            if content.startswith("you hit a 503"):
                etype = "retry_503"
            elif content.startswith("[CONTEXT COMPACTION"):
                etype = "compaction"
            elif kind == "model_switch":
                # "[System: The active model ... changed to X via provider Y. …]"
                etype = "model_switch"
            else:
                continue
            events.append({
                "type": etype,
                "timestamp": er["timestamp"],
                "detail": content[:120],
            })
        s["waste_events"] = events
        # Assistant reasoning volume: sessions.reasoning_tokens is spotty, so
        # sum stored reasoning text per message and estimate tokens at ~4
        # chars/token (matches tokenizer output within ~10% for English).
        # reasoning and reasoning_content often hold the SAME text (provider
        # duplicates) — take MAX of the two lengths, summing double-counts.
        crow = conn.execute(
            "SELECT COALESCE(SUM(mx), 0) AS total, COALESCE(MAX(mx), 0) AS peak "
            "FROM (SELECT MAX(LENGTH(COALESCE(reasoning,'')), "
            "LENGTH(COALESCE(reasoning_content,''))) AS mx "
            "FROM messages WHERE session_id = ? AND role = 'assistant')",
            (session_id,),
        ).fetchone()
        reasoning_chars = crow["total"] if crow else 0
        s["reasoning_chars"] = reasoning_chars
        s["reasoning_tokens_est"] = reasoning_chars // 4
        out_t = s.get("output_tokens") or 0
        s["reasoning_share"] = (
            round((reasoning_chars / 4) / out_t, 4)
            if out_t > 0 and reasoning_chars
            else None
        )
        # Concentration: one turn producing most of the reasoning (a stuck
        # loop) reads differently than reasoning spread across the session.
        peak_chars = crow["peak"] if crow else 0
        s["reasoning_peak_share"] = (
            round((peak_chars / 4) / out_t, 4)
            if out_t > 0 and peak_chars
            else None
        )

        # Peer baseline: median cache hit rate / reasoning share over the 50
        # most recent sessions with token data, so the Ask AI judge can call
        # a value abnormal relative to this install instead of in a vacuum.
        srows = conn.execute(
            "SELECT id, input_tokens, cache_read_tokens, output_tokens "
            "FROM sessions WHERE (input_tokens + cache_read_tokens) > 0 "
            "ORDER BY started_at DESC LIMIT 50"
        ).fetchall()
        rates = sorted(
            r["cache_read_tokens"] / (r["input_tokens"] + r["cache_read_tokens"])
            for r in srows
        )
        shares = []
        if srows:
            out_by_id = {r["id"]: r["output_tokens"] for r in srows}
            ph = ",".join("?" * len(srows))
            rr = conn.execute(
                f"SELECT m.session_id AS session_id, SUM(m.mx) AS chars FROM "
                f"(SELECT session_id, MAX(LENGTH(COALESCE(reasoning,'')), "
                f"LENGTH(COALESCE(reasoning_content,''))) AS mx FROM messages "
                f"WHERE role = 'assistant' AND session_id IN ({ph}) "
                f"GROUP BY session_id) m "
                f"JOIN sessions s2 ON s2.id = m.session_id "
                f"WHERE s2.output_tokens > 0 GROUP BY m.session_id",
                [r["id"] for r in srows],
            ).fetchall()
            for row in rr:
                out2 = out_by_id.get(row["session_id"])
                if out2:
                    shares.append(row["chars"] / 4 / out2)

        s["peer_baseline"] = {
            "n": len(srows),
            "cache_hit_rate_median": _pct(rates, 0.5),
            "reasoning_share_median": _pct(shares, 0.5),
        }

        # Summary sentence (deterministic, no LLM).
        n_tools = len(tool_calls)
        distinct = len(by_tool)
        writes = sum(1 for f in files_sorted if f["writes"] > 0)
        n_failed = len(failed_calls)
        s["summary"] = (
            f"{n_tools} tool call{'s' if n_tools != 1 else ''} across "
            f"{distinct} tool type{'s' if distinct != 1 else ''}"
            + (f" ({n_failed} failed)" if n_failed else "")
            + f"; {writes} file write{'s' if writes != 1 else ''} "
            f"({', '.join(f['path'].split('/')[-1] for f in files_sorted[:5]) or 'none'})"
        )
        if subagents:
            n_ok = sum(1 for sa in subagents if sa["state"] == "completed")
            n_err = len(subagents) - n_ok
            s["summary"] += (
                f"; {len(subagents)} subagent{'s' if len(subagents) != 1 else ''}"
                + (f" ({n_err} failed)" if n_err else "")
            )

        s["tool_calls"] = tool_calls
        s["tool_breakdown"] = sorted(
            by_tool.values(), key=lambda x: -x["count"]
        )
        s["failed_calls"] = failed_calls
        s["files"] = files_sorted

        # First user message = what the session was about (no LLM needed).
        urow = conn.execute(
            "SELECT content FROM messages WHERE session_id = ? AND role = 'user' "
            "AND content IS NOT NULL AND content != '' "
            "ORDER BY timestamp LIMIT 1",
            (session_id,),
        ).fetchone()
        about = (urow["content"] if urow else "") or ""
        # Skip synthetic wrappers (delegation/system notices) that aren't a
        # real user prompt; fall back to the raw first message. Keep the raw
        # value too — the compaction handoff is exactly what identifies a
        # /compress continuation below.
        first_user_raw = about.strip()
        about = first_user_raw
        if about.startswith("[ASYNC DELEGATION") or about.startswith("[CONTEXT COMPACTION"):
            about = ""
        s["about"] = about[:400] if about else ""

        # Where THIS session came from — a subagent run, a compaction
        # continuation, or a continued chat. Carries the parent's title so the
        # detail view can link straight back to it.
        pid = s.get("parent_session_id")
        s["origin"] = None
        if pid:
            prow = conn.execute(
                "SELECT id, title, source FROM sessions WHERE id = ?", (pid,)
            ).fetchone()
            s["origin"] = {
                "id": pid,
                "title": (prow["title"] if prow else "") or "",
                "source": (prow["source"] if prow else "") or "",
                "kind": _lineage_kind(s.get("source"), first_user_raw),
            }

        # Cost formatting.
        est = s.get("estimated_cost_usd")
        act = s.get("actual_cost_usd")
        s["cost_display"] = (
            f"${act:.4f}" if act else (f"${est:.4f}" if est else "—")
        )

        conn.close()
        return s
    except HTTPException:
        raise
    except sqlite3.Error as e:
        logger.exception("session detail query failed")
        raise HTTPException(status_code=500, detail=f"query failed: {e}")
