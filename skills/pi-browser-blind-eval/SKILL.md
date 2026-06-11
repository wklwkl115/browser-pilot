---
name: pi-browser-blind-eval
description: "Run the standing BLIND-AGENT eval loop for pi-browser-tools — the mature-maintenance optimization driver. Use when you want real-agent friction signal on the tool surface (not smokes / not self-justified scripted runs). The agent reads the pi-browser-tools skill (the project is skill-guided), works against a REAL, mainland-China-reachable website (READ-ONLY), and is blind to the implementation source. Harvest its command-log + friction reports, triage findings (fixable | WAI | reliability) plus skill↔tool fidelity, and distill confirmed fixable ones into work items / deterministic regressions. Operator-driven; schedulable via cron. NOT for writing tool code, and NOT the deterministic runner (that is `npm run eval:browser-workflows`)."
license: MIT
compatibility: pi-browser-tools repo; built CLI (`dist/cli/bin.js`) + a local Chrome/Edge with the extension + internet on a mainland-China network. Complements the deterministic runner.
---

# Pi Browser Blind-Agent Eval

The standing **discovery** layer of the eval loop. The deterministic runner (`npm run
eval:browser-workflows`) replays *human-authored* tool sequences against *local fixtures* and asserts —
it guards regressions but **cannot find new friction**, and its "the runner used X not Y" notes are the
author asserting good behavior (the self-justification trap). This skill instead lets an agent that
operates **exactly like a real Pi agent** discover where the tool actually hurts.

## Invariants (do not violate)

- **Real sites, China-reachable.** Target REAL public websites, NOT self-written/local fixtures (they
  are not representative). The agent's browser is on a **mainland-China** network — pick only
  China-reachable targets from `blind-tasks-realsite.md`; AVOID GFW-blocked/flaky (Google, Wikipedia,
  Reddit, X, YouTube, Facebook, often HN). The operator's own open tabs are a reachability oracle.
- **Skill-guided, implementation-blind.** The agent MUST read `skills/pi-browser-tools/SKILL.md` as its
  operating guide (the project is skill-guided). "Blind" = blind to the IMPLEMENTATION (never reads
  `src/`/`bridge_src/`/`cli/`/`bridge/`/runner/specs/answer-keys/schema), NOT blind to the skill.
  Friction found is "friction that survives the skill" = real production signal — and the agent also
  reports skill↔tool fidelity (skill guidance that didn't match actual behavior).
- **READ-ONLY on real sites.** No login, form submit, post/reply/vote, purchase, or any
  state-changing request. Read, scan, extract only.
- **Isolated.** The agent drives the tool ONLY through `node evals/browser-workflows/pb-blind.mjs …`,
  which pins it to the isolated stage daemon and hard-caps each forwarded CLI call at 300000ms by
  default (`PI_BROWSER_BLIND_CLI_TIMEOUT_MS=<positive-ms>` may override one run). It never sees the
  operator's real browser. Verify isolation before fanning out (the stage daemon must list only the
  stage's own tab).
- **Honest, n>1.** Don't conclude from one run. Re-run a finding with a second agent / a second site.
- **True defect, no overfit (core).** Only fix what is a TRUE, GENERAL project defect — confirmed root
  cause that generalizes, not noise. No change-for-change; no special-casing the site/DOM/task/shape
  that surfaced it; the fix + its regression must be general (synthetic/representative inputs, not the
  live page); a tuned threshold must be principled/bounded, never fitted to make one case pass. A
  change that narrows generality is worse than the friction.
- **Do NOT fix execution-authoring friction.** "Had to hand-write the click/form-fill JS, no
  click/type helper" is WORKING-AS-INTENDED — tag `WAI`, never add an execution verb/helper.

## Procedure

1. **Prereqs**: `dist/cli/bin.js` built; a local Chrome/Edge; internet (mainland-China). The operator's
   own browser may be running — isolation handles it.
2. **Pick a target** from `blind-tasks-realsite.md` (each entry is China-reachable + read-only). Note
   its `url` and `goal` (the goal is what the blind agent gets).
3. **Launch the stage** at that site (opt-in):
   `node evals/browser-workflows/launch-blind.mjs --confirm --url <SITE_URL>`. In real-site mode the
   launcher writes `.pi/browser-artifacts/eval-blind/stage.json` then exits (the detached daemon +
   browser persist). Wait for that file.
4. **Pre-flight reachability + isolation**:
   `node evals/browser-workflows/pb-blind.mjs tabs --action list --json` → must show ONLY the stage's
   own tab. Then `pb-blind.mjs observe --mode scan --tab-id <id>` → if `url` is `chrome-error://…` the
   site did NOT load on this network; tear down and pick another China-reachable target.
5. **Launch ONE blind child agent per target** using `blind-agent-prompt.md`, filling `{{TAB_ID}}` /
   `{{SITE_URL}}` / `{{GOAL}}` — via **your own harness's child-agent mechanism** (see "Launching the
   blind agent" below). Run independent targets in parallel if your harness supports concurrent
   child runs.
6. **Grade + triage** the returned report: did it complete the task? tool path / call count /
   first-wrong-tool-choice? For CLI natural-routing work, also record whether action-style `wait` /
   `network` / `frame` / `hook` calls used natural subcommands (`wait selector`,
   `wait network-idle`, `network list`, `network export-har`, `frame list`, `frame evaluate`,
   `hook install-targets`, `hook collect`) or fell back to legacy `--action` / `--params`, and why.
   For memory-kernel runs, require a **MEMORY ADOPTION** block with the six fields:
   `memoryPlaneSeen`, `inlineBodyUsed`, `readThroughUsed`, `recordNudgeShown`, `recordCalled`,
   `usedInFinalAnswer`; operator-verify each true value against the transcript.
   Triage each friction item `fixable | WAI | reliability`, AND record skill↔tool fidelity gaps.
   Append to
   `evals/browser-workflows/blind-findings.md` (dedupe; bump the cross-run count when a finding recurs
   across agents/sites).
7. **Distill — but gate the fix.** Before writing any code, clear the true-defect/no-overfit gates
   (the Invariants above): (a) confirmed root cause that GENERALIZES (n≥2 across
   different agent+task+site, not a one-off); (b) the fix measurably improves real outcomes, not
   change-for-change; (c) the fix AND its regression are GENERAL — no special-casing the site/DOM/task/
   shape that surfaced it, regression uses synthetic/representative inputs (never the live page), any
   threshold principled/bounded by an existing safety layer. If a finding can't clear the gates, leave
   it in `blind-findings.md` as "needs more runs" — do NOT patch. When cleared: a `fixable`/
   `reliability` finding becomes a work item; where it is a deterministic output behavior, seed a new
   assertion in the deterministic runner so the fix is regression-guarded without an agent. A
   skill-fidelity gap becomes a `pi-browser-tools` skill edit.
8. **Teardown ALWAYS**: `node evals/browser-workflows/teardown-blind.mjs` (even on failure).

## Launching the blind agent (harness-agnostic)

This project is developed with different operator agents (Claude Code, Codex, Pi, others), and each
has a different child-agent mechanism. The blind run is defined by **isolation properties, not by any
specific mechanism** — use whatever your harness provides, as long as ALL of these hold:

- **Fresh context**: the child starts with ONLY the filled prompt — it must NOT inherit the
  operator's conversation (your context contains implementation knowledge, plans, and findings;
  inheriting it un-blinds the run).
