---
__cgxx: |
  # vim:set expandtab shiftwidth=2 filetype=markdown foldlevel=3:
  # SPDX-License-Identifier: GPL-3.0-only

  #
  #
  # ~chewygumxx/dorothy-hermes.git
  # ::: :/.claude/memory/threat-model-includes-owner.md
  #
  #

name: threat-model-includes-owner
description: >-
  The user's own mistakes (e.g. committing a .gitignore to dorothy-memory)
  belong in the threat model; prefer GitHub rulesets as the guard
metadata:
  node_type: memory
  type: feedback
  originSessionId: 0a738473-90de-4a09-bcdd-f6b481bebb31
  modified: 2026-10-03T13:59:50.922Z
---

The user wants their own ignorance or negligence treated as part of the threat
model, not ruled "outside" it. Example (2026-10-03): I ruled that a
`.gitignore` the user commits to `dorothy-memory` was outside the threat model;
they suggested a GitHub ruleset could block it instead.

**Why:** they operate the repos alone; an owner mistake silently breaks
snapshots as surely as an attacker would.

**How to apply:** when a failure needs the owner to act wrongly, propose a
mechanical guard (ruleset, CI check, refusal in code) rather than dismissing
it. Deferred until after Task 17 of
[plan-review-status](./plan-review-status.md); fold into the security spec then.
