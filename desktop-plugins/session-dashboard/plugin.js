/**
 * Session Analyzer — per-session analytics for the Hermes desktop app.
 *
 * Full page at /session-dashboard (sidebar nav row + ⌘K command), backed by
 * the session-dashboard Python plugin API (/api/plugins/session-dashboard):
 * token/cache/cost aggregates, tool-call breakdown, file changes derived
 * from tool-call arguments.
 *
 * Plain ESM, loaded uncompiled — jsx() calls, no JSX syntax. Only
 * @hermes/plugin-sdk, react, react/jsx-runtime resolve.
 */

import {
  atom,
  Badge,
  cn,
  Codicon,
  host,
  PALETTE_AREA,
  ROUTES_AREA,
  ScrollArea,
  SIDEBAR_NAV_AREA,
  useQuery,
  useValue
} from '@hermes/plugin-sdk'
import { jsx, jsxs } from 'react/jsx-runtime'
import { useState } from 'react'

const ID = 'session-dashboard'
const DETAIL_KEY = (id) => [ID, 'detail', id]

// Bound in register(); used by query fns so all data flows through ctx.rest
// (namespace-scoped to /api/plugins/session-dashboard).
let rest = null
const $selected = atom(null)
const $expandedCalls = atom(new Set())
// Right-click context menu: {x, y, sessionId, parentId} or null.
const $contextMenu = atom(null)

// Assemble a self-contained "ask AI" prompt from a session detail payload.
// The user pastes this into a NEW session and picks any model — the prompt
// carries the session id so the agent can look up the full transcript.
function buildAskPrompt(s) {
  const lines = []
  lines.push('Analyze this Hermes agent session and tell me what went wrong and how to improve the next one.')
  lines.push('')
  lines.push(`- Session ID: ${s.id}`)
  lines.push(`- Title: ${s.title || '(untitled)'}`)
  lines.push(`- Source: ${s.source}${s.model ? `  ·  Model: ${s.model}` : ''}`)
  lines.push(`- Started: ${fmtTime(s.started_at)}  ·  Duration: ${fmtDur(s.duration_s)}`)
  lines.push(`- Messages: ${s.message_count ?? '?'}  ·  Tool calls: ${s.tool_call_count ?? '?'}`)
  lines.push(`- Tokens — input: ${fmtTokens(s.input_tokens)}  output: ${fmtTokens(s.output_tokens)}  cache read: ${fmtTokens(s.cache_read_tokens)}  cache write: ${fmtTokens(s.cache_write_tokens)}`)
  lines.push(`- Spend: ${fmtCost(s.estimated_cost_usd)}${s.cost_status ? `  (${s.cost_status})` : ''}`)
  if (s.summary) lines.push(`- Summary: ${s.summary}`)
  lines.push('')
  lines.push('Tool usage (calls / failures):')
  for (const t of s.tool_breakdown || []) {
    lines.push(`- ${t.name}: ${t.count}${t.failed ? ` (${t.failed} failed)` : ''}`)
  }
  const fails = (s.failed_calls || []).slice(0, 20)
  if (fails.length) {
    lines.push('')
    lines.push('Failed tool calls (up to 20):')
    for (const f of fails) {
      lines.push(`- ${f.name}${f.id ? ` [${f.id}]` : ''}: ${f.error || 'no error text'}`)
    }
  }
  const files = (s.files || []).filter((f) => f.writes > 0).slice(0, 20)
  if (files.length) {
    lines.push('')
    lines.push('Files written:')
    for (const f of files) lines.push(`- ${f.path}`)
  }
  lines.push('')
  lines.push('Look up the full session transcript with the session_search tool:')
  lines.push(`- Call session_search with session_id "${s.id}" to read it (large sessions return first/last bookends).`)
  lines.push('- To see the middle, scroll FORWARD: pass the LAST message id from the previous result as around_message_id. Message ids are global and NOT contiguous across sessions — never invent or guess an id, it errors.')
  lines.push('- Scroll windows overlap at the anchor by design; ignore duplicates and keep advancing from the newest last id.')
  lines.push('- Stop once you can explain every failed tool call listed above — do not fetch every remaining gap.')
  lines.push('')
  lines.push('Answer with:')
  lines.push('1. What failed and why — the root cause of each failed tool call.')
  lines.push('2. How the session could have been more compact — token/cache usage, redundant work, context bloat.')
  lines.push('3. Concrete Hermes config or workflow suggestions to reduce failures and cost next time (e.g. compression thresholds, tools, model choice, prompt changes).')
  lines.push('4. Skills that could have helped — run skills_list and check whether an existing skill (or a skill the session should have triggered) would have avoided a failure or saved steps. Name the skill and what it would have changed.')
  lines.push('5. A short checklist for the next session based on this one.')
  return lines.join('\n')
}

