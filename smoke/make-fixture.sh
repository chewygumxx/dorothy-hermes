#!/usr/bin/env sh
# vim:set expandtab shiftwidth=4 filetype=sh:
# SPDX-License-Identifier: GPL-3.0-only

# Regenerates smoke/fixtures/memory/sessions/state.sql with an OLDER image,
# so every smoke run proves migration from an earlier schema. Run it only
# deliberately (after an upgrade lands), review the diff, then commit.

set -eu

root=$(cd "$(dirname "$0")/.." && pwd)
image=${FIXTURE_IMAGE:-nousresearch/hermes-agent:v2026.9.21@sha256:6bece0644e29a347e5ae17db43c36938c86f171c6f5e0cef18aa2075d331f3a3}
work=$(mktemp -d)
mkdir "$work/home"
chmod 0777 "$work" "$work/home"
trap 'docker run --rm -v "$work:/work" --entrypoint /bin/rm "$image" -rf /work/home; rm -rf "$work"' EXIT

# The home is mounted at the image's own HERMES_HOME: pointing HERMES_HOME
# elsewhere makes upstream reinstall its dependencies there.
run() {
    docker run --rm -u 10000:10000 -e HOME=/work \
        -v "$work/home:/opt/data" -v "$root/smoke:/smoke:ro" -v "$root/hermes/src:/opt/dorothy/src:ro" "$@"
}

run --entrypoint /opt/hermes/bin/hermes "$image" sessions import --from claude /smoke/fixture-session.jsonl
run --entrypoint /opt/hermes/bin/hermes "$image" backup --quick --label fixture
run --entrypoint /usr/local/bin/node "$image" /smoke/dump-fixture.mts /opt/data \
    > "$root/smoke/fixtures/memory/sessions/state.sql"
echo "wrote smoke/fixtures/memory/sessions/state.sql from $image"
