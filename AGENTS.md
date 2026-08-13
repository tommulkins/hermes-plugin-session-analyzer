# AGENTS.md — Dependency Policy

## Gates BEFORE install (mandatory)

Before ANY package install, update, or removal in this repo, run the
supply-chain gates in order. Never install first and audit after. The
agent's non-interactive shell does not get the user's aliases, so
enforcement is the agent's job.

1. Capture current vulnerabilities (exemption data for the age gate):
   `osv-gate --json . > /tmp/osv-fix.json`
2. Age gate — blocks releases younger than 14 days; auto-exempts a young
   version that is the published fix for a flagged advisory:
   `PKG_AGE_VULN_FIX=/tmp/osv-fix.json pkg-age-gate <manager> <sub> <specs...>`
3. Risk scan and install through Socket:
   `sfw <manager> <sub> <specs...>`
4. Known-vulnerability gate before commit:
   `osv-gate .`

## Standing rules

- pnpm is the default JS/TS package manager unless this repo dictates
  otherwise (existing lockfile format, npm workspaces). Keep pnpm 10+'s
  postinstall-script blocking; approve builds explicitly with
  `pnpm approve-builds` when a package genuinely needs them.
- Lockfiles are committed in the same commit as manifest changes. Never
  delete or .gitignore them.
- No dependency whose release is younger than 14 days (age gate enforces).
- No known-vulnerable version (osv-gate enforces).
- `PKG_AGE_BYPASS=1` is a loud manual override: log it in the commit
  message when used.

## Tool locations

- `pkg-age-gate`, `osv-gate`, `audit-project`, `selftest`:
  `~/.hermes/skills/supply-chain-hygiene/scripts/`
  (`pkg-age-gate` also synced to `~/.local/bin/pkg-age-gate`)
- `osv-scanner`: `~/.local/bin/osv-scanner`
- `sfw`: Socket CLI
- Full policy: the `supply-chain-hygiene` Hermes skill
  (github.com/tommulkins/hermes-skill-supply-chain-hygiene)

## Audit

Before opening a PR or after any dependency change:

- `audit-project .` — exit 0 = clean (lockfile, manager, ages, sfw)
- `osv-gate .` — exit 0 = no known vulnerabilities