function copyText(text) {
  try {
    navigator.clipboard.writeText(text)
    return true
  } catch {
    return false
  }
}

// Open a brand-new session for the ask-AI prompt and land the user on it,
// WITHOUT submitting — they pick the provider/model as the judge first, then
// paste (⌘V) and send. The desktop composer is renderer-owned, so a plugin
// can't prefill the text box directly; navigating + copying makes it one
// keystroke.
async function askAi(s) {
  const prompt = buildAskPrompt(s)
  // Toast FIRST — synchronously on click, before any await. The copy-only
  // version worked because notify ran immediately; once session.create sat
  // in front of it, a slow/hung RPC delayed (or killed) the toast entirely.
  const copied = copyText(prompt)
  host.notify(
    copied
      ? {
        kind: 'info',
        title: 'Starting new session…',
        message: 'Prompt copied — paste it in (⌘V), pick your model, then send.',
        durationMs: 8000
      }
      : { kind: 'error', title: 'Ask AI', message: 'Clipboard unavailable — select and copy manually.' }
  )

  // Bounded wait: never let a hung gateway RPC swallow the flow.
  const withTimeout = (p, ms) =>
    Promise.race([
      p,
      new Promise((_, reject) => setTimeout(() => reject(new Error(`gateway timed out after ${ms}ms`)), ms))
    ])

  try {
    const created = await withTimeout(
      host.request('session.create', {
        title: `Session analysis: ${(s.title || s.id).slice(0, 60)}`
      }),
      10000
    )
    const sid = created?.session_id
    const stored = created?.stored_session_id
    if (!sid) throw new Error('no session_id returned')
    // Long enough delay for the toast to be seen: the session mount clears
    // notifications on arrival, so the toast dies at navigation no matter
    // its durationMs. Give it ~2s of visible life before switching over.
    setTimeout(() => host.navigate('/' + encodeURIComponent(stored || sid)), 2000)
  } catch (err) {
    host.notify({ kind: 'error', title: 'Ask AI failed', message: `${err?.message ?? err}` })
  }
}

function fmtTokens(n) {
  if (n == null) return '—'
  if (n >= 1e6) return (n / 1e6).toFixed(2) + 'M'
  if (n >= 1e3) return (n / 1e3).toFixed(1) + 'k'
  return String(n)
}

function fmtCost(n) {
  if (n == null || n === 0) return '—'
  if (n < 0.01) return '$' + n.toFixed(4)
  return '$' + n.toFixed(3)
}

function fmtTime(ts) {
  if (!ts) return '—'
  const d = new Date(ts * 1000)
  return d.toLocaleString(undefined, {
    month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit'
  })
}

function fmtDur(s) {
  if (s == null) return '—'
  if (s < 60) return Math.round(s) + 's'
  if (s < 3600) return Math.round(s / 60) + 'm'
  return (s / 3600).toFixed(1) + 'h'
}

function Stat({ label, value, title }) {
  return jsxs('div', {
    className: 'flex flex-col gap-0.5 min-w-0',
    title,
    children: [
      jsx('div', { className: 'text-[0.625rem] uppercase tracking-wide text-(--ui-text-quaternary)', children: label }),
      jsx('div', { className: 'text-sm font-medium tabular-nums truncate', children: value })
    ]
  })
}

function TokenBar({ input, output, cache }) {
  const total = (input || 0) + (output || 0) + (cache || 0)
  if (!total) return null
  const pct = (v) => ((v || 0) / total) * 100
  return jsxs('div', {
    className: 'flex flex-col gap-1',
    children: [
      jsxs('div', {
        className: 'flex h-2 w-full overflow-hidden rounded-full bg-(--ui-stroke-secondary)',
        children: [
          jsx('div', { style: { width: pct(input) + '%' }, className: 'h-full bg-(--ui-accent)', title: `input ${fmtTokens(input)}` }),
          jsx('div', { style: { width: pct(cache) + '%' }, className: 'h-full bg-(--ui-accent) opacity-40', title: `cache read ${fmtTokens(cache)}` }),
          jsx('div', { style: { width: pct(output) + '%' }, className: 'h-full bg-(--ui-text-tertiary)', title: `output ${fmtTokens(output)}` })
        ]
      }),
      jsxs('div', {
        className: 'flex gap-3 text-[0.625rem] text-(--ui-text-tertiary)',
        children: [
          jsx('span', { children: `in ${fmtTokens(input)}` }),
          jsx('span', { className: 'opacity-70', children: `cache ${fmtTokens(cache)}` }),
          jsx('span', { children: `out ${fmtTokens(output)}` })
        ]
      })
    ]
  })
}

