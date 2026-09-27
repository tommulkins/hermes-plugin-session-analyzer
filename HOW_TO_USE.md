# How to Use Session Analyzer

Session Analyzer is not just a dashboard — it's a feedback loop. The point is
to close the gap between _what your agent did_ and _what your agent does next
time_. This page covers the loop that makes that happen.

## The core loop

1. **Run a real session.** Anything substantive — a build, a refactor, a
   research task.
2. **Open Session Analyzer** and pick the session (sort by `recent`, or
   `worst` if you suspect it went sideways).
3. **Scan the numbers before reading anything.** Spend, duration, cache %,
   tool-call table, failed calls, repeated calls.
4. **Click Ask AI.** It copies a ready-made analysis prompt to your clipboard
   and opens a fresh draft chat. Paste, pick a strong model, send.
5. **Act on one lesson before the next session.** One change per session is a
   compounding habit; five changes is a wish list.

## Why failed tool calls are bad (worse than they look)

A failed tool call is not a free retry. When a call fails:

- **The turn's tokens were already spent** — input, reasoning, and context
  push — and produced nothing.
- **The retry re-bills everything before it.** The failed call invalidated
  that turn's cached prefix, so the retry pays full price for the whole
  context again.
- **Failures cluster.** The same missing file, wrong path, or bad argument
  shape usually fails 3–5 times before the agent changes approach. Session
  Analyzer groups identical repeated calls so you see the root cause once
  instead of N failures.

Use the failed-calls section in Ask AI: "which failures repeated, what was
the root cause, and what instruction would have prevented all of them?"

## What to actually ask Ask AI

The default prompt is a good start. Sharpen it for the session you're
looking at:

- **Cost autopsy:** "Where did the tokens go? Which turns were re-billed
  after cache resets (503 retries, model switches, compactions)?"
- **Failure root cause:** "Group the failed calls by root cause. For each,
  state the one rule or fact that would have prevented it."
- **Process drift:** "Did the agent repeat work, re-read files, or go in
  circles? What checkpoint would have caught it?"
- **Prompt quality:** "Given what the user asked for versus what happened,
  how should the original prompt have been written?"

## Turn lessons into standing changes

An insight that lives only in the analysis chat is lost. Convert each lesson
into something persistent:

- **Agent skills** — a repeated procedure or pitfall becomes a skill the
  agent loads next time ("don't X; do Y instead").
- **Memory** — stable facts and preferences the agent should carry into
  every session.
- **Dedicated Hermes profiles** — when a line of work keeps needing the same
  context, model, toolsets, and persona, split it into its own profile (for
  example a writing profile, a growth-coach profile, a devops profile).
  Profiles isolate skills, memories, and cron jobs, so each one starts warm
  instead of re-learning your setup every session.
- **Config changes** — if the session fought the toolset (missing tools,
  wrong defaults), fix the profile's toolset config rather than compensating
  in every prompt.

## A workable cadence

- **After every heavy session:** 2 minutes in Session Analyzer, one Ask AI
  run on anything that cost more or failed more than expected.
- **Weekly:** sort by `worst`, ask Ask AI "what pattern spans these
  sessions?", and land one standing change (skill, memory, profile, config).
- **After a bad block:** don't push through. Analyze, extract the lesson,
  start the next session fresh with it applied.
