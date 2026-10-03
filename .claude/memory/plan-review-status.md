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
  Live-deploy plan: Tasks 1-16 merged to main (PR #1); next is Task 17, the
  live deploy with the user, then Task 18 folds results into the specs
metadata:
  node_type: memory
  type: project
  originSessionId: 0a738473-90de-4a09-bcdd-f6b481bebb31
  modified: 2026-10-03T16:54:21.564Z
---

The plan `docs/plans/2026-10-03-hermes-live-deploy.md` was executed natively
(superpowers:executing-plans). Tasks 1-16 merged via PR #1 on 2026-10-03; a
fresh Opus review found F001-F004, all fixed test-first.

Execution progress and every ruling live in
`.superpowers/sdd/2026-10-03-hermes-live-deploy/progress.md` (gitignored);
trust it and `git log` after compaction. Resume at the first task without a
`Task N: complete` line: Task 17 is human-in-the-loop (server, GitHub repos,
rulesets, deploy keys, SOUL.md, secrets typed by the user with `dotenvx set`).

Probe facts: the image runs Node 26.5.1; `cap_add` is CHOWN, DAC_OVERRIDE,
SETUID, SETGID, KILL (no FOWNER); the broken fixture is WhatsApp
`dm_policy: open`, which exits 0.

Docker: Claude Code's process predates the user's `docker` group, so run
docker through `/tmp/dk` (pipes an sh script into `newgrp docker`) until a
fresh login. Compose is the system pacman `docker-compose`.

For Task 18 (fold into the specs), beyond the ledger: on 2026-10-04 the
Python-to-TypeScript port of `scripts/platforms.py` found the registry
missed nine plugin platforms' allowlist variables (fixed, 07d639d). Still
open: plugin platforms enable themselves in code (`env_enablement_fn`), so
S6's "token without an allowlist" check cannot cover them.

**Why:** the user's roadmap is plan, review, fold, then build and deploy live
to gather data.

**How to apply:** read the ledger before acting; Task 6 Step 5 ran against an
image-made state.db, not the user's (ruling in the ledger). See
[threat-model-includes-owner](./threat-model-includes-owner.md).