function SessionList({ sessions, selected, onSelect, searchMode, showFailed }) {
  return jsx(ScrollArea, {
    className: 'h-full',
    children: jsxs('div', {
      className: 'flex flex-col gap-1 p-2',
      children: sessions.map((s) => {
        const active = s.id === selected
        return jsxs('button', {
          type: 'button',
          onClick: () => onSelect(s.id),
          onContextMenu: (e) => {
            e.preventDefault()
            e.stopPropagation()
            $contextMenu.set({ x: e.clientX, y: e.clientY, sessionId: s.id, parentId: s.parent_session_id || null })
          },
          className: cn(
            'flex w-full flex-col gap-1 rounded-md px-2 py-1.5 text-left text-sm transition-colors',
            active
              ? 'bg-(--ui-accent) text-(--ui-accent-foreground)'
              : 'hover:bg-(--chrome-action-hover)'
          ),
          children: [
            jsxs('div', {
              className: 'flex items-center gap-1.5 min-w-0',
              children: [
                jsx('span', { className: 'truncate font-medium', children: s.title || (s.parent_session_id ? 'Subagent' : s.id.slice(9)) }),
                showFailed && s.failed_count > 0
                  ? jsx(Badge, { variant: 'destructive', className: 'text-[0.6rem] shrink-0', children: `${s.failed_count} failed` })
                  : null,
                s.pinned ? jsx(Codicon, { name: 'pin', size: '0.7rem', className: 'shrink-0 opacity-70' }) : null
              ]
            }),
            searchMode
              ? jsx('div', {
                className: cn('truncate text-[0.625rem] leading-snug', active ? 'opacity-80' : 'text-(--ui-text-tertiary)'),
                title: s.snippet ? s.snippet.replace(/>>>|<<</g, '') : undefined,
                children: s.snippet ? s.snippet.replace(/>>>/g, '“').replace(/<</g, '”') : fmtTime(s.started_at)
              })
              : jsxs('div', {
                className: cn('flex items-center gap-2 text-[0.625rem]', active ? 'opacity-80' : 'text-(--ui-text-tertiary)'),
                children: [
                  jsx('span', { children: fmtTime(s.started_at) }),
                  jsx('span', { children: `${s.tool_call_count ?? 0} tools` }),
                  jsx('span', { className: 'tabular-nums', children: fmtCost(s.estimated_cost_usd) }),
                  s.parent_session_id && !s.title
                    ? jsx('span', { className: 'truncate font-mono', title: `parent session: ${s.parent_session_id}`, children: `parent: ${s.parent_session_id}` })
                    : null
                ]
              })
          ]
        })
      })
    })
  })
}

function ToolRow({ name, count, failed }) {
  return jsxs('div', {
    className: 'flex items-center justify-between gap-2 rounded-md px-2 py-1 hover:bg-(--chrome-action-hover)',
    children: [
      jsxs('div', { className: 'flex items-center gap-1.5 min-w-0', children: [
        failed
          ? jsx('button', {
            type: 'button',
            onClick: () => {
              const el = document.getElementById(`failed-group-${name.replace(/[^a-zA-Z0-9_-]/g, '_')}`)
              el?.scrollIntoView({ behavior: 'smooth', block: 'start' })
            },
            title: `Jump to failed ${name} calls`,
            className: 'flex items-center gap-1.5 min-w-0 font-mono text-xs truncate text-(--ui-error) hover:underline',
            children: name
          })
          : jsx('span', { className: 'font-mono text-xs truncate', children: name }),
        failed ? jsx(Badge, { variant: 'destructive', className: 'text-[0.6rem] shrink-0', children: `${failed} failed` }) : null
      ] }),
      jsx('span', { className: 'text-xs tabular-nums text-(--ui-text-tertiary)', children: count })
    ]
  })
}

