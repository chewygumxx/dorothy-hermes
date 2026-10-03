#!/usr/bin/env sh
# vim:set expandtab shiftwidth=4 filetype=sh:
# SPDX-License-Identifier: GPL-3.0-only

#
#
# ~chewygumxx/dorothy-hermes.git
# ::: :/smoke/run.sh
#
#

# Boots the stack against fixture repositories and runs the deployment and
# security designs' smoke steps. Needs Docker, jq and mise's Node.
# KEEP=1 keeps the work directory and its compose.log.

set -eu

root=$(cd "$(dirname "$0")/.." && pwd)
work=$(mktemp -d)
chmod 0777 "$work"

export COMPOSE_PROJECT_NAME=dorothy-smoke
export SMOKE_REPOS="$work/repos"
export DOROTHY_HOST=smoke
export DOROTHY_SYNC_INTERVAL=60
export DOROTHY_CONFIG_REPO=file:///fixtures/config.git
export DOROTHY_CONFIG_REPO_NAME=smoke/dorothy-config
export DOROTHY_MEMORY_REPO=file:///fixtures/memory.git
export DOROTHY_SMOKE_TOKEN=dorothy-fake-token-0123456789abcdef

say() { printf 'smoke: %s\n' "$*"; }
fail() {
    printf 'smoke: FAIL: %s\n' "$*" >&2
    exit 1
}
compose() { docker compose -f "$root/compose.yaml" -f "$root/smoke/compose.smoke.yaml" "$@"; }

ssh-keygen -q -t ed25519 -N '' -C smoke-config -f "$work/config_key"
ssh-keygen -q -t ed25519 -N '' -C smoke-memory -f "$work/memory_key"
DOROTHY_CONFIG_DEPLOY_KEY=$(base64 -w0 <"$work/config_key")
DOROTHY_MEMORY_DEPLOY_KEY=$(base64 -w0 <"$work/memory_key")
export DOROTHY_CONFIG_DEPLOY_KEY DOROTHY_MEMORY_DEPLOY_KEY

image=$(compose config --images | grep hermes-agent | head -n 1)
GIT='git -c user.name=smoke -c user.email=smoke@example.invalid -c commit.gpgsign=false -c init.defaultBranch=main'

cleanup() {
    code=$?
    compose logs --no-color --timestamps >"$work/compose.log" 2>&1 || true
    compose down --volumes --remove-orphans >/dev/null 2>&1 || true
    if [ "$code" -ne 0 ]; then tail -n 300 "$work/compose.log" >&2 || true; fi
    if [ -n "${KEEP:-}" ]; then
        say "kept $work"
        return
    fi
    docker run --rm -v "$work:/work" --entrypoint /bin/rm "$image" -rf /work/repos /work/edit >/dev/null 2>&1 || true
    rm -rf "$work"
}
trap cleanup EXIT

# A shell command in the image as UID 10000, which owns the fixture repositories.
fixture() {
    docker run --rm -u 10000:10000 -e HOME=/tmp -e GIT_CONFIG_GLOBAL=/dev/null -e GIT_CONFIG_NOSYSTEM=1 \
        -v "$work:/work" -v "$root/smoke/fixtures:/src:ro" --entrypoint /bin/sh "$image" -c "$1"
}
memory_head() { fixture "$GIT --git-dir /work/repos/memory.git rev-parse --verify -q main || true"; }
memory_show() { fixture "$GIT --git-dir /work/repos/memory.git show main:$1"; }
# Commits /work/next over the config clone and prints the new SHA.
config_commit() {
    fixture "set -e; cd /work/edit/config; cp -R /work/next/. .; $GIT add -A; $GIT commit -q -m '$1'; $GIT push -q origin HEAD:refs/heads/main; $GIT rev-parse HEAD" | tail -n 1
}
snapshot_once() { compose exec -T -u hermes hermes /usr/local/bin/node /opt/dorothy/src/snapshot.ts --once; }
in_hermes() { compose exec -T hermes "$@"; }
as_hermes() { compose exec -T -u hermes hermes "$@"; }
sync_error_has() { in_hermes cat /var/lib/dorothy/restore/status.json | jq -r '.lastError // ""' | grep -q "$1"; }
memory_moved() { [ "$(memory_head)" != "$1" ]; }
# wait_for <seconds> <command...>
wait_for() {
    left=$1
    shift
    while [ "$left" -gt 0 ]; do
        if "$@"; then return 0; fi
        sleep 5
        left=$((left - 5))
    done
    return 1
}

