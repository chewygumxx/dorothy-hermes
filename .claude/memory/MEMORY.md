---
ctime: 2026-10-04
title: MEMORY.md
description: Repository memories
tags:
  - claude
  - llm
---

<!--
# SPDX-License-Identifier: GPL-3.0-only

#
#
# ~chewygumxx/dorothy-hermes.git
# ::: :/.claude/memory/MEMORY.md
#
#
-->

# MEMORY.md

- [Subagent ledger](./subagent-ledger.md): brief every subagent with
  docs/agents/subagent-ledger.md so cut-off work survives
- [Plan review status](./plan-review-status.md): Tasks 1-16 merged; Task 17
  live deploy next; ledger in .superpowers/sdd; docker via /tmp/dk
- [Local Hermes scratch](./local-hermes-scratch.md): ~/.hermes is modifiable
  reference; use gtrash under ~
- [Threat model includes owner](./threat-model-includes-owner.md): owner
  mistakes are in scope; guard with rulesets, not "outside the model"
- [No Python](./no-python.md): TypeScript first, bash if impractical; Python
  only as upstream's code inside the image
- [Deploy tuning on server](./deploy-tuning-on-server.md): limits and sizing
  are checked on the live server, not local tests; sidecar OOM and gc numbers

<!-- vim:set expandtab shiftwidth=2 filetype=markdown foldlevel=3: -->
