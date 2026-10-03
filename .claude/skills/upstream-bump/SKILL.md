---
__cgxx: |
  # vim:set expandtab shiftwidth=2 filetype=markdown foldlevel=3:
  # SPDX-License-Identifier: GPL-3.0-only

  #
  #
  # ~chewygumxx/dorothy-hermes.git
  # ::: :/.claude/skills/upstream-bump/SKILL.md
  #
  #

ctime: 2026-10-04
name: upstream-bump
description: >-
  Re-run the upstream probe's checks when the pinned nousresearch/hermes-agent
  image changes, as in a Dependabot docker-compose pull request or a manual
  bump, before it merges.
disable-model-invocation: true
---

# Bump the upstream Hermes image

Dorothy runs the upstream image unmodified, so every bump can move something
our code assumes. `docs/notes/2026-10-03-upstream-probe.md` records how each
assumption was first established; this skill re-checks them. Work on the bump's
branch, commit each step on its own, and stop at the first check that fails.

## 1. Pin the new image everywhere

- Note the new tag and digest from the pull request.
- Confirm the digest without buildx: `docker pull IMAGE`, then
  `docker image inspect --format '{{json .RepoDigests}}' IMAGE`.
- `git grep -n 'hermes-agent:v'` lists every pin. They move together, except
  `smoke/make-fixture.sh`, which stays one release behind (step 6).

## 2. Match Node to the image

- `docker run --rm --entrypoint /usr/local/bin/node IMAGE --version`
- If it differs, set `node` in `mise.toml` and `@types/node` in `package.json`
  to that exact version, run `bun install`, then `mise run test`.

## 3. Regenerate the platform registry

- Run `scripts/platforms.ts` inside the new image and format the result, as
  its doc comment shows. The secrets guard blocks editing
  `hermes/src/platforms.json` by hand.
- Read the diff. A new platform, or a new allowlist variable, changes what S6
  refuses at boot; check it against the security spec.

## 4. Run the smoke test

- `mise run smoke` boots the real image and covers the `cap_add` set (restart
  and stop), the broken-config rollback, the memory-key check (S1), and
  migration from the older fixture.
- A capability failure means upstream needs a new one: re-probe as the note
  describes, and add only what the failure proves.
- If `smoke/fixtures/config-broken.yaml` now boots cleanly, upstream accepts
  it: pick a new candidate the way the note's candidates A to D were tried.

## 5. Run the full checks

- `mise run test` and `bun run check`.

## 6. After the bump merges, roll the fixture forward

- Set `FIXTURE_IMAGE` in `smoke/make-fixture.sh` to the image that was current
  before this bump, run the script, review the `state.sql` diff, and commit it
  alone. Smoke then proves migration from the release before.

## 7. Record what changed

- Append a dated section to the probe note: tag, digest, Node version,
  platform registry diff, smoke result, and any new ruling.
