/**
 * Fixture for lint-plugin.mjs — one deliberate violation per rule.
 * Every rule must fire on this file; if one stops firing, the rule has rotted.
 * (jsx() calls only, no JSX syntax, so the file still parses — J0 is covered
 * separately by the syntax rule.)
 */
import { atom, Badge, host, useValue } from "@hermes/plugin-sdk";
import { jsx } from "react/jsx-runtime";

// J2 — group-hover must be React state.
const hoverClass = "group-hover:opacity-100";

// J3 — transparent surface token.
const surface = "bg-(--ui-bg) rounded-md";

// J6 / J7 — advisories.
const geometry = "w-[9px] min-w-[200px] pointer-events-none";

function Panel() {
  const v = useValue(atom(null));
  if (!v) return null;
  // J5 — hook after an early return.
  const other = useValue(atom(0));
  return jsx("div", { children: [v, other, hoverClass, surface, geometry] });
}

function Search() {
  // J4 — native clear button doubles a custom one.
  return jsx("input", { type: "search", onChange: () => {} });
}

// J1 — prose ending in an import preposition before a quote reads as an import.
const label = {
  a: "spawned by",
  b: "continues from",
  c: "came from",
};

export default {
  id: "lint-fixture",
  name: "Lint Fixture",
  register(ctx) {
    ctx.register({
      id: "p",
      area: "panes",
      data: { label: label.b },
      render: Panel,
    });
    void Search;
    void host;
    void Badge;
  },
};