say "Node parity"
host_node=$(node --version)
image_node=$(docker run --rm --entrypoint /usr/local/bin/node "$image" --version)
[ "$host_node" = "$image_node" ] || fail "mise's Node $host_node differs from the image's $image_node"

say "S9: no service publishes ports"
compose config --format json | jq -e '[.services[] | select(.ports)] | length == 0' >/dev/null ||
    fail "a service publishes ports"

say "S10: the override leaves hardening alone"
if grep -nE 'cap_|privileged|security_opt|read_only|pids_limit|mem_limit|tmpfs' "$root/smoke/compose.smoke.yaml"; then
    fail "smoke/compose.smoke.yaml changes hardening"
fi

say "fixture repositories"
fixture "
    set -e
    mkdir -p /work/repos /work/edit
    for name in config memory; do
        $GIT init --bare -q /work/repos/\$name.git
        $GIT clone -q /work/repos/\$name.git /work/edit/\$name
        cp -R /src/\$name/. /work/edit/\$name/
        cd /work/edit/\$name
        $GIT add -A
        $GIT commit -q -m fixture
        $GIT push -q origin HEAD:refs/heads/main
        cd /
    done
"

say "step 1: a cold boot from the memory fixture"
compose up -d --wait --wait-timeout 600 || fail "the stack did not become healthy"
in_hermes test -f /opt/data/memories/MEMORY.md || fail "memories were not restored"
in_hermes test -f /opt/data/skills/smoke/hello/SKILL.md || fail "skills were not restored"
compose exec -T -u hermes hermes /opt/hermes/.venv/bin/python /smoke/search.py zebracorn 東京 ||
    fail "session search lost fixture messages"

say "S1: the memory key is absent from hermes"
docker inspect "$(compose ps -q hermes)" --format '{{json .Config.Env}}' | grep -q DOROTHY_MEMORY_DEPLOY_KEY &&
    fail "hermes has DOROTHY_MEMORY_DEPLOY_KEY in its environment"
# Both forms: a decoded key line, and a slice of the base64 value. Both
# skip the PEM header and the key's first line, which every unencrypted
# ed25519 key, including the config key, shares. Searched as root and as
# hermes: root lacks CAP_SYS_PTRACE, so it cannot read the environ files of
# hermes's processes. grep exits 2 when any file is unreadable, even after
# a match, so its output decides.
key_line=$(sed -n 3p "$work/memory_key")
key_b64=$(printf '%s' "$DOROTHY_MEMORY_DEPLOY_KEY" | cut -c 161-220)
for user in root hermes; do
    found=$(compose exec -T -u "$user" hermes sh -c \
        "grep -rlsF -e '$key_line' -e '$key_b64' /proc/[0-9]*/environ /opt/data /run /tmp /var/lib/dorothy || true")
    [ -z "$found" ] || fail "the memory key is readable inside hermes (as $user): $found"
done

say "S3: root in hermes cannot write the restore volume or reach the sidecar"
if in_hermes touch /var/lib/dorothy/restore/probe 2>/dev/null; then fail "the restore volume is writable from hermes"; fi
sidecar_ip=$(docker inspect "$(compose ps -q dorothy-sync)" --format '{{range .NetworkSettings.Networks}}{{.IPAddress}}{{end}}')
reach=$(in_hermes /usr/local/bin/node -e "
const socket = require('node:net').connect(9, '$sidecar_ip');
socket.on('connect', () => { console.log('open'); process.exit(); });
socket.on('error', (error) => { console.log(error.code); process.exit(); });
setTimeout(() => { console.log('timeout'); process.exit(); }, 3000);")
case "$reach" in open | ECONNREFUSED) fail "hermes reached the sidecar ($reach)" ;; esac

say "step 2 and S5: a snapshot reaches dorothy-memory, redacted"
before=$(memory_head)
snapshot_once || fail "snapshot --once failed"
wait_for 120 memory_moved "$before" || fail "the sidecar did not publish"
memory_show sessions/state.sql >"$work/state.sql"
grep -qF "$DOROTHY_SMOKE_TOKEN" "$work/state.sql" && fail "the fake token reached dorothy-memory"
grep -qF "[REDACTED:DOROTHY_SMOKE_TOKEN]" "$work/state.sql" || fail "the fake token was not redacted"
node "$root/smoke/restore-check.mts" "$work/state.sql" zebracorn 東京 || fail "state.sql does not restore"

