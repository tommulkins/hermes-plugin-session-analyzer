#!/usr/bin/env node
/**
 * Pre-sync gate for desktop plugin.js.
 *
 * The desktop runtime loader (apps/desktop/src/contrib/runtime-loader.ts)
 * scans the ENTIRE plugin source — string literals and comments included —
 * for bare import specifiers:
 *
 *   /(from\s*|import\s*\(\s*|import\s+)(['"])([^'"]+)\2/g
 *
 * Anything it finds that is not @hermes/plugin-sdk / react / react/jsx-runtime
 * / react/jsx-dev-runtime makes it throw "unsupported import(s): ..." and the
 * plugin HARD-FAILS to load. Because the regex is not anchored to real import
 * syntax, ordinary prose can trip it: a label or sentence ending in the
 * preposition that opens an import clause, followed by a quote, reads as a
 * specifier. `node --check`, prettier and py_compile all pass on such a file —
 * the app is the only thing that notices.
 *
 * Run this before copying plugin.js to ~/.hermes/desktop-plugins/.
 */
import { readFileSync } from "node:fs";

const SPECIFIER_RE = /(from\s*|import\s*\(\s*|import\s+)(['"])([^'"]+)\2/g;
const ALLOWED = new Set([
  "@hermes/plugin-sdk",
  "react",
  "react/jsx-runtime",
  "react/jsx-dev-runtime",
]);

const files = process.argv.slice(2);
if (files.length === 0) {
  console.error("usage: check-plugin-load.mjs <plugin.js> [...]");
  process.exit(2);
}

let failed = false;

for (const file of files) {
  const source = readFileSync(file, "utf8");
  const bad = [];

  for (const m of source.matchAll(SPECIFIER_RE)) {
    const spec = m[3];
    // Relative/absolute paths and URL schemes resolve on their own.
    if (/^[./]/.test(spec) || /^[a-z][a-z0-9+.-]*:/i.test(spec)) continue;
    if (ALLOWED.has(spec)) continue;
    const line = source.slice(0, m.index).split("\n").length;
    bad.push({ line, spec });
  }

  if (bad.length > 0) {
    failed = true;
    console.error(`✗ ${file} — the runtime loader would refuse this file:`);
    for (const { line, spec } of bad) {
      console.error(`    line ${line}: bare specifier ${JSON.stringify(spec.slice(0, 80))}`);
    }
    console.error("  Reword the prose so it does not read as an import.");
  } else {
    console.log(`✓ ${file} — loader-safe`);
  }
}

process.exit(failed ? 1 : 0);
