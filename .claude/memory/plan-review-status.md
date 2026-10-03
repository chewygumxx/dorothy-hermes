---
__cgxx: |
  # vim:set expandtab shiftwidth=2 filetype=markdown foldlevel=3:
  # SPDX-License-Identifier: GPL-3.0-only

  #
  #
  # ~chewygumxx/dorothy-hermes.git
  # ::: :/.claude/memory/plan-review-status.md
  #
  #

name: plan-review-status
description: >-
  Live-deploy plan: Tasks 1-16 done, PR #1 open and green; after the user
  merges it, Task 17 live deploy with the user"
metadata:
  node_type: memory
  type: project
  originSessionId: 0a738473-90de-4a09-bcdd-f6b481bebb31
  modified: 2026-10-03T13:10:28.908Z
---

The plan `docs/plans/2026-10-03-hermes-live-deploy.md` was reviewed by four
ledgered agents and every confirmed finding folded (commits 93c7575..ccef5e9);
the review ledgers were trashed after Task 1. Decisions (2026-10-03): public
dotenvx ciphertext accepted (security spec S11); execution is Native
(superpowers:executing-plans) on branch `feat/live-deploy` in place (user's
choice, not a worktree), then one fresh whole-branch reviewer under
[subagent-ledger](./subagent-ledger.md).

Execution progress lives in
`.superpowers/sdd/2026-10-03-hermes-live-deploy/progress.md` (gitignored);
trust it and `git log` after compaction. Task 1 found the image runs Node
26.5.1 (not 26.7), cap_add drops FOWNER, broken fixture is `dm_policy: open` on
WhatsApp.

Docker: the user joined the `docker` group mid-session; until Claude Code
restarts, run docker through `/tmp/dk` (pipes an sh script into `newgrp
docker`). Compose is the system pacman `docker-compose` (user declined a mise
pin).

Status 2026-10-03 23:10: Tasks 1-16 complete (head 2081f58), 122/122 unit
tests, smoke passed twice. Final whole-branch review dispatched BEFORE Task 17
(ledger
`~/.local/state/agent-ledger/dorothy-hermes/20261003-230951-final-review/`),
because Task 17 clones the repo from GitHub. After its fix pass: merge to main
and push (ask first), then Task 17 with the user.

Status 2026-10-04 00:10: final review fixed (F001-F004), file headers added, PR
<https://github.com/chewygumxx/dorothy-hermes/pull/1> open, CI green incl. smoke
(head fad16d9). CI header-sync pushes its own commits to PR branches; local
`bun run check` does not run shfmt (CI does). Next: user merges, then Task 17.

**Why:** the user's roadmap is plan, review, fold, then build and deploy live
to gather data.

**How to apply:** resume at the first task without a `Task N: complete` ledger
line. Task 6 Step 5 ran against an image-made state.db instead of the user's
(ruling in the ledger); Task 17 is human-in-the-loop.