say "step 3: a config push is applied by the fallback apply"
mkdir -p "$work/next"
printf '# Smoke Dorothy\n\nYou are a smoke-test fixture. Version 2.\n' >"$work/next/SOUL.md"
sha=$(config_commit "soul v2")
snapshot_once || fail "snapshot --once failed"
in_hermes grep -q "Version 2." /opt/data/SOUL.md || fail "SOUL.md was not applied"
[ "$(in_hermes cat /opt/data/dorothy/status/apply.json | jq -r .appliedSha)" = "$sha" ] || fail "appliedSha was not recorded"

say "step 4: a config that stops the gateway is rolled back"
rm -f "$work/next/SOUL.md"
cp "$root/smoke/fixtures/config-broken.yaml" "$work/next/config.yaml"
bad=$(config_commit "broken config")
snapshot_once || fail "snapshot --once failed"
record=$(in_hermes cat /opt/data/dorothy/status/apply.json)
[ "$(printf '%s' "$record" | jq -r .rolledBackSha)" = "$bad" ] || fail "the broken config was not recorded"
[ "$(printf '%s' "$record" | jq -r .configRolledBack)" = true ] || fail "configRolledBack is not set"
in_hermes /command/s6-svstat -o up /run/service/gateway-default | grep -q true || fail "the gateway did not come back"
pid=$(in_hermes /command/s6-svstat -o pid /run/service/gateway-default)
snapshot_once || fail "snapshot --once failed"
[ "$(in_hermes /command/s6-svstat -o pid /run/service/gateway-default)" = "$pid" ] ||
    fail "the rolled-back config was applied again"
cp "$root/smoke/fixtures/config/config.yaml" "$work/next/config.yaml"
config_commit "fixed config" >/dev/null
snapshot_once || fail "snapshot --once failed"

say "S2: symlinked and FIFO bundles are rejected"
# The snapshot loop would replace the planted file within an interval, so it
# pauses; the hostile files are planted as the agent would, as hermes.
in_hermes /command/s6-rc -d change dorothy-snapshot || fail "could not pause dorothy-snapshot"
head=$(memory_head)
as_hermes sh -c 'ln -sfn /tmp/dorothy/memory.key /var/lib/dorothy/outbox/bundle.json' ||
    fail "hermes could not plant a symlink"
wait_for 90 sync_error_has 'symbolic link' || fail "the symlinked bundle was not rejected"
as_hermes sh -c 'rm -f /var/lib/dorothy/outbox/bundle.json && mkfifo /var/lib/dorothy/outbox/bundle.json' ||
    fail "hermes could not plant a FIFO"
wait_for 90 sync_error_has 'not a regular file' || fail "the FIFO bundle was not rejected"
[ "$(memory_head)" = "$head" ] || fail "something was pushed from a hostile bundle"
as_hermes rm -f /var/lib/dorothy/outbox/bundle.json
in_hermes /command/s6-rc -u change dorothy-snapshot || fail "could not resume dorothy-snapshot"
snapshot_once || fail "snapshot --once failed"

say "final snapshot and warm boot: a stop publishes, a restart restores nothing"
as_hermes sh -c 'printf "final\n" > /opt/data/memories/FINAL.md'
marker=$(in_hermes cat /opt/data/dorothy/restored)
compose stop || fail "the stack did not stop"
memory_show memories/FINAL.md | grep -q final || fail "the final snapshot did not reach dorothy-memory"
compose up -d --wait --wait-timeout 600 || fail "the warm boot did not become healthy"
[ "$(in_hermes cat /opt/data/dorothy/restored)" = "$marker" ] || fail "the warm boot restored again"
in_hermes test -f /opt/data/memories/FINAL.md || fail "the warm boot lost memories/FINAL.md"

say "step 5: a first boot against an empty memory repository seeds main"
compose down --volumes
fixture "$GIT init --bare -q /work/repos/memory-empty.git"
export DOROTHY_MEMORY_REPO=file:///fixtures/memory-empty.git
compose up -d --wait --wait-timeout 600 || fail "the seed stack did not become healthy"
snapshot_once || fail "snapshot --once failed"
seeded() { fixture "$GIT --git-dir /work/repos/memory-empty.git cat-file -e main:sessions/state.sql" 2>/dev/null; }
wait_for 120 seeded || fail "the seed deployment did not push main"

say "S6: a platform token without an allowlist stops the container"
compose down --volumes
if timeout 300 docker compose -f "$root/compose.yaml" -f "$root/smoke/compose.smoke.yaml" \
    run --rm --no-deps -e TELEGRAM_BOT_TOKEN=1:smoke hermes >"$work/s6.log" 2>&1; then
    fail "hermes started without an allowlist"
fi
grep -q TELEGRAM_ALLOWED_USERS "$work/s6.log" || fail "the refusal does not name TELEGRAM_ALLOWED_USERS"

say "passed"
