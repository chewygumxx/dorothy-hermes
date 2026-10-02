#!/usr/bin/env sh
# vim:set expandtab shiftwidth=4 filetype=sh:
# SPDX-License-Identifier: GPL-3.0-only

#
#
# ~chewygumxx/dorothy-hermes.git
# ::: :/.claude/hooks/install-deps.sh
#
#

# SessionStart. Installs this repository's dependencies, with Bun, so husky's
# git hooks are wired before anything else in the session runs.

set -u

[ "${CLAUDE_CODE_REMOTE:-}" = "true" ] || exit 0

root=${CLAUDE_PROJECT_DIR:-}
[ -n "$root" ] || root=$(git rev-parse --show-toplevel 2>/dev/null) || exit 0
[ -n "$root" ] || exit 0

[ -f "$root/package.json" ] || exit 0
command -v bun >/dev/null 2>&1 || exit 0

cd "$root" || exit 0
bun install --frozen-lockfile >/dev/null