- **Shell + file read**: the child can run `node evals/browser-workflows/pb-blind.mjs …` and read
  `skills/pi-browser-tools/SKILL.md` (Step 0 of the prompt).
- **Report return**: the child's final report comes back to you verbatim for grading (step 6).
- **Implementation blindness**: enforced by the prompt's FORBIDDEN list; if your harness can also
  restrict the child's readable paths, do so as defense in depth.

Mechanism mapping (examples, not exhaustive):

- **Claude Code**: the `Agent` tool (general-purpose subagent), one call per target; put multiple
  calls in one message for parallel targets.
- **Codex / CLI-only harnesses**: start a FRESH non-interactive session of the same agent binary
  (e.g. `codex exec` or equivalent) with the filled prompt file as its sole input; capture its final
  output as the report.
- **Pi**: a fresh Pi subagent/session given only the filled prompt.
- **No child mechanism at all**: launch a separate fresh agent process yourself (new conversation,
  prompt file in, transcript out). The process boundary IS the isolation.

If you cannot create a fresh-context run at all, **do not run the eval inline in your own
implementation-aware context** — an un-blind run is self-justification and is worse than no data.
Record "blind run unavailable on this harness" in `blind-findings.md` instead.

## Scheduling (常驻)

Schedule any agent harness that can invoke this skill on a cadence (cron, the harness's scheduler,
etc.): pick targets → launch → pre-flight → run → write `blind-findings.md` → teardown. Keep runs
bounded (a handful of sites) so token cost stays predictable.

## Files

- `launch-blind.mjs` (`--url <site>` real-site; `--fixtures` opt-in local) / `teardown-blind.mjs` —
  isolated stage lifecycle.
- `pb-blind.mjs` — shell-agnostic CLI wrapper pinned to the stage (what blind agents call).
- `blind-agent-prompt.md` — the blind prompt template (Step 0 = read the skill; real-site; read-only).
- `blind-tasks-realsite.md` — China-reachable read-only real-site task bank.
- `blind-findings.md` — the rolling triaged friction + skill-fidelity backlog (this loop's product).
