---
__cgxx: |
  # vim:set expandtab shiftwidth=2 filetype=markdown foldlevel=3:
  # SPDX-License-Identifier: GPL-3.0-only

  #
  #
  # ~chewygumxx/dorothy-hermes.git
  # ::: :/docs/agents/subagent-ledger.md
  #
  #

ctime: 2026-10-03
title: Subagent ledger protocol
description: "How subagents record work so an interrupted run is recoverable"
tags:
  - agents
  - llm
  - claude
---

# Subagent ledger protocol

A subagent can stop at any moment: a usage limit, an exhausted context, a
crash. Its final message is normally the only thing its parent receives, so
an interrupted agent hands back nothing, however much it learned. Under this
protocol an agent writes its work to disk as it goes, in a form a parent (or a
fresh agent) can reduce, filter and resume from, without reloading the dead
agent's context.

Nothing here is specific to one repository.

## Where the ledger lives

```text
${XDG_STATE_HOME:-$HOME/.local/state}/agent-ledger/<project>/<run>/
  <agent>.jsonl           append-only records (the source of truth)
  <agent>.checkpoint.md   rewritten summary for a quick resume
  artifacts/              evidence too long for a record
```

- `<project>` is the repository's directory name; `<run>` is
  `<YYYYMMDD-HHMMSS>-<slug>`, for example `20261003-1630-plan-review`.
- The parent creates the run directory and passes its absolute path in the
  brief. Each agent writes only its own files, so concurrent agents never
  interleave.

Why not the alternatives:

| Option                       | Problem                                                                 |
| ---------------------------- | ----------------------------------------------------------------------- |
| `/tmp/claude-<uid>/...`      | Owned by the harness and on tmpfs: cleared on reboot or by cleanup      |
| Commits in a worktree        | Each record runs commit hooks, adds history noise, needs a writable checkout; reviewers should be read-only |
| Files tracked in the repo    | Pollutes diffs and lint runs; secrets risk                              |
| Harness transcript           | Durable, but mostly raw tool output in an internal format: recovery of last resort |

Worktree commits remain right for agents whose output is code: the code
goes in commits, while the ledger records reasoning and findings.

## Records

One JSON object per line. Never edit or delete a line: corrections are new
records with the same `id`, and the latest wins.

| Field      | Meaning                                                             |
| ---------- | ------------------------------------------------------------------- |
| `ts`       | ISO 8601 time                                                       |
| `agent`    | the agent's name from the brief                                     |
| `kind`     | `plan`, `covered`, `finding`, `update`, `note` or `done`            |
| `id`       | `F001`... for findings and their updates; scope item name for `covered` |
| `severity` | `blocker`, `should-fix` or `nit` (findings)                         |
| `status`   | `unverified`, `confirmed` or `refuted` (findings)                   |
| `where`    | file and line, task and step, or URL                                |
| `claim`    | one sentence: what is wrong or what was learned                     |
| `evidence` | at most 15 lines quoted, or `artifacts/<file>`                      |
| `fix`      | the concrete remedy                                                 |
| `items`    | `plan` only: the scope items, in order                              |

Append with `jq`, which guarantees valid JSON and escaping:

```sh
ledger=/abs/path/to/run/reviewer.jsonl
rec() { jq -nc --arg ts "$(date -u +%FT%TZ)" --arg agent reviewer "$@" \
  '$ARGS.named' >> "$ledger"; }
rec --arg kind finding --arg id F003 --arg severity blocker \
  --arg status unverified --arg where 'plan Task 6 Step 3' \
  --arg claim 'dumpDatabase misses ...' --arg evidence '...' --arg fix '...'
```

`$ARGS.named` turns every `--arg` into a field; `items` can be passed as
`--argjson items '["a","b"]'`. One `>>` per record keeps each line whole.

## Working rhythm

1. **Plan first.** The first write is a `plan` record listing the scope
   items. Coverage is then measurable, and a resume knows what remains.
2. **Breadth before depth.** Record each suspicion as an `unverified`
   finding the moment it appears, before investigating it. A cut-off
   agent then leaves leads, not nothing.
3. **Verify in a second pass.** Append an `update` per finding:
   `confirmed`, `refuted` (with the reason in `claim`), or a changed
   severity.
4. **Mark coverage.** After finishing a scope item, append `covered` with
   its name, even when it produced no findings.
5. **Checkpoint.** After each scope item, rewrite `<agent>.checkpoint.md`
   (write a temporary file, then `mv` it over): done, in progress, next,
   open questions; at most 40 lines.
6. **Finish.** Append `done`, then end with a final message: confirmed
   findings ranked, counts of unverified and refuted ones, and the ledger
   path. The ledger holds the detail, so the message can be short.

Keep records small. Long command output, diffs or logs go to
`artifacts/<id>-<slug>.txt`, referenced from `evidence`. Never write secret
values into a ledger.

## Nested agents

An agent that spawns its own subagents passes the same run directory and a
derived name (`reviewer.dump`). Before finishing, it reduces each child's
ledger into its own, adding `"source": "<child>"`, so the parent reads one
file.

## Recovery

When an agent stops without a `done` record:

```sh
cd "${XDG_STATE_HOME:-$HOME/.local/state}/agent-ledger/<project>/<run>"
cat reviewer.checkpoint.md
# Latest state of every finding, refuted ones dropped, most severe first:
jq -s 'map(select(.id and (.kind == "finding" or .kind == "update")))
  | group_by(.id) | map(reduce .[] as $r ({}; . * $r))
  | map(select(.status != "refuted"))
  | sort_by({"blocker": 0, "should-fix": 1, "nit": 2}[.severity] // 3)' \
  reviewer.jsonl
# Scope items finished:
jq -r 'select(.kind == "covered") | .id' reviewer.jsonl
```

Then choose:

- **Integrate.** If the remaining scope is small, act on the confirmed
  findings directly.
- **Relaunch fresh.** Brief a new agent with the same ledger: "continue
  `<run>/<agent>.jsonl`; skip covered items; verify unverified findings
  first". This costs a fresh context instead of reloading the dead one.
- **Resume the original.** Messaging the stopped agent keeps its context,
  but re-reads all of it; worth it only for a small context.

The harness transcript (`<config>/projects/<project>/<session>/subagents/agent-<id>.jsonl`)
is the last resort. Extract assistant text only, capped, and never read it
whole: tool results dominate its size.

## Retention

Keep a run until its findings are integrated or rejected, then delete the
run directory with the system trash tool. Ledgers are scratch, not records:
anything worth keeping moves into the repository's documents.

## Brief to paste into an agent prompt

```text
Record your work in a ledger as you go; you may be stopped at any moment
and your final message lost. Follow the subagent ledger protocol:
- Ledger: <RUN_DIR>/<AGENT>.jsonl (append-only JSON lines, written with
  jq -nc ... >> file); checkpoint: <RUN_DIR>/<AGENT>.checkpoint.md;
  long evidence: <RUN_DIR>/artifacts/.
- First write a "plan" record listing your scope items.
- Record every suspicion immediately as an "unverified" finding (id F001...,
  severity, where, claim, evidence <= 15 lines, fix); verify later with
  "update" records (confirmed/refuted). Never edit earlier lines.
- After each scope item: a "covered" record and a rewritten checkpoint.
- Finish with a "done" record, then a final message: confirmed findings
  ranked, counts of the rest, and the ledger path.
- No secret values in the ledger.
```
