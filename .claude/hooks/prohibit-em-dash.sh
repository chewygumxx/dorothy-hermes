#!/bin/sh
# vim:set expandtab shiftwidth=4 filetype=sh:
# SPDX-License-Identifier: GPL-3.0-only

#
#
# ~chewygumxx/dorothy-hermes.git
# ::: :/.claude/hooks/prohibit-em-dash.sh
#
#

# Written as an octal escape, so this file has no em dash of its own.
emdash=$(printf '\342\200\224')

jq -r '.tool_input.file_path // empty' | {
    read -r f
    [ -z "$f" ] && exit 0
    [ -f "$f" ] || exit 0
    grep -Iqn "$emdash" "$f" && {
        echo "Em dash (U+2014) found in $f. Em dashes are prohibited in this repo; remove it." >&2
        exit 2
    }
    exit 0
}