function FailedCalls({ calls, all }) {
  const expanded = useValue($expandedCalls)
  if (!calls || calls.length === 0) return null
  const argsByCall = {}
  for (const tc of all || []) {
    if (tc.id) argsByCall[tc.id] = tc.args
  }
  const toggle = (id) => {
    const next = new Set(expanded)
    if (next.has(id)) next.delete(id)
    else next.add(id)
    $expandedCalls.set(next)
  }
  // Group by tool name (insertion order = first failure time), then the
  // rows inside each group stay chronological (backend orders by timestamp).
  const groups = []
  const byName = new Map()
  for (const c of calls.slice(0, 50)) {
    if (!byName.has(c.name)) {
      byName.set(c.name, [])
      groups.push(c.name)
    }
    byName.get(c.name).push(c)
  }
  return jsxs('div', {
    className: 'flex flex-col gap-2',
    children: [
      jsx('div', { className: 'text-[0.625rem] uppercase tracking-wide text-(--ui-error) pb-1', children: `Failed calls (${calls.length})` }),
      groups.map((gname) => {
        const g = byName.get(gname)
        const gid = `failed-group-${gname.replace(/[^a-zA-Z0-9_-]/g, '_')}`
        return jsxs('div', {
          id: gid,
          className: 'flex flex-col gap-0.5 rounded-md border border-(--ui-stroke-secondary) p-1',
          children: [
            jsxs('div', {
              className: 'flex items-center gap-1.5 px-1 py-0.5',
              children: [
                jsx(Codicon, { name: 'error', size: '0.75rem', className: 'shrink-0 text-(--ui-error)' }),
                jsx('span', { className: 'font-mono text-[0.6875rem] font-semibold', children: gname }),
                jsx(Badge, { variant: 'destructive', className: 'text-[0.6rem] shrink-0', children: `${g.length}` })
              ]
            }),
            g.map((c) => {
              const isOpen = expanded.has(c.id + c.timestamp)
              const args = argsByCall[c.id] || {}
              return jsxs('div', {
                className: 'flex flex-col gap-0.5 rounded-md px-2 py-1 cursor-pointer hover:bg-(--chrome-action-hover)',
                onClick: () => toggle(c.id + c.timestamp),
                children: [
                  jsxs('div', {
                    className: 'flex items-center gap-2 min-w-0 text-left pointer-events-none',
                    children: [
                      jsx(Codicon, { name: isOpen ? 'chevron-down' : 'chevron-right', size: '0.7rem', className: 'shrink-0 text-(--ui-text-tertiary)' }),
                      jsx('span', { className: 'font-mono text-xs font-medium truncate', children: c.id ? c.id.slice(0, 24) : '(no id)' }),
                      jsx('span', { className: 'ml-auto shrink-0 text-[0.6rem] text-(--ui-text-tertiary)', children: fmtTime(c.timestamp) })
                    ]
                  }),
                  c.error ? jsx('div', { className: 'pl-4 text-[0.625rem] text-(--ui-text-secondary) break-words pointer-events-none', children: c.error }) : null,
                  isOpen && Object.keys(args).length > 0
                    ? jsx('div', {
                      className: 'pl-4 font-mono text-[0.625rem] text-(--ui-text-tertiary) break-words whitespace-pre-wrap',
                      children: JSON.stringify(args, null, 1).slice(0, 800)
                    })
                    : null
                ]
              }, c.id + c.timestamp)
            })
          ]
        }, gid)
      })
    ]
  })
}

function FileRow({ f }) {
  const write = f.writes > 0
  return jsxs('div', {
    className: 'flex items-center gap-2 rounded-md px-2 py-1 hover:bg-(--chrome-action-hover)',
    title: f.path,
    children: [
      jsx(Codicon, { name: write ? 'file-code' : 'file', size: '0.8rem', className: write ? 'text-(--ui-accent)' : 'text-(--ui-text-tertiary)' }),
      jsx('span', { className: 'font-mono text-xs truncate flex-1', children: f.path }),
      f.writes > 1 ? jsx(Badge, { variant: 'muted', className: 'text-[0.6rem]', children: `${f.writes}×` }) : null
    ]
  })
}

