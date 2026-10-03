#!/usr/bin/env sh
# vim:set expandtab shiftwidth=4 filetype=sh:
# SPDX-License-Identifier: GPL-3.0-only

#
#
# ~chewygumxx/dorothy-hermes.git
# ::: :/.claude/hooks/guard-secrets.sh
#
#

# PreToolUse guard. Secrets are typed by the owner (`! dotenvx set ...`),
# never by Claude, and never decrypted into the transcript. Exit 2 blocks
# the call and hands stderr to Claude as the reason.
#
# Blocked:
#   - writing `.env` or `.env.keys`, and reading `.env.keys` (the private
#     key; `.env` itself is public ciphertext and may be read)
#   - writing generated files, which only their generators rewrite
#   - `dotenvx get|decrypt|keys|set|run`, and any command naming `.env.keys`
#
# It fails closed: without jq it blocks the call rather than guess.

set -eu

block() {
    printf 'guard-secrets: %s\n' "$1" >&2
    exit 2
}

command -v jq >/dev/null 2>&1 || block "jq is missing; run mise install"

payload=$(cat)
tool=$(printf '%s' "$payload" | jq -r '.tool_name // empty')

case $tool in
Write | Edit | NotebookEdit | Read)
    path=$(printf '%s' "$payload" |
        jq -r '.tool_input.file_path // .tool_input.notebook_path // empty')
    case ${path##*/} in
    .env.keys)
        block ".env.keys holds the private key; the owner handles it"
        ;;
    .env)
        [ "$tool" = Read ] ||
            block ".env is encrypted; the owner types secrets with dotenvx set"
        ;;
    esac
    [ "$tool" = Read ] && exit 0
    case $path in
    */hermes/src/platforms.json | hermes/src/platforms.json)
        block "generated: rerun scripts/platforms.py inside the pinned image"
        ;;
    */smoke/fixtures/memory/sessions/state.sql | smoke/fixtures/memory/sessions/state.sql)
        block "generated: rerun smoke/make-fixture.sh and review the diff"
        ;;
    */bun.lock | bun.lock)
        block "generated: change package.json and run bun install"
        ;;
    esac
    ;;
Bash)
    cmd=$(printf '%s' "$payload" | jq -r '.tool_input.command // empty')
    if printf '%s' "$cmd" | grep -qE '\.env\.keys'; then
        block "commands may not touch .env.keys"
    fi
    if printf '%s' "$cmd" | grep -qE '(^|[^[:alnum:]_-])dotenvx[[:space:]]+(get|decrypt|keys|set|run)([[:space:]]|$)'; then
        block "dotenvx get/decrypt/keys/set/run stay with the owner; use mise run up to start Dorothy"
    fi
    ;;
esac

exit 0
