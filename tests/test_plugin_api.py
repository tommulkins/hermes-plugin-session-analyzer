"""Unit tests for plugin_api.py pure functions.

Run: python3 -m pytest tests/test_plugin_api.py -v
(or: python3 tests/test_plugin_api.py — falls back to a tiny runner)

Covers the two pieces of logic that decide what the Failed-calls panel
shows: _detect_failure (is this call failed, and the short row message)
and _failure_detail (the expanded 'what actually went wrong' story,
including the ANSI-strip and batch-tool regressions that shipped).
"""

import importlib.util
import json
import sys
from pathlib import Path

import pytest

REPO = Path(__file__).resolve().parent.parent
MODULE_PATH = (
    REPO / "plugins" / "session-dashboard" / "dashboard" / "plugin_api.py"
)


def _load_module():
    spec = importlib.util.spec_from_file_location("plugin_api_test", MODULE_PATH)
    assert spec is not None and spec.loader is not None
    mod = importlib.util.module_from_spec(spec)
    sys.modules["plugin_api_test"] = mod
    spec.loader.exec_module(mod)
    return mod


plugin_api = _load_module()


# --------------------------------------------------------------------------
# _detect_failure
# --------------------------------------------------------------------------


class TestDetectFailure:
    def test_terminal_exit_code_nonzero_fails(self):
        failed, msg = plugin_api._detect_failure(
            "terminal", json.dumps({"exit_code": 1, "output": "boom"})
        )
        assert failed is True
        assert "[exit 1]" in msg

    def test_terminal_exit_code_zero_passes(self):
        failed, _ = plugin_api._detect_failure(
            "terminal", json.dumps({"exit_code": 0, "output": "fine"})
        )
        assert failed is False

    def test_structured_error_fails(self):
        failed, msg = plugin_api._detect_failure(
            "web_search", json.dumps({"error": "rate limited", "success": False})
        )
        assert failed is True
        assert "rate limited" in msg

    def test_write_file_landed_write_is_success(self):
        # A landed write whose diff text mentions "error" is still a success.
        result = json.dumps({"bytes_written": 42, "diff": "removes the error"})
        failed, _ = plugin_api._detect_failure("write_file", result)
        assert failed is False

    def test_patch_success_true_is_success(self):
        failed, _ = plugin_api._detect_failure(
            "patch", json.dumps({"success": True, "diff": "..."})
        )
        assert failed is False

    def test_patch_write_denial_fails(self):
        failed, msg = plugin_api._detect_failure(
            "patch",
            json.dumps({"error": "write denied: outside workspace", "success": False}),
        )
        assert failed is True
        assert "write denied" in msg

    def test_non_string_result_never_fails(self):
        assert plugin_api._detect_failure("terminal", None)[0] is False
        assert plugin_api._detect_failure("terminal", 123)[0] is False


# --------------------------------------------------------------------------
# _failure_detail
# --------------------------------------------------------------------------


class TestFailureDetail:
    def test_structured_error_field_wins(self):
        content = json.dumps({"error": "BLOCKED: command needs approval"})
        assert "BLOCKED" in plugin_api._failure_detail("terminal", content)

    def test_batch_tools_carry_failure_inside_results(self):
        # web_extract regression: the top-level dict has no error; the first
        # result entry does.
        content = json.dumps(
            {"results": [{"url": "https://x", "error": "403 Forbidden"}]}
        )
        assert "403 Forbidden" in plugin_api._failure_detail("web_extract", content)

    def test_output_tail_survives(self):
        content = json.dumps({"output": "warning line\nreal failure: ENOENT"})
        detail = plugin_api._failure_detail("terminal", content)
        assert "ENOENT" in detail

    def test_ansi_codes_stripped(self):
        # Ponytail-pass regression: SGR color codes leaked into the detail.
        content = "ls: no such file: \x1b[31mfoo\x1b[0m done"
        detail = plugin_api._failure_detail("terminal", content)
        assert "\x1b" not in detail
        assert "foo" in detail

    def test_ansi_codes_stripped_in_structured_output(self):
        content = json.dumps({"output": "\x1b[1;33mblocked\x1b[0m by gateway"})
        detail = plugin_api._failure_detail("terminal", content)
        assert "\x1b" not in detail
        assert "blocked" in detail

    def test_detail_capped_at_700(self):
        content = "x" * 5000
        assert len(plugin_api._failure_detail("terminal", content)) <= 700

    def test_non_string_content_yields_empty(self):
        assert plugin_api._failure_detail("terminal", None) == ""


# --------------------------------------------------------------------------
# _strip_ansi
# --------------------------------------------------------------------------


class TestStripAnsi:
    def test_plain_text_unchanged(self):
        assert plugin_api._strip_ansi("hello world") == "hello world"

    def test_color_codes_removed(self):
        assert plugin_api._strip_ansi("\x1b[32mgreen\x1b[0m") == "green"

    def test_bold_and_256_color(self):
        assert plugin_api._strip_ansi("\x1b[1;38;5;196mx\x1b[m") == "x"


# --------------------------------------------------------------------------
# _event_summary
# --------------------------------------------------------------------------


class TestEventSummary:
    def test_model_switch_names_the_model(self):
        content = (
            "[System: The active model for this chat has changed to "
            "deepseek/deepseek-v4.1-flash via provider nous. From this point …]"
        )
        s = plugin_api._event_summary("model_switch", content)
        assert "deepseek/deepseek-v4.1-flash" in s
        assert "cache" in s

    def test_model_switch_fallback_without_match(self):
        s = plugin_api._event_summary("model_switch", "[System: garbled]")
        assert "model changed" in s

    def test_503_mentions_rebill(self):
        assert "re-billed" in plugin_api._event_summary(
            "retry_503", "you hit a 503 upstream.  pick up where left off"
        )

    def test_compaction_mentions_summary(self):
        assert "summary" in plugin_api._event_summary(
            "compaction", "[CONTEXT COMPACTION — REFERENCE ONLY] Earlier turns…"
        )


if __name__ == "__main__":
    sys.exit(pytest.main([__file__, "-v"]))
