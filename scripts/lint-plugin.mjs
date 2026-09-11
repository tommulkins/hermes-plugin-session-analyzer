#!/usr/bin/env node
/**
 * Sign-off gate for the Session Analyzer plugin.
 *
 * Every rule here encodes a trap that has actually bitten this project, or a
 * documented failure mode from the authoring skill. They share one property:
 * the normal toolchain stays green while the app breaks at runtime. Run this
 * BEFORE copying either file to ~/.hermes/.
 *
 *   pnpm lint            errors fail, warnings are reported
 *   pnpm lint --strict   warnings fail too
 *
 * Rule ids match the numbers in the plugin-authoring skill.
 */
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";

const arg = (name, fallback) => {
  const i = process.argv.indexOf(name);
  return i >= 0 && process.argv[i + 1] ? process.argv[i + 1] : fallback;
};

const JS = arg("--js", "desktop-plugins/session-dashboard/plugin.js");
const PY = arg("--py", "plugins/session-dashboard/dashboard/plugin_api.py");
const strict = process.argv.includes("--strict");

const results = [];
const add = (id, severity, file, line, message) =>
  results.push({ id, severity, file, line, message });

/** Run a formatter/compiler for its syntax verdict only. */
function syntaxOk(cmd, args, id, file) {
  try {
    execFileSync(cmd, args, { stdio: "pipe" });
  } catch (err) {
    const out = `${err.stdout ?? ""}${err.stderr ?? ""}`.trim().split("\n")[0];
    add(id, "error", file, null, `does not parse: ${out}`);
  }
}

/**
 * Compile as an ES module WITHOUT executing it.
 *
 * `node --check` is not sufficient: with Node 22's module detection it exits 0
 * on some unterminated-block errors (verified: `export default { a: 1` with no
 * closing brace passes --check), which is exactly the class of typo that makes
 * the app refuse the file. vm.SourceTextModule parses it for real.
 */
function parseEsm(file, id) {
  const script = `
    const fs = require("node:fs"), vm = require("node:vm");
    try {
      new vm.SourceTextModule(fs.readFileSync(process.argv[1], "utf8"), {
        identifier: process.argv[1],
      });
    } catch (error) {
      console.error(error.message);
      process.exit(1);
    }
  `;
  try {
    execFileSync(
      process.execPath,
      ["--experimental-vm-modules", "--no-warnings", "-e", script, file],
      { stdio: "pipe" },
    );
  } catch (err) {
    const out = `${err.stdout ?? ""}${err.stderr ?? ""}`.trim().split("\n")[0];
    add(id, "error", file, null, `does not parse: ${out}`);
  }
}

const lines = (src) => src.split("\n");
const each = (src, re, fn) => {
  for (const m of src.matchAll(re)) {
    fn(m, src.slice(0, m.index).split("\n").length);
  }
};

/**
 * Blank out comments, preserving line numbers.
 *
 * Every rule except J1 must read CODE, not prose: these files are heavily
 * commented with the very traps the rules look for ("group-hover:… never
 * exists in the shipped stylesheet" is a COMMENT explaining the fix, not a
 * use of it). J1 is the deliberate exception — the runtime loader scans raw
 * text, so it runs on the unstripped source.
 */
