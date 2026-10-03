#!/usr/bin/env sh
# vim:set expandtab shiftwidth=4 filetype=sh:
# SPDX-License-Identifier: GPL-3.0-only

#
#
# ~chewygumxx/dorothy-hermes.git
# ::: :/scripts/lint-sh.sh
#
#

# Runs shellcheck and `shfmt -d` over the tracked POSIX shell scripts, as
# CI's lint-shell does. shfmt finds scripts by extension and shebang; the
# s6 scripts (`#!/command/with-contenv sh`) match neither and are found by
# the vim modeline in their header, as CI's filetype.sh finds them.

set -eu

files=$(
    {
        git ls-files -z | xargs -0 shfmt -f
        git ls-files | while IFS= read -r file; do
            case ${file##*/} in *.*) continue ;; esac
            if head -n 5 -- "$file" | grep -qE '(vim?|ex):.*(ft|filetype)=(sh|bash)\b'; then
                printf '%s\n' "$file"
            fi
        done
    } | sort -u
)

[ -n "$files" ] || exit 0
# Word splitting is the point: tracked paths here contain no spaces.
# shellcheck disable=SC2086
shellcheck -- $files
# shellcheck disable=SC2086
shfmt -d -- $files
