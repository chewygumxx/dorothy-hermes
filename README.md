---
__cgxx: |
  # vim:set expandtab shiftwidth=2 filetype=markdown foldlevel=3:
  # SPDX-License-Identifier: GPL-3.0-only

  #
  #
  # ~chewygumxx/dorothy-hermes.git
  # ::: :/README.md
  #
  #

ctime: 2026-10-02
title: "dorothy-hermes"
description: "Container for deployment of personal Hermes Agent"
tags:
  - dorothy
---

# dorothy-hermes

Container for deployment of personal Hermes Agent

## CI

`.github/workflows/ci.yaml` calls the shared
[standard workflow](https://github.com/chewygumxx/.github#standard-workflow):
commitlint, the header sync, generic lint and format checks for workflows,
shell and zsh scripts, TOML, YAML and `.editorconfig`, and the metadata sync.
This repository's own `bun run check` follows, against the commit the header
sync pushed.

## Development

- `bun run commit` composes a commit interactively.
- `bun run check` runs the checks CI runs: the typecheck, Biome's format and
  lint checks, Markdown lint, the YAML checks (prettier, then yamllint with
  `@chewygumxx/yamllint-config`), tombi's TOML format and lint checks and a
  check that rejects em dashes.
- `bun run format` applies Biome formatting, prettier's to YAML and tombi's to
  TOML, which Biome does not read.

The pre-commit hook runs the same checks on staged files. The commit-msg hook
runs commitlint.
