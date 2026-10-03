#!/usr/bin/env bash
# vim:set expandtab shiftwidth=4 filetype=bash:
# SPDX-License-Identifier: GPL-3.0-only

#
#
# ~chewygumxx/claude-library.git
# ::: :/plugins/prohibit-em-dash/hooks/prohibit-em-dash.sh
#
#

# Claude Code PostToolUse hook on Write|Edit. Rejects any file within project
# directory that contains an em dash (U+2014) and informs Claude which lines to fix.
#
# Exit status follows the hook contract:
#     0  Valid
#     1  Execution Error (non-blocking, user viewable)
#     2  Em Dash Found: Line number printed to stderr

if [ -z "${BASH_VERSION:-}" ]; then
    echo 'prohibit-em-dash: This hook requires Bash.' >&2
    exit 1
fi

readonly BASH_MIN_VERSION=4.4 # mapfile -d, inherit_errexit, empty arrays under nounset
readonly JQ_MIN_VERSION=1.7   # --raw-output0

# The UTF-8 bytes of U+2014, as escapes such that this file contains no em dash.
readonly EM_DASH=$'\xe2\x80\x94'

#
# The two functions below and the gate that calls them run before Bash
# version is known. Bash 3.2 compatible for stock macOS.
#

fatal() {
    printf 'prohibit-em-dash: %s\n' "$*" >&2
    exit 1
}

# Succeeds when dotted version $1 is greater than or equal to dotted version $2.
version_is_at_least() {
    local -a actual_parts minimum_parts
    local index actual_part minimum_part

    IFS=. read -r -a actual_parts <<<"$1"
    IFS=. read -r -a minimum_parts <<<"$2"

    for ((index = 0; index < ${#minimum_parts[@]}; index++)); do
        actual_part=$((10#${actual_parts[index]:-0}))
        minimum_part=$((10#${minimum_parts[index]}))
        if ((actual_part != minimum_part)); then
            ((actual_part > minimum_part))
            return
        fi
    done
    return 0
}

require_bash_version() {
    local -r running_version="${BASH_VERSINFO[0]}.${BASH_VERSINFO[1]}"
    version_is_at_least "$running_version" "$BASH_MIN_VERSION" ||
        fatal "Requires Bash $BASH_MIN_VERSION or newer. Installed: $BASH_VERSION."
}

require_bash_version

# ---------------
# Bash Validated
# ---------------

set -o errexit -o nounset -o pipefail
shopt -s inherit_errexit

cmd_exists() {
    local -a not_found=()
    local cmd
    for cmd in "$@"; do
        if ! command -v "$cmd" >/dev/null 2>&1; then
            not_found+=("$cmd")
        fi
    done

    ((${#not_found[@]} > 0)) &&
        fatal "Command not found: ${not_found[*]}"
}

require_jq_version() {
    local -r version_pattern='[0-9]+(\.[0-9]+)*'
    local version_output installed_version

    version_output=$(jq --version)
    [[ $version_output =~ $version_pattern ]] ||
        fatal "could not read a version number from 'jq --version' ($version_output)."
    installed_version=${BASH_REMATCH[0]}

    version_is_at_least "$installed_version" "$JQ_MIN_VERSION" ||
        fatal "jq $JQ_MIN_VERSION or newer is required; found jq $installed_version."
}

# Prints nothing or NUL terminated filepath, newline included.
print_edited_filepath() {
    jq --raw-output0 '.tool_input.file_path // empty'
}

# Succeeds when path $1, once resolved, lies beneath the already-resolved
# directory $2. Resolution prevents "..", symlinks and doubled slashes from
# defeating prefix comparison.
is_beneath_directory() {
    local resolved_path
    resolved_path=$(realpath -- "$1") || return
    [[ $resolved_path == "$2"/* ]]
}

# Prints the comma-separated numbers of the lines in $1 holding an em dash.
# Returns grep's status: 0 found, 1 none (or a binary file), 2 error.
list_em_dash_lines() {
    local matches joined_line_numbers filepath="$1"
    local -a matching_lines=()

    # LC_ALL=C prevents locale and non-UTF-8 byte interference
    # compelling grep to classify a text file as binary and skip it.
    matches=$(LC_ALL=C grep \
        --binary-files=without-match \
        --fixed-strings \
        --line-number \
        -- "$EM_DASH" "$filepath") || return

    mapfile -t matching_lines <<<"$matches"
    printf -v joined_line_numbers '%s, ' "${matching_lines[@]%%:*}"
    printf '%s\n' "${joined_line_numbers%, }"
}

report_em_dashes() {
    local -r file_path="$1" line_numbers="$2"
    printf '%s\n' \
        "Em dash (U+2014) found in: $file_path on line(s) $line_numbers." \
        'Em dashes are prohibited in this repository; rewrite those lines without them.' \
        >&2
}

main() {
    validate_deps jq grep realpath
    require_jq_version

    [[ -n "${CLAUDE_PROJECT_DIR:-}" ]] ||
        fatal "Script intended as a Claude Code hook. Not set: CLAUDE_PROJECT_DIR"

    local project_root
    project_root=$(realpath -- "$CLAUDE_PROJECT_DIR" 2>/dev/null) ||
        fatal "Unable to resolve CLAUDE_PROJECT_DIR: $CLAUDE_PROJECT_DIR"

    local file_path
    IFS= read -r -d '' file_path < <(print_edited_filepath) || return 0
    [[ -f "$file_path" ]] || return 0
    is_beneath_directory "$file_path" "$project_root" || return 0

    local em_dash_lines grep_status=0
    em_dash_lines=$(list_em_dash_lines "$file_path") || grep_status=$?

    case $grep_status in
    0)
        report_em_dashes "$file_path" "$em_dash_lines"
        exit 2
        ;;
    1)
        return 0
        ;;
    *)
        fatal "grep failed to parse $file_path (exit code: $grep_status)."
        ;;
    esac
}

main "$@"