const stripJsComments = (src) =>
  src
    .split("\n")
    .map((line) => {
      const i = line.indexOf("//");
      // Keep URL-ish sequences (`https://`) intact.
      const cut = i >= 0 && line[i - 1] !== ":" ? i : -1;
      return cut >= 0 ? line.slice(0, cut) : line;
    })
    .join("\n")
    .replace(/\/\*[\s\S]*?\*\//g, "");

const stripPyComments = (src) =>
  src
    .split("\n")
    .map((line) => {
      const i = line.indexOf("#");
      return i >= 0 ? line.slice(0, i) : line;
    })
    .join("\n");

// ---------------------------------------------------------------------------
// JS: syntax, then the loader contract, then documented UI traps
// ---------------------------------------------------------------------------
const js = readFileSync(JS, "utf8");
const jsCode = stripJsComments(js);

syntaxOk("python3", ["-m", "py_compile", PY], "P0", PY);
parseEsm(JS, "J0");

// J1 — the runtime loader scans the WHOLE file (prose included) for bare import
// specifiers; anything unmapped makes it throw and the plugin never registers.
// Runs on the RAW source on purpose: the loader reads comments too.
const SPECIFIER_RE = /(from\s*|import\s*\(\s*|import\s+)(['"])([^'"]+)\2/g;
const ALLOWED = new Set([
  "@hermes/plugin-sdk",
  "react",
  "react/jsx-runtime",
  "react/jsx-dev-runtime",
]);
each(js, SPECIFIER_RE, (m, ln) => {
  const spec = m[3];
  if (/^[./]/.test(spec) || /^[a-z][a-z0-9+.-]*:/i.test(spec)) return;
  if (ALLOWED.has(spec)) return;
  add(
    "J1",
    "error",
    JS,
    ln,
    `bare specifier ${JSON.stringify(spec.slice(0, 60))} — the loader refuses this file (prose ending in an import preposition before a quote reads as an import)`,
  );
});

// J2 — group-hover: is not in the packaged app's CSS; hover must be React state.
each(jsCode, /group-hover:/g, (_m, ln) =>
  add(
    "J2",
    "error",
    JS,
    ln,
    "group-hover: is absent from the packaged CSS — use React state (onPointerEnter/Leave)",
  ),
);

// J3 — bg-(--ui-bg) is transparent; elevated surfaces need the -elevated token.
each(jsCode, /bg-\(--ui-bg\)/g, (_m, ln) =>
  add(
    "J3",
    "error",
    JS,
    ln,
    "bg-(--ui-bg) is transparent — use bg-(--ui-bg-elevated)",
  ),
);

// J4 — a native search input renders its own clear button, doubling a custom ✕.
each(jsCode, /type:\s*["']search["']/g, (_m, ln) =>
  add(
    "J4",
    "error",
    JS,
    ln,
    'type="search" adds a native clear button — use "text"',
  ),
);

// J5 — a hook after an early return violates the rules of hooks and kills the
// pane on hot-reload. Only shallow occurrences are considered, so callbacks
// inside JSX (deep) never trigger this.
const HOOK_RE =
  /\b(useValue|useQuery|useMutation|useState|useEffect|useMemo|useRef|useCallback|useStore)\s*\(/;
{
  const srcLines = lines(jsCode);
  let inFunction = false;
  let onSignature = false;
  let fnName = "";
  let bodyDepth = 0;
  let earlyReturn = null;
  for (let i = 0; i < srcLines.length; i += 1) {
    const line = srcLines[i];
    if (!inFunction) {
      const m = line.match(/^\s*function\s+([A-Za-z_$][\w$]*)\s*\(/);
      if (!m) continue;
      inFunction = true;
      onSignature = true;
      fnName = m[1];
      bodyDepth = 0;
      earlyReturn = null;
      // fall through: this line's `{` opens the body and must be counted
    }
    for (const ch of line) {
      if (ch === "{") bodyDepth += 1;
      else if (ch === "}") bodyDepth -= 1;
    }
    if (onSignature) {
      onSignature = false;
      continue;
    }
    const shallow = bodyDepth <= 2;
    // A one-line arrow body (`const f = () => { return x }`) is not an early
    // return of the enclosing component — ignore returns on arrow lines.
    if (
      shallow &&
      /\breturn\b/.test(line) &&
      !/=>/.test(line) &&
      earlyReturn === null
    ) {
      earlyReturn = i;
    }
    if (
      shallow &&
      HOOK_RE.test(line) &&
      earlyReturn !== null &&
      i > earlyReturn
    ) {
      add(
        "J5",
        "error",
        JS,
        i + 1,
        `${fnName}: hook called after an early return (line ${earlyReturn + 1}) — call all hooks before any return`,
      );
    }
    if (bodyDepth <= 0) {
      inFunction = false;
    }
  }
}

// J6 — arbitrary Tailwind sizing is not in the packaged CSS; interaction-critical
// geometry must be inline styles. Warning: read-only display sizes are fine.
each(jsCode, /(?<![\w-])(w|h|min-w|min-h|max-w|max-h)-\[/g, (m, ln) =>
  add(
    "J6",
    "warn",
    JS,
    ln,
    `arbitrary class ${m[0]}… may be absent from the packaged CSS — inline style if it drives hit-testing`,
  ),
);

// J7 — pointer-events-none on a wrapper can leave nothing hit-testable.
each(jsCode, /pointer-events-none/g, (_m, ln) =>
  add(
    "J7",
    "warn",
    JS,
    ln,
    "pointer-events-none — verify something inside stays hit-testable (the v0.2.1 sash bug)",
  ),
);

// ---------------------------------------------------------------------------
// Python: syntax, read-only guarantee, and the two query traps
// ---------------------------------------------------------------------------
const py = readFileSync(PY, "utf8");
const pyCode = stripPyComments(py);

each(
  pyCode,
  /\b(INSERT\s+INTO|DELETE\s+FROM|DROP\s+TABLE|ALTER\s+TABLE|UPDATE\s+\w+\s+SET|CREATE\s+TABLE)\b/gi,
  (m, ln) =>
    add(
      "P1",
      "error",
      PY,
      ln,
      `write statement ${m[0]} — this backend must stay read-only`,
    ),
);

// messages.reasoning and .reasoning_content usually hold the SAME text; adding
// both lengths double-counts. Take MAX per row. SQL is written as concatenated
// string literals, so quotes/newlines may sit between the two LENGTH(...) calls.
each(
  pyCode,
  /LENGTH\(\s*COALESCE\(\s*reasoning[^)]*\)\s*\)[\s"'+]*\+[\s"'+]*LENGTH\(\s*COALESCE\(\s*reasoning_content|LENGTH\(\s*COALESCE\(\s*reasoning_content[^)]*\)\s*\)[\s"'+]*\+[\s"'+]*LENGTH\(\s*COALESCE\(\s*reasoning/gs,
  (_m, ln) =>
    add(
      "P2",
      "error",
      PY,
      ln,
      "reasoning + reasoning_content summed — double-counts duplicated text; use MAX(LENGTH(a), LENGTH(b))",
    ),
);

// snippet() cannot be combined with GROUP BY **in one query**. Checked per
// function: a file-wide check false-positives because different endpoints use
// each independently.
{
  const bodies = pyCode.split(/^(?=(?:async\s+)?def\s)/m);
  for (const body of bodies) {
    if (/snippet\s*\(/.test(body) && /GROUP\s+BY/i.test(body)) {
      const name = (body.match(/^(?:async\s+)?def\s+(\w+)/) || [])[1] || "?";
      add(
        "P2b",
        "error",
        PY,
        null,
        `snippet() combined with GROUP BY in ${name}() — incompatible, aggregate in Python`,
      );
    }
  }
}

if (!/mode=ro/.test(py)) {
  add(
    "P3",
    "error",
    PY,
    null,
    "state.db must be opened read-only (file:…?mode=ro)",
  );
}

// ---------------------------------------------------------------------------
// Report
// ---------------------------------------------------------------------------
const errors = results.filter((r) => r.severity === "error");
const warns = results.filter((r) => r.severity === "warn");
const fmt = (r) =>
  `  ${r.severity === "error" ? "✗" : "!"} [${r.id}] ${r.file}${r.line ? `:${r.line}` : ""} — ${r.message}`;

if (results.length === 0) {
  console.log(`✓ plugin lint clean — ${JS} + ${PY}`);
  process.exit(0);
}

if (errors.length)
  console.log(`ERRORS (${errors.length}):\n${errors.map(fmt).join("\n")}`);
if (warns.length)
  console.log(
    `${errors.length ? "\n" : ""}WARNINGS (${warns.length}):\n${warns.map(fmt).join("\n")}`,
  );
console.log(`\n${errors.length} error(s), ${warns.length} warning(s)`);
process.exit(errors.length > 0 || (strict && warns.length > 0) ? 1 : 0);
