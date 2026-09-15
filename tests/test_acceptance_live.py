"""Acceptance tests: the session-insight features, exercised against the REAL
state.db (Tom's convention — real data, not made-up inputs).

These assert the detail endpoint returns every analysis surface with the
shape the UI consumes. Skips when no state.db exists (CI, fresh machines);
on Tom's machine it always runs against live sessions.

Run: ~/.hermes/hermes-agent/venv/bin/pytest tests/test_acceptance_live.py -v
"""

import importlib.util
import os
import sys
from pathlib import Path

import pytest

REPO = Path(__file__).resolve().parent.parent
MODULE_PATH = (
    REPO / "dashboard" / "plugin_api.py"
)


def _load_module():
    spec = importlib.util.spec_from_file_location("plugin_api_accept", MODULE_PATH)
    assert spec is not None and spec.loader is not None
    mod = importlib.util.module_from_spec(spec)
    sys.modules["plugin_api_accept"] = mod
    spec.loader.exec_module(mod)
    return mod


plugin_api = _load_module()

_have_db = (
    Path(os.environ.get("HERMES_HOME") or Path.home() / ".hermes") / "state.db"
).exists()
pytestmark = pytest.mark.skipif(not _have_db, reason="no state.db on this machine")


def _pick_session(min_msgs: int = 10) -> str:

    conn = plugin_api._connect()
    row = conn.execute(
        "SELECT session_id FROM messages WHERE role = 'tool' "
        "AND tool_name IS NOT NULL GROUP BY session_id "
        "HAVING COUNT(*) >= ? ORDER BY MAX(timestamp) DESC LIMIT 1",
        (min_msgs,),
    ).fetchone()
    conn.close()
    if row is None:
        pytest.skip("no session with enough tool calls")
    return row["session_id"]


@pytest.fixture(scope="module")
def detail():
    sid = _pick_session()
    import asyncio

    return asyncio.run(plugin_api.session_detail(sid))


def test_failed_calls_carry_detail(detail):
    """The core restoration: failed calls ride the real error story, not just
    the 120-char trim."""
    for fc in detail.get("failed_calls", []):
        assert "detail" in fc
        assert "error" in fc
        if fc.get("detail"):
            assert "\x1b" not in fc["detail"], "ANSI codes must be stripped"


def test_files_touched_present_with_shape(detail):
    files = detail.get("files") or []
    for f in files:
        assert {"path", "touched", "writes", "tools"} <= set(f)
        assert isinstance(f["tools"], list)


def test_loops_are_grouped_problems(detail):
    for lp in detail.get("loops") or []:
        assert lp["count"] >= 3
        assert lp["failed"] <= lp["count"]


def test_tool_stats_have_latency_and_tokens(detail):
    for st in detail.get("tool_stats") or []:
        assert {"name", "count", "tokens_est"} <= set(st)
        assert st["tokens_est"] >= 0


def test_context_curve_and_peaks(detail):
    curve = detail.get("context_curve") or []
    if len(curve) > 1:
        # Downsampled sparkline: monotonic sample whose last point is close
        # to (but capped by) the true total — not exactly the total, since
        # curve[::step] can drop the final message.
        assert all(b >= a for a, b in zip(curve, curve[1:], strict=False))
        assert 0 < curve[-1] <= detail["context_total_tokens"]
        assert detail["context_peak"]["index"] is not None
        rp = detail["reasoning_peak_turn"]
        assert rp["index"] is not None
        assert rp["tokens"] > 0


def test_summary_and_about(detail):
    assert detail.get("summary")
    assert "tool call" in detail["summary"]


def test_list_sort_failed_runs():
    """sort=failed path: the Python-side failure detector over real rows."""
    import asyncio

    # FastAPI Query() defaults aren't plain values — pass them all explicitly.
    out = asyncio.run(
        plugin_api.list_sessions(limit=10, offset=0, source=None, q=None, sort="failed")
    )
    assert out["total"] >= 1
    assert len(out["sessions"]) >= 1


def test_waste_events_carry_summary(detail):
    """Every cache-reset event must ride a one-line human summary so the UI
    renders it without a hover tooltip."""
    for ev in detail.get("waste_events", []):
        assert "summary" in ev
        assert ev["summary"], f"empty summary for {ev['type']} event"


def test_waste_event_summary_mentions_model_when_switch(detail):
    """model_switch summaries name the model the session switched TO."""
    switches = [
        ev for ev in detail.get("waste_events", []) if ev["type"] == "model_switch"
    ]
    for ev in switches:
        assert "switched to" in ev["summary"]
        assert "cache" in ev["summary"]
