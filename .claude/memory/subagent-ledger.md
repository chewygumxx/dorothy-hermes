---
name: subagent-ledger
description: >-
  Every subagent brief must include the ledger protocol so interrupted work is
  recoverable
metadata:
  node_type: memory
  type: feedback
  originSessionId: 0a738473-90de-4a09-bcdd-f6b481bebb31
  modified: 2026-10-03T06:33:31.830Z
---

<!--
# SPDX-License-Identifier: GPL-3.0-only

#
#
# ~chewygumxx/dorothy-hermes.git
# ::: :/.claude/memory/subagent-ledger.md
#
#
-->

Brief every subagent with the ledger protocol in
`docs/agents/subagent-ledger.md` (paste its "Brief to paste" block, with a run
dir under
`${XDG_STATE_HOME:-$HOME/.local/state}/agent-ledger/dorothy-hermes/<run>/`).

**Why:** on 2026-10-03 a plan reviewer burned ~370k tokens and hit the
five-hour usage limit before returning anything; the user wants no subagent's
work lost that way again.

**How to apply:** create the run dir before spawning; on an early stop, reduce
the ledger with the doc's `jq` recipe and relaunch fresh on uncovered items
rather than resuming the dead agent. See
[plan-review-status](./plan-review-status.md).

<!-- vim:set expandtab shiftwidth=2 filetype=markdown foldlevel=3: -->
