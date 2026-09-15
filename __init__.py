"""Session Analyzer native half: a no-op.

The desktop UI (``desktop/plugin.js``) and the dashboard REST API
(``dashboard/``) are discovered by the desktop app on their own; this module
adds no agent-side tools, hooks, or middleware, and ``register()`` is
intentionally empty.
"""


def register(ctx):
    pass
