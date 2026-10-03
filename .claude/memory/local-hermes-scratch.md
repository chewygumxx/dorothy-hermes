---
__cgxx: |
  # vim:set expandtab shiftwidth=2 filetype=markdown foldlevel=3:
  # SPDX-License-Identifier: GPL-3.0-only

  #
  #
  # ~chewygumxx/dorothy-hermes.git
  # ::: :/.claude/memory/local-hermes-scratch.md
  #
  #

name: local-hermes-scratch
description: >-
  ~/.hermes is a scratch upstream Hermes install, free to modify; deletions
  under ~ use gtrash
metadata:
  node_type: memory
  type: reference
  originSessionId: 0a738473-90de-4a09-bcdd-f6b481bebb31
  modified: 2026-10-03T06:33:39.643Z
---

`~/.hermes` holds a reference install of Hermes Agent (source checkout at
`~/.hermes/hermes-agent`, Node 26.7 at
`~/.hermes/tools/node-26.7.0-linux-x64/bin/node`). The user permits modifying
it freely; it is for reference, not use.

- Run code inside it with `hermes --run-module <module>` (module file in
  `~/.hermes/hermes-agent`). Setting a different `HERMES_HOME` triggers a
  dependency install and rewrites the launcher.
- `rm -rf` under `~` is blocked by permissions: use `gtrash put <path>`.
