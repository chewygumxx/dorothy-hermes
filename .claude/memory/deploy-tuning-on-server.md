---
name: deploy-tuning-on-server
description: "Deployment tuning (memory limits, bundle cap, log rotation, git gc) is verified on the live server, not with local tests first"
metadata:
  node_type: memory
  type: feedback
  modified: 2026-10-03T18:48:44.683Z
  originSessionId: 0a738473-90de-4a09-bcdd-f6b481bebb31
---

<!--
# SPDX-License-Identifier: GPL-3.0-only

#
#
# ~chewygumxx/dorothy-hermes.git
# ::: :/.claude/memory/deploy-tuning-on-server.md
#
#
-->

On 2026-10-04 the user declined local test-first work for three deploy
tuning fixes (lower `DOROTHY_BUNDLE_MAX_BYTES` to 128 MiB, container log
rotation, a low `gc.auto` in `hermes/src/git.ts`): "we can test on the
deployed server".

Measured that day, inside the image under a 1 GB limit: a 212 MiB bundle
peaks the sidecar at 919 MiB RSS (about 4.3x), so the 256 MiB default cap
can OOM `dorothy-sync`, and an agent can force it. Git auto-gc waits for
about 6,700 loose objects, roughly 2,200 snapshots. Server plan: 8 GB RAM
(hermes 4g, sync 1g), 40 GB disk.

**Why:** the user prefers real-server data over local tests for tuning.

**How to apply:** for limits and sizing, propose the change and a server
check in Task 17's data capture rather than a local RED/GREEN cycle. Logic
and security code still goes test-first. Faults that only show after weeks
or under a hostile bundle need a deliberate server check, not passive use.
See [plan-review-status](./plan-review-status.md).

<!-- vim:set expandtab shiftwidth=2 filetype=markdown foldlevel=3: -->
