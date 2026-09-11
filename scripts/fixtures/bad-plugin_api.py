"""Fixture for lint-plugin.mjs — one deliberate violation per Python rule.

P0 (syntax) is exercised by the file parsing at all; the rest are content
violations that must each be reported.
"""

import sqlite3


def scratch_write(conn: sqlite3.Connection) -> None:
    # P1 — this backend must stay read-only.
    conn.execute("DELETE FROM messages WHERE id = ?", (1,))


def reasoning_sum(conn: sqlite3.Connection) -> None:
    # P2 — summing both lengths double-counts the duplicated text.
    conn.execute(
        "SELECT SUM(LENGTH(COALESCE(reasoning,''))"
        "+LENGTH(COALESCE(reasoning_content,''))), 0) FROM messages"
    )


def search_with_grouping(conn: sqlite3.Connection) -> None:
    # P2b — snippet() cannot be combined with GROUP BY.
    conn.execute(
        """
        SELECT m.session_id, snippet(messages_fts, -1, '>>>', '<<<', '...', 40)
        FROM messages_fts JOIN messages m ON m.id = messages_fts.rowid
        GROUP BY m.session_id
        """
    )


def connect() -> sqlite3.Connection:
    # P3 — must be opened read-only.
    return sqlite3.connect("state.db")
