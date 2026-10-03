---
__cgxx: |
  # vim:set expandtab shiftwidth=2 filetype=markdown foldlevel=3:
  # SPDX-License-Identifier: GPL-3.0-only

  #
  #
  # ~chewygumxx/dorothy-hermes.git
  # ::: :/.claude/memory/no-python.md
  #
  #

name: no-python
description: >-
  Write no Python in this repository: TypeScript first, bash if TypeScript is
  impractical; Python runs only as upstream's code inside the image
metadata:
  node_type: memory
  type: feedback
  modified: 2026-10-04T04:30:00.000Z
---

The user dislikes Python ("an irrational disdain") and wants none in this
repository. New scripts are TypeScript (Node type stripping, `node:*` only,
like `hermes/src`); bash only when TypeScript is impractical.

On 2026-10-04 `scripts/platforms.py` became `scripts/platforms.ts` (reads
upstream's source as text, strict). `smoke/search.py` could not be ported:
the check must run upstream's own session search, so its six lines became a
heredoc in `smoke/run.sh` run by the image's Python.

**Why:** the user's stated preference, given knowing it is irrational.

**How to apply:** reach for TypeScript first, even for probes run inside the
image (it has `/usr/local/bin/node`). When only upstream's Python can answer,
inline the minimum into a shell heredoc and say why in a comment. Python
tooling installed by mise (uv, yamllint) is fine; it is not repository code.