function Detail({ session, onOpenSession }) {
  // Percentages of total tokens (input + cache read/write + output).
  const tot = (session.input_tokens ?? 0) + (session.cache_read_tokens ?? 0) + (session.cache_write_tokens ?? 0) + (session.output_tokens ?? 0)
  const pct = (v) => (tot > 0 ? Math.round(((v ?? 0) / tot) * 100) : 0)
  const tokens = [
    jsx(Stat, { key: 'in', label: 'input', value: `${fmtTokens(session.input_tokens)} (${pct(session.input_tokens)}%)`, title: `input tokens: ${session.input_tokens ?? '—'}` }),
    jsx(Stat, { key: 'cache', label: 'cache read', value: `${fmtTokens(session.cache_read_tokens)} (${pct(session.cache_read_tokens)}%)`, title: `cache read tokens: ${session.cache_read_tokens ?? '—'}\ncache write: ${fmtTokens(session.cache_write_tokens)} (${pct(session.cache_write_tokens)}%)` }),
    jsx(Stat, { key: 'out', label: 'output', value: `${fmtTokens(session.output_tokens)} (${pct(session.output_tokens)}%)`, title: `output tokens: ${session.output_tokens ?? '—'}` }),
    jsx(Stat, { key: 'cost', label: 'spend', value: fmtCost(session.estimated_cost_usd), title: session.cost_status ? `status: ${session.cost_status}` : undefined }),
    jsx(Stat, { key: 'dur', label: 'duration', value: fmtDur(session.duration_s) }),
    jsx(Stat, { key: 'msgs', label: 'msgs', value: session.message_count ?? '—' })
  ]

  return jsxs('div', {
    className: 'flex flex-col gap-3 p-3',
    children: [
      jsxs('div', {
        className: 'flex flex-col gap-0.5',
        children: [
          jsx('div', { className: 'text-sm font-semibold break-words', children: session.title || session.id }),
          jsxs('div', {
            className: 'flex flex-wrap items-center gap-x-3 gap-y-1 text-[0.625rem] text-(--ui-text-tertiary)',
            children: [
              jsx('span', { children: session.id }),
              jsx('span', { children: session.source }),
              session.model ? jsx('span', { children: session.model }) : null,
              jsx('span', { children: fmtTime(session.started_at) })
            ]
          })
        ]
      }),
      jsx(TokenBar, { input: session.input_tokens, output: session.output_tokens, cache: session.cache_read_tokens }),
      jsxs('div', {
        className: 'grid grid-cols-3 gap-2 sm:grid-cols-6',
        children: tokens
      }),
      jsxs('div', {
        className: 'flex items-center gap-2',
        children: [
          session.summary
            ? jsxs('div', {
              className: 'flex-1 rounded-md border border-(--ui-stroke-secondary) px-2 py-1.5 text-xs text-(--ui-text-secondary)',
              children: [jsx('span', { className: 'font-medium text-(--ui-text-primary)', children: 'Summary: ' }), session.summary]
            })
            : jsx('div', { className: 'flex-1' }),
          jsx('button', {
            type: 'button',
            onClick: () => askAi(session),
            className: 'shrink-0 inline-flex items-center gap-1 rounded-md border border-(--ui-stroke-secondary) px-2 py-1 text-[0.6875rem] font-medium text-(--ui-text-secondary) transition-colors hover:border-(--ui-accent) hover:text-foreground',
            title: 'Open a new session that analyzes this one: what failed, how to make the next session more compact, config suggestions',
            children: [
              jsx(Codicon, { name: 'sparkle', size: '0.75rem' }),
              'Ask AI'
            ]
          })
        ]
      }),
      jsxs('div', {
        className: 'grid grid-cols-1 gap-4 lg:grid-cols-2',
        children: [
          jsxs('div', {
            className: 'flex flex-col gap-1 min-h-0',
            children: [
              jsx('div', { className: 'text-[0.625rem] uppercase tracking-wide text-(--ui-text-quaternary) pb-1', children: 'Tool calls' }),
              (session.tool_breakdown || []).length
                ? session.tool_breakdown.map((t) => jsx(ToolRow, { name: t.name, count: t.count, failed: t.failed }, t.name))
                : jsx('div', { className: 'text-xs text-(--ui-text-tertiary)', children: 'No tool calls' }),
              jsx(FailedCalls, { calls: session.failed_calls, all: session.tool_calls })
            ]
          }),
          jsxs('div', {
            className: 'flex flex-col gap-1 min-h-0',
            children: [
              jsx('div', { className: 'text-[0.625rem] uppercase tracking-wide text-(--ui-text-quaternary) pb-1', children: 'Files touched' }),
              (session.files || []).length
                ? session.files.slice(0, 100).map((f) => jsx(FileRow, { f }, f.path))
                : jsx('div', { className: 'text-xs text-(--ui-text-tertiary)', children: 'No file paths in tool calls' })
            ]
          })
        ]
      }),
      (session.subagents || []).length
        ? jsxs('div', {
          className: 'flex flex-col gap-1',
          children: [
            jsx('div', { className: 'text-[0.625rem] uppercase tracking-wide text-(--ui-text-quaternary) pb-1', children: `Subagents (${session.subagents.length})` }),
            session.subagents.map((sa, i) => {
              const label = sa.status === 'completed' ? sa.status : sa.state
              const variant = label === 'completed' ? 'default' : label === 'error' || label === 'interrupted' ? 'destructive' : 'muted'
              const clickable = !!sa.child_session_id
              return jsxs('button', {
                type: 'button',
                disabled: !clickable,
                onClick: clickable ? (e) => { e.stopPropagation(); onOpenSession(sa.child_session_id) } : undefined,
                title: clickable ? `Open subagent session ${sa.child_session_id}` : 'No linked session',
                className: cn(
                  'flex w-full flex-col gap-0.5 rounded-md px-2 py-1.5 text-left transition-colors',
                  clickable ? 'cursor-pointer hover:bg-(--chrome-action-hover)' : 'cursor-default'
                ),
                children: [
                  jsxs('div', {
                    className: 'flex items-center gap-2 min-w-0',
                    children: [
                      jsx(Codicon, { name: label === 'completed' ? 'check' : 'error', size: '0.8rem', className: label === 'completed' ? 'text-(--ui-accent)' : 'text-(--ui-error)' }),
                      jsx('span', { className: 'text-xs font-medium truncate', children: sa.model || sa.delegation_id }),
                      jsx(Badge, { variant, className: 'text-[0.6rem] shrink-0', children: label }),
                      sa.duration_s != null ? jsx('span', { className: 'ml-auto shrink-0 text-[0.6rem] text-(--ui-text-tertiary)', children: fmtDur(sa.duration_s) }) : null,
                      sa.api_calls > 0 ? jsx('span', { className: 'shrink-0 text-[0.6rem] text-(--ui-text-tertiary)', children: `${sa.api_calls} call${sa.api_calls !== 1 ? 's' : ''}` }) : null,
                      sa.tokens && sa.tokens.input > 0 ? jsx('span', { className: 'shrink-0 text-[0.6rem] text-(--ui-text-tertiary)', children: `${fmtTokens(sa.tokens.input)} in` }) : null
                    ]
                  }),
                  sa.summary
                    ? jsx('div', { className: 'pl-5 text-[0.625rem] text-(--ui-text-secondary) line-clamp-3', title: sa.summary, children: sa.summary })
                    : null
                ]
              }, sa.delegation_id)
            })
          ]
        })
        : null,
      (session.child_sessions || []).length
        ? jsxs('div', {
          className: 'flex flex-col gap-1',
          children: [
            jsx('div', { className: 'text-[0.625rem] uppercase tracking-wide text-(--ui-text-quaternary) pb-1', children: `Child sessions (${session.child_sessions.length})` }),
            session.child_sessions.map((cs) => jsxs('button', {
              type: 'button',
              onClick: (e) => { e.stopPropagation(); onOpenSession(cs.id) },
              title: `Open child session ${cs.id}`,
              className: 'flex w-full items-center justify-between gap-2 rounded-md px-2 py-1 text-left text-[0.625rem] text-(--ui-text-tertiary) transition-colors hover:bg-(--chrome-action-hover) hover:text-foreground',
              children: [
                jsx('span', { className: 'truncate', children: cs.title || cs.id }),
                jsxs('span', { className: 'shrink-0 flex items-center gap-2', children: [
                  jsx('span', { children: `${cs.tool_call_count ?? 0} tools` }),
                  jsx('span', { children: fmtCost(cs.estimated_cost_usd) })
                ] })
              ]
            }, cs.id))
          ]
        })
        : null
    ]
  })
}

