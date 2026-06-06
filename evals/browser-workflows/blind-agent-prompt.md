# Blind-agent eval prompt template

The `pi-browser-blind-eval` skill fills the placeholders and spawns one subagent per task. The agent
is **blind to the implementation** (never reads tool source), but operates exactly like a real Pi
agent: it **reads the `pi-browser-tools` skill as its operating guide** and works against a **real
website**. The friction it reports is therefore "friction that survives the skill" — real production
signal, not CLI-in-a-vacuum.

Placeholders: `{{TAB_ID}}`, `{{SITE_URL}}`, `{{GOAL}}`. The CLI is always
`node evals/browser-workflows/pb-blind.mjs` (the wrapper scopes it to the isolated stage).

---

You are a Pi agent operating a live browser through a CLI to accomplish a real task on a real website,
then report back. You are NOT the tool's author — you have never seen its source.

## Step 0 — read your operating guide (required, do this first)
Read `skills/pi-browser-tools/SKILL.md` — this is the skill that guides how you use these tools. Use it
as your primary guidance (routes, the observe→execute→wait loop, memory habits, etc.). You MAY also
read any HOW/methodology doc it links from its Index.
- FORBIDDEN: reading the tool's IMPLEMENTATION to reverse-engineer it — no `src/`, `bridge_src/`,
  `cli/`, `bridge/`, no eval `runner.mjs`/specs/answer-keys, no protocol schema. You learn the tools
  from the SKILL + `--help` + the JSON each command returns, exactly as a real agent would.

## The CLI
Invoke it as: `node evals/browser-workflows/pb-blind.mjs <subcommand> [--flags]` from the current dir.
The skill describes these as `browser_*` tools / `pi-browser <cmd>` subcommands; here the subcommand is
the same (drop `browser_`, `_`→`-`). Output is JSON (non-TTY) — parse it. `--help` and `<cmd> --help`
list flags.

## Your task (real website)
A browser tab is open: tabId **{{TAB_ID}}**, URL **{{SITE_URL}}**.
{{GOAL}}

## Safety constraints (CRITICAL — violating these is a failure)
- Operate ONLY on tabId {{TAB_ID}}; pass it explicitly to every command that accepts one.
- NEVER switch/create/close tabs or act on any other tab.
- **Real site = READ-ONLY**: do not submit forms, log in, post, comment, purchase, or trigger any
  state-changing/side-effecting request. Read, scan, extract. Navigation only within {{SITE_URL}}'s
  site if the task needs it (the tabId may change on navigation — re-read it from `tabs list`).
- If stuck after ~15 commands, stop and report.

## What to return (the product — precise + honest)
1. **ANSWER**: the result the task asked for, or "FAILED" + why.
2. **COMMAND LOG**: every CLI command in order; each with a one-line note on what its output gave you
   and whether it succeeded / errored / surprised you.
3. **FRICTION**: every confusion, wrong guess, schema/usage error, retry, hard-to-parse output, or
   "wished it behaved differently" — **AND** specifically: did the skill's guidance match the tool's
   actual behavior? Anything the skill told you to do that didn't work, or that the skill should have
   warned you about? Quote errors/flags. Smooth parts: say so. THIS SECTION IS THE MOST VALUABLE — do
   not soften it.
4. **VERDICT**: with the skill + `--help` + JSON output, could a real agent finish this on this site?
   yes / partially / no — and the single biggest improvement (to the TOOL or the SKILL — say which).

Work the task now. Be economical but complete.
