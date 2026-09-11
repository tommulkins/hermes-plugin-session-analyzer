/**
 * Guards the linter itself: every rule must still fire on the fixtures.
 *
 * Rules that stop matching rot silently — the linter keeps reporting "clean"
 * while the trap it encodes comes back. Run with `pnpm lint:test`.
 */
import { execFileSync } from "node:child_process";
import assert from "node:assert/strict";
import { test } from "node:test";

const run = (args) => {
  try {
    const stdout = execFileSync(
      process.execPath,
      ["scripts/lint-plugin.mjs", ...args],
      {
        encoding: "utf8",
        stdio: ["ignore", "pipe", "pipe"],
      },
    );
    return { code: 0, out: stdout };
  } catch (err) {
    return { code: err.status, out: `${err.stdout ?? ""}${err.stderr ?? ""}` };
  }
};

const JS_FIXTURE = "scripts/fixtures/bad-plugin.js";
const PY_FIXTURE = "scripts/fixtures/bad-plugin_api.py";

test("every content rule fires on the violation fixtures", () => {
  const { code, out } = run(["--js", JS_FIXTURE, "--py", PY_FIXTURE]);
  assert.equal(code, 1, "fixtures must fail the lint");
  for (const id of [
    "J1",
    "J2",
    "J3",
    "J4",
    "J5",
    "J6",
    "J7",
    "P1",
    "P2",
    "P2b",
    "P3",
  ]) {
    assert.match(out, new RegExp(`\\[${id}\\]`), `rule ${id} did not fire`);
  }
});

test("a syntax error is reported as J0", () => {
  const { code, out } = run([
    "--js",
    "scripts/fixtures/broken-plugin.js",
    "--py",
    PY_FIXTURE,
  ]);
  assert.equal(code, 1);
  assert.match(out, /\[J0\]/, "J0 did not fire on an unparseable file");
});

test("the real plugin and backend pass with no errors", () => {
  const { code, out } = run([]);
  assert.equal(code, 0, `real tree should lint clean:\n${out}`);
  assert.match(out, /0 error\(s\)/);
});