// Right-click menu for session rows: copy the session id (and the parent's
// id when the row is a subagent). Rendered fixed at the click position.
function ContextMenu() {
  const menu = useValue($contextMenu)
  if (!menu) return null
  const close = () => $contextMenu.set(null)
  const item = (label, value) => jsx('button', {
    type: 'button',
    onClick: (e) => {
      e.stopPropagation()
      copyText(value)
      host.notify({ kind: 'info', title: 'Copied', message: `${label} copied to clipboard`, durationMs: 3000 })
      close()
    },
    className: 'flex w-full items-center gap-2 rounded-md px-2 py-1 text-left text-xs text-(--ui-text-secondary) transition-colors hover:bg-(--chrome-action-hover) hover:text-foreground',
    children: [
      jsx(Codicon, { name: 'copy', size: '0.75rem', className: 'shrink-0' }),
      jsx('span', { className: 'truncate', children: label })
    ]
  }, label)
  return jsxs('div', {
    className: 'fixed z-50 flex min-w-[200px] max-w-[340px] flex-col gap-0.5 rounded-md border border-(--ui-stroke-secondary) bg-(--ui-bg-elevated) p-1 shadow-lg',
    style: { left: menu.x, top: menu.y },
    onContextMenu: (e) => { e.preventDefault(); e.stopPropagation() },
    children: [
      item(`Copy session id: ${menu.sessionId}`, menu.sessionId),
      menu.parentId ? item(`Copy parent id: ${menu.parentId}`, menu.parentId) : null,
      jsx('div', { className: 'px-2 py-0.5 text-[0.55rem] uppercase tracking-wide text-(--ui-text-quaternary)', children: menu.sessionId })
    ]
  })
}

