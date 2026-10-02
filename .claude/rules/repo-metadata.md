---
__cgxx: |
  # vim:set expandtab shiftwidth=2 filetype=markdown foldlevel=3:
  # SPDX-License-Identifier: GPL-3.0-only

  #
  #
  # ~chewygumxx/dorothy-hermes.git
  # ::: :/.claude/rules/repo-metadata.md
  #
  #

ctime: 2026-09-27
title: Repository metadata
paths:
  - ".repo-metadata.jsonc"
tags:
  - llm
  - claude
---

# `.repo-metadata.jsonc` is the GitHub settings page

This file holds the GitHub repository's own description, topics and licence. CI
applies it on every push to `main`, so those settings are edited here and not in
the web interface.

Editing them in the web interface is the failure worth naming: nothing rejects
it, and the next push silently reverts it.