function Page() {
  const selected = useValue($selected)
  // 100 by default; "Load more" bumps to 500 (the backend max).
  const [limit, setLimit] = useState(100)
  // Title filter: live substring match on session titles (backend LIKE).
  const [query, setQuery] = useState('')
  const q = query.trim()
  // Content search: when true, q runs the FTS semantic search instead.
  const [contentMode, setContentMode] = useState(false)
  // 'recent' (started_at desc) | 'failed' (worst sessions by failed calls).
  const [sort, setSort] = useState('recent')

  const { data: list, isLoading, error } = useQuery({
    queryKey: [ID, 'sessions', limit, q, sort],
    queryFn: () => rest(`/sessions?limit=${limit}&q=${encodeURIComponent(q)}&sort=${sort}`),
    staleTime: 30_000,
    refetchInterval: 30_000,
    enabled: !contentMode
  })

  const { data: search, isLoading: searchLoading, error: searchError } = useQuery({
    queryKey: [ID, 'search', q],
    queryFn: () => rest(`/search?q=${encodeURIComponent(q)}`),
    staleTime: 30_000,
    enabled: contentMode && !!q
  })

  const { data: detail } = useQuery({
    queryKey: DETAIL_KEY(selected),
    queryFn: () => rest(`/sessions/${encodeURIComponent(selected)}`),
    enabled: !!selected,
    staleTime: 30_000
  })

  const sessions = list?.sessions || []
  const searchResults = search?.results || []
  const searching = contentMode && !!q

  // Draggable divider between session list and detail: drag to resize.
  // Pointer capture on the divider itself — the col-resize cursor exists only
  // while dragging, never leaks to the rest of the app, and pointerup outside
  // the element still ends the drag cleanly.
  const [listWidth, setListWidth] = useState(260)

  const startDrag = (e) => {
    e.preventDefault()
    const el = e.currentTarget
    try { el.setPointerCapture(e.pointerId) } catch {}
    el.dataset.dragging = '1'
    document.body.style.cursor = 'col-resize'
    document.body.style.userSelect = 'none'
  }

  const onDragMove = (e) => {
    const el = e.currentTarget
    if (el.dataset.dragging !== '1') return
    const row = el.parentElement
    if (!row) return
    const left = row.getBoundingClientRect().left
    setListWidth(Math.max(160, Math.min(560, e.clientX - left)))
  }

  const endDrag = (e) => {
    const el = e.currentTarget
    if (el.dataset.dragging !== '1') return
    delete el.dataset.dragging
    try { el.releasePointerCapture(e.pointerId) } catch {}
    document.body.style.cursor = ''
    document.body.style.userSelect = ''
  }

  return jsxs('div', {
    className: 'flex h-full flex-col',
    onClick: () => $contextMenu.set(null),
    children: [
      jsxs('div', {
        className: 'flex items-center gap-2 border-b border-(--ui-stroke-secondary) px-3 py-2',
        children: [
          jsx(Codicon, { name: 'graph-line', size: '1rem' }),
          jsx('span', { className: 'text-sm font-semibold', children: 'Session Analyzer' }),
          jsx('span', { className: 'text-[0.625rem] text-(--ui-text-tertiary)', children: searching ? `${searchResults.length} matches` : `${sessions.length} sessions` })
        ]
      }),
      jsxs('div', {
        className: 'flex min-h-0 flex-1',
        children: [
              jsx('div', {
                className: 'flex min-h-0 flex-col',
                style: { width: listWidth + 'px', flexShrink: 0 },
                children: [
                  jsx('div', {
                    className: 'flex items-center gap-1 border-b border-(--ui-stroke-secondary) px-2 py-1.5',
                    children: [
                      jsx(Codicon, { name: contentMode ? 'sparkle' : 'search', size: '0.75rem', className: cn('shrink-0', contentMode ? 'text-(--ui-accent)' : 'text-(--ui-text-tertiary)') }),
                      jsx('input', {
                        // type="text" (NOT "search"): WebKit's native search
                        // clear button would double up with ours.
                        type: 'text',
                        value: query,
                        placeholder: contentMode ? 'Search message content…' : 'Filter by title or id…',
                        onChange: (e) => setQuery(e.target.value),
                        className: 'min-w-0 flex-1 bg-transparent text-xs outline-none placeholder:text-(--ui-text-quaternary)'
                      }),
                      // Content search: FTS over message content (semantic).
                      jsx('button', {
                        type: 'button',
                        onClick: () => setContentMode((m) => !m),
                        className: cn(
                          'shrink-0 rounded-md px-1.5 py-0.5 text-[0.6rem] font-medium transition-colors',
                          contentMode
                            ? 'bg-(--ui-accent)/20 text-(--ui-accent)'
                            : 'text-(--ui-text-tertiary) hover:bg-(--chrome-action-hover) hover:text-foreground'
                        ),
                        title: 'Toggle content search (FTS over message text)',
                        children: 'content'
                      }),
                      q
                        ? jsx('button', {
                          type: 'button',
                          onClick: () => { setQuery(''); setContentMode(false) },
                          className: 'shrink-0 text-(--ui-text-tertiary) hover:text-foreground',
                          title: 'Clear search',
                          children: jsx(Codicon, { name: 'close', size: '0.7rem' })
                        })
                        : null
                    ]
                  }),
                  jsx('div', {
                    className: 'flex items-center gap-1 border-b border-(--ui-stroke-secondary) px-2 py-1',
                    children: [
                      jsx('span', { className: 'text-[0.55rem] uppercase tracking-wide text-(--ui-text-quaternary)', children: 'Sort' }),
                      jsx('button', {
                        type: 'button',
                        onClick: () => setSort('recent'),
                        className: cn(
                          'rounded-md px-1.5 py-0.5 text-[0.6rem] font-medium transition-colors',
                          sort === 'recent' ? 'bg-(--ui-accent)/20 text-(--ui-accent)' : 'text-(--ui-text-tertiary) hover:bg-(--chrome-action-hover) hover:text-foreground'
                        ),
                        children: 'recent'
                      }),
                      jsx('button', {
                        type: 'button',
                        onClick: () => setSort('failed'),
                        className: cn(
                          'rounded-md px-1.5 py-0.5 text-[0.6rem] font-medium transition-colors',
                          sort === 'failed' ? 'bg-(--ui-error)/20 text-(--ui-error)' : 'text-(--ui-text-tertiary) hover:bg-(--chrome-action-hover) hover:text-foreground'
                        ),
                        title: 'Worst sessions first: most failed tool calls',
                        children: 'worst'
                      })
                    ]
                  }),
                  jsx('div', {
                    className: 'min-h-0 flex-1',
                    children: (searchLoading && searching) || (isLoading && !searching)
                      ? jsx('div', { className: 'p-4 text-sm text-(--ui-text-tertiary)', children: 'Loading…' })
                      : ((searchError && searching) || (error && !searching))
                        ? jsx('div', { className: 'p-4 text-sm text-(--ui-error)', children: `Failed: ${(error || searchError)?.message ?? error ?? searchError}` })
                        : jsx(SessionList, { sessions: searching ? searchResults.map(r => ({ ...r, id: r.session_id })) : sessions, selected, onSelect: (id) => $selected.set(id), searchMode: searching, showFailed: sort === 'failed' })
                  }),
                  !searching && sessions.length > 0 && list?.total > sessions.length
                    ? jsx('div', { className: 'border-t border-(--ui-stroke-secondary) p-1.5', children: jsx('button', {
                      type: 'button',
                      onClick: () => setLimit((n) => Math.min(500, n + 200)),
                      className: 'w-full rounded-md px-2 py-1 text-[0.625rem] font-medium text-(--ui-text-secondary) transition-colors hover:bg-(--chrome-action-hover) hover:text-foreground',
                      children: `Load more (${sessions.length} / ${list?.total})`
                    }) })
                    : null
                ]
              }),
              // Draggable divider — byte-for-byte the app's native sash
              // hover treatment: persistent hairline + a 0.25rem hover band
              // that fades in via opacity (--ui-sash-hover-border).
              jsx('div', {
                className: 'group relative z-20 w-[9px] shrink-0 cursor-col-resize bg-transparent',
                onPointerDown: startDrag,
                onPointerMove: onDragMove,
                onPointerUp: endDrag,
                onPointerCancel: endDrag,
                role: 'separator',
                'aria-orientation': 'vertical',
                children: jsxs('div', {
                  className: 'pointer-events-none absolute inset-y-0 left-1/2 -translate-x-1/2',
                  children: [
                    // Persistent hairline.
                    jsx('span', {
                      className: 'absolute bg-(--ui-stroke-secondary) opacity-10 transition-opacity duration-100 group-hover:opacity-100 inset-y-0 left-1/2 w-px -translate-x-1/2'
                    }),
                    // Hover band — byte-for-byte the native sash hover
                    // element: --ui-sash-hover-border, 0.25rem, opacity swap.
                    jsx('span', {
                      className: 'absolute bg-(--ui-sash-hover-border) opacity-0 transition-opacity duration-100 group-hover:opacity-100 inset-y-0 left-1/2 w-1 -translate-x-1/2'
                    })
                  ]
                })
              }),
              jsx('div', {
                className: 'min-h-0 flex-1 overflow-y-auto',
                children: detail
                  ? jsx(Detail, { session: detail, onOpenSession: (id) => $selected.set(id) })
                  : jsx('div', { className: 'flex h-full items-center justify-center text-sm text-(--ui-text-tertiary)', children: 'Select a session' })
              })
            ]
          }),
      jsx(ContextMenu, {})
    ]
  })
}

export default {
  id: ID,
  name: 'Session Analyzer',
  description: 'Per-session analytics: tool calls, token/cache usage, spend, files touched, search.',
  defaultEnabled: true,
  register(ctx) {
    rest = ctx.rest
    ctx.register({
      id: 'page',
      area: ROUTES_AREA,
      data: { path: '/session-dashboard' },
      render: () => jsx(Page, {})
    })
    ctx.register({
      id: 'nav',
      area: SIDEBAR_NAV_AREA,
      order: 60,
      data: { codicon: 'graph-line', label: 'Session Analyzer', path: '/session-dashboard' }
    })
    ctx.register({
      id: 'open',
      area: PALETTE_AREA,
      data: {
        id: 'session-dashboard.open',
        label: 'Session Analyzer: Open',
        keywords: ['sessions', 'analyzer', 'stats', 'dashboard', 'tokens', 'cost', 'usage', 'search'],
        run: () => host.navigate('/session-dashboard')
      }
    })
  }
}
