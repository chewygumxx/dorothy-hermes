---
__cgxx: |
  # vim:set expandtab shiftwidth=2 filetype=markdown foldlevel=3:
  # SPDX-License-Identifier: GPL-3.0-only

  #
  #
  # ~chewygumxx/dorothy-hermes.git
  # ::: :/docs/specs/2026-10-03-hermes-deployment-design.md
  #
  #

ctime: 2026-10-03
title: Hermes deployment design
description: "Design spec for deploying Dorothy as a containerised Hermes Agent"
tags:
  - dorothy
  - hermes
  - spec
---

# Hermes deployment design

## Purpose

Run Dorothy as a personal [Hermes Agent](https://hermes-agent.nousresearch.com)
on a server, replacing the bespoke Agent SDK chat in `~chewygumxx/dorothy` for
daily use. This repository is a thin shell: Hermes itself comes unmodified from
Nous Research's published image, and everything personal comes from two GitHub
repositories. The server is disposable; GitHub holds the durable state.

Success:

- A fresh server becomes Dorothy, with her personality, memories, skills and
  conversation history, from a clone of this repository, one private key and
  `mise run up`.
- Config pushed to `dorothy-config` reaches the running agent within seconds,
  and a broken config never takes the agent offline.
- What the agent learns (memories, skills it writes, sessions) reaches
  `dorothy-memory` within one sync interval, and nothing ever overwrites that
  repository's history.
- Upgrading Hermes is a reviewed pull request whose CI proves that a restore
  through the new version's migrations boots.

## Constraints

- The upstream image `nousresearch/hermes-agent` runs as published: no derived
  image, no build step, no registry. Our code is bind-mounted into it.
- The image is pinned by calendar-version tag and digest
  (`:<calver>@sha256:<digest>`). It changes only through a merged pull request.
- Our code is TypeScript run by the image's own Node 26 (type stripping), and
  imports only `node:*` modules: nothing is installed on the server.
- Our code never opens the live `state.db`. Hermes snapshots it with its own
  patched SQLite (`hermes backup --quick`); we read only the offline copy.
- Single user, single server. One server at a time owns `dorothy-memory`.

## Out of scope

- Encrypting data at rest in GitHub. `dorothy-memory` is a private repository
  holding plaintext; the trust boundary is the GitHub account.
- Exposing the Hermes dashboard (`:9119`) or API server (`:8642`) publicly.
- Push alerts for an unhealthy container (Docker health status and logs only).
- Graceful draining of in-flight replies on config restarts.
- Sharding `state.sql` per session.
- Multiple Hermes profiles.

## Architecture

```text
dorothy-hermes (this repo, deployed)       dorothy-config (you edit)
  compose.yaml                               SOUL.md
  .env              dotenvx-encrypted        config.yaml
  mise.toml         adds node, dotenvx       skills/<name>/...
  hermes/
    known_hosts     GitHub SSH host keys   dorothy-memory (server writes)
    cont-init.d/                             memories/MEMORY.md
      005-dorothy-bootstrap                  memories/USER.md
    cont-finish.d/                           skills/<agent-made>/...
      dorothy-final-sync                     sessions/state.sql
    s6-rc.d/
      dorothy-sync/                        (run, type, dependencies.d)
      dorothy-webhook/                     (run, type, dependencies.d)
      user/contents.d/dorothy-sync         (empty registration files)
      user/contents.d/dorothy-webhook
    src/            TypeScript entry points and modules
```

### Compose stack

- `hermes`: `nousresearch/hermes-agent:<calver>@sha256:<digest>`, command
  `gateway run`, a named volume `hermes-data` at `/opt/data`, and `hermes/`
  bind-mounted read-only:
  - `hermes/cont-init.d/005-dorothy-bootstrap` to
    `/etc/cont-init.d/005-dorothy-bootstrap`
  - `hermes/cont-finish.d/dorothy-final-sync` to
    `/etc/cont-finish.d/dorothy-final-sync`
  - each `hermes/s6-rc.d/<service>` directory and registration file to the same
    path under `/etc/s6-overlay/s6-rc.d/`
  - `hermes/src` and `hermes/known_hosts` to `/opt/dorothy/`

  No host ports are published. Environment: the secrets below, the
  non-secret settings below, `S6_BEHAVIOUR_IF_STAGE2_FAILS=2`, and
  `S6_SERVICES_GRACETIME` matching `stop_grace_period: 90s`. A `healthcheck`
  runs `node /opt/dorothy/src/health.ts`.
- `cloudflared`: `cloudflare/cloudflared` pinned the same way, `tunnel run`
  with `TUNNEL_TOKEN`. The tunnel's only ingress rule routes the webhook
  hostname to `http://hermes:9000`. It sits in the compose profile `tunnel`,
  which `mise run up` enables and CI does not.

### Paths in the volume

| Path                              | Owner         | Contents                     |
| --------------------------------- | ------------- | ---------------------------- |
| `/opt/data/SOUL.md`, `config.yaml` | copied config | from `dorothy-config`        |
| `/opt/data/dorothy/config/`       | git checkout  | `dorothy-config`             |
| `/opt/data/dorothy/memory/`       | git checkout  | `dorothy-memory` staging     |
| `/opt/data/dorothy/bootstrapped`  | bootstrap     | both commit SHAs, ISO time   |
| `/opt/data/dorothy/status/`       | sync, apply   | `sync.json`, `apply.json`    |
| `/run/dorothy/*.key`              | bootstrap     | deploy keys (tmpfs, `0600`)  |
| `/run/dorothy/*.lock`             | sync, apply   | lock directories (tmpfs)     |

Config files are copied, never symlinked: upstream's boot hook refuses to
operate through symlinked paths. Hand-written skills are not copied: the user's
`config.yaml` lists `/opt/data/dorothy/config/skills` in `skills.external_dirs`,
which Hermes loads read-only.

### Repository access

Two GitHub deploy keys: read-only on `dorothy-config`, read-write on
`dorothy-memory`. Each git invocation sets `GIT_SSH_COMMAND` to
`ssh -i /run/dorothy/<repo>.key -o IdentitiesOnly=yes
-o UserKnownHostsFile=/opt/dorothy/known_hosts -o StrictHostKeyChecking=yes`.
Commits are authored as `Dorothy <noreply@dorothy.invalid>`.

## Source layout

Every module that talks to the outside world takes its collaborators as
parameters, so tests substitute fakes.

```text
hermes/src/
  bootstrap.ts   entry: clone or fetch, apply config, cold restore, marker
  sync.ts        entry: the sync loop; --once runs a single cycle
  webhook.ts     entry: the HTTP listener and apply queue
  health.ts      entry: exits 0 or 1 from status files and gateway
  final-sync.ts  entry: one sync cycle at shutdown
  dump.ts        dumpDatabase(path) -> SQL text; restoreDatabase(sql, path)
  config.ts      applyConfig(): copy files, keep *.prev, restore on rollback
  git.ts         thin wrapper over the git binary (execFile, never a shell)
  hermes.ts      HermesCli interface: backup(), restartGateway(), gatewayUp()
  status.ts      read and write status files atomically (write temp, rename)
  lock.ts        withLock(name, fn): mkdir-based lock under /run/dorothy
  settings.ts    reads and validates the environment once, at startup
```

Shell stubs (`005-dorothy-bootstrap`, each service `run`, `dorothy-final-sync`)
only drop privileges and `exec`:
`s6-setuidgid hermes node /opt/dorothy/src/<entry>.ts`. The bootstrap stub first
creates `/opt/data/dorothy` and `/run/dorothy` as root and chowns them to
`hermes`.

## Boot sequence

`005-dorothy-bootstrap` sorts before upstream's `01-hermes-setup`, so `01-`
finds our `SOUL.md` and `config.yaml` present, does not seed defaults, and runs
its config-schema migrations on ours. `02-reconcile-profiles` then starts the
gateway.

1. Write the deploy keys from the environment to `/run/dorothy/`.
2. Clone `dorothy-config`, or fetch it and hard-reset to `origin/main`. Copy
   `SOUL.md` and `config.yaml` into `/opt/data`. Warn when `config.yaml` does
   not contain the string `/opt/data/dorothy/config/skills` (no YAML parser in
   the standard library; the user's file declares `skills.external_dirs`).
3. Clone or fetch `dorothy-memory`.
   - Cold volume (`/opt/data/state.db` absent): `restoreDatabase` from
     `sessions/state.sql` into a temporary file in `/opt/data`, then rename it
     to `state.db`; nothing has it open yet. Copy `memories/*.md` and
     `skills/*` into place.
   - Warm volume: the volume wins and nothing is copied from the memory
     repository. The volume is never older than what it last pushed.
4. Write `/opt/data/dorothy/bootstrapped` with both commit SHAs.

When GitHub is unreachable:

- Warm volume: continue with the last checkout, log a warning, and leave the
  retry to the sync loop.
- Cold volume: retry with exponential backoff for five minutes, then exit
  non-zero. `S6_BEHAVIOUR_IF_STAGE2_FAILS=2` stops the container.

A cold boot must never continue: it would run as generic Hermes with empty
memory, and the sync loop would then push that emptiness to `dorothy-memory`.

## Sync loop

`dorothy-sync` runs one cycle every `DOROTHY_SYNC_INTERVAL` seconds (default
900), starting one interval after boot. A cycle:

1. Returns without effect when `/opt/data/dorothy/bootstrapped` is missing.
2. Fetches `dorothy-config` and, when `origin/main` moved, runs the same apply
   as the webhook (the fallback for lost deliveries).
3. Runs `hermes backup --quick -o <tmp>.zip`, extracts `state.db` to a
   temporary directory, and writes `dumpDatabase` output to the staging
   checkout's `sessions/state.sql`.
4. Mirrors into the staging checkout, deletions included:
   `memories/MEMORY.md`, `memories/USER.md`, and `skills/` except entries
   named in `skills/.bundled_manifest` and dotfiles.
5. Commits only when `git status --porcelain` is non-empty, with the message
   `chore(sync): Snapshot from <hostname>` and a body listing which of
   sessions, memories and skills changed.
6. Pushes, fast-forward only.
   - Network failure: the commit stays local; the next cycle pushes it.
   - Rejected because the remote has commits that are not ours: record
     `pushRejected` in `status/sync.json`, log an error each cycle, and stop
     pushing until a person resolves it. Never rebase, never force.
7. Writes `status/sync.json`: `lastSuccessAt`, `lastError`, `pendingCommits`,
   `pushRejected`.

### Locking and status

The sync loop, the webhook and the final sync are separate processes. Two
locks, each a directory created with `mkdir` under `/run/dorothy` (tmpfs, so a
container restart clears a stale lock), serialise them:

- `apply.lock` around every config apply, whether the webhook or the sync
  loop's fallback started it. Only an apply writes `status/apply.json`.
- `sync.lock` around every sync cycle, including the final sync. Only a sync
  cycle writes `status/sync.json` or touches the memory checkout.

A process waits for a held lock rather than skipping its work, except the
sync loop's fallback apply, which skips when `apply.lock` is held (the holder
is already applying).

`final-sync.ts` runs one cycle from `cont-finish.d` at shutdown. Implementation
confirms s6-overlay v3's stage 3 order (whether the gateway is already down);
either order is safe because `hermes backup` is consistent.

### Dump format

`dumpDatabase` produces deterministic SQL so that git diffs stay small:

- `PRAGMA foreign_keys=OFF;`, `BEGIN;`, then `PRAGMA user_version=<n>;`.
- Ordinary tables in name order: `CREATE TABLE` from `sqlite_master`, then one
  `INSERT` per row ordered by `rowid` (or primary key for `WITHOUT ROWID`).
  `sqlite_sequence` rows are included.
- FTS5 virtual tables: the `CREATE VIRTUAL TABLE` statement; their shadow
  tables (`<name>_data`, `_idx`, `_content`, `_docsize`, `_config`) are
  skipped.
  - External content (`content=` set): after all data,
    `INSERT INTO <name>(<name>) VALUES('rebuild');`.
  - Internal content: rows via `SELECT rowid, * FROM <name>`.
- Indexes, then views, then triggers, after all data, so restored triggers do
  not fire on restored rows.
- `COMMIT;`.

Values are encoded as SQL literals: integers and reals as written, text with
doubled single quotes, blobs as `X'<hex>'`, `NULL`. Any other virtual table
type fails the dump loudly rather than being silently dropped.

## Webhook

`dorothy-webhook` listens with `node:http` on `0.0.0.0:9000`, reachable only on
the compose network.

1. Only `POST /github`; anything else is `404`. Bodies over 1 MiB are `413`.
2. HMAC-SHA256 of the raw body with `DOROTHY_WEBHOOK_SECRET`, compared to
   `X-Hub-Signature-256` with `timingSafeEqual`. Missing or wrong is `401`.
3. `ping` is `200`. A `push` whose `repository.full_name` is the config
   repository and whose `ref` is `refs/heads/main` is accepted with `202`.
   Every other event is `202` and ignored.
4. Accepted pushes enqueue an apply and respond before it runs (GitHub times out
   after ten seconds). Applies run one at a time; any pushes arriving during an
   apply collapse into a single further apply.

An apply:

1. `git fetch`; when `origin/main` has not moved, stop. The payload only
   triggers work, so a replayed delivery causes at most a redundant fetch.
2. Save `/opt/data/SOUL.md` and `config.yaml` as `*.prev`, hard-reset the
   checkout, copy the new files in.
3. `hermes gateway restart`.
4. When the gateway is not up within 30 seconds: restore the `*.prev` files,
   restart again, and set `configRolledBack` with the bad commit SHA in
   `status/apply.json`. A later successful apply clears it.

Restarts interrupt any in-flight reply; config pushes are rare and deliberate.

## Secrets and settings

`.env` is committed, encrypted with dotenvx. The server holds only
`DOTENV_PRIVATE_KEY`, in a gitignored `.env.keys` (`0600`). `mise.toml` pins
`dotenvx` and Node 26.7 (the image's version); the `up` task runs
`dotenvx run -- docker compose --profile tunnel up -d`. Process environment
overrides the placeholder `.env` that upstream seeds in the volume, so no
plaintext secret is written to it. Decrypted values are visible to
`docker inspect`, which already implies root on the host.

| Variable                                   | Secret | Consumer          |
| ------------------------------------------ | ------ | ----------------- |
| `ANTHROPIC_API_KEY` or `CLAUDE_CODE_OAUTH_TOKEN` | yes | Hermes       |
| Platform tokens (e.g. `TELEGRAM_BOT_TOKEN`) | yes   | Hermes            |
| `DOROTHY_CONFIG_DEPLOY_KEY` (base64)       | yes    | bootstrap         |
| `DOROTHY_MEMORY_DEPLOY_KEY` (base64)       | yes    | bootstrap         |
| `DOROTHY_WEBHOOK_SECRET`                   | yes    | webhook           |
| `TUNNEL_TOKEN`                             | yes    | cloudflared       |
| `DOROTHY_CONFIG_REPO`, `DOROTHY_MEMORY_REPO` | no   | bootstrap, sync   |
| `DOROTHY_SYNC_INTERVAL`                    | no     | sync              |

Non-secret settings live in `compose.yaml`. Repository URLs accept any git URL,
which is how tests use `file://` remotes. `settings.ts` rejects a missing or
malformed variable at startup with a message naming it.

## Health and operations

`health.ts` reads both status files and exits 1 when any of these hold, and 0
otherwise:

- `/opt/data/dorothy/bootstrapped` is missing.
- `lastSuccessAt` is older than three sync intervals (after the first
  interval).
- `pushRejected` or `configRolledBack` is set.
- `hermes` reports the gateway down.

Logs go to stdout with `[dorothy-bootstrap]`, `[dorothy-sync]` and
`[dorothy-webhook]` prefixes, read with `docker compose logs`.

- Fresh server: install Docker and mise, clone, add `.env.keys`,
  `mise run up`.
- Upgrade: merge the Dependabot pull request once CI is green, then
  `git pull && mise run up` on the server.
- Sync now: `docker compose exec hermes node /opt/dorothy/src/sync.ts --once`.

## Testing

Tests run with `node --test` under the mise-pinned Node 26.7, the runtime that
ships. `tsc` typechecks with `noEmit`, `allowImportingTsExtensions` and
`erasableSyntaxOnly`, so syntax that type stripping cannot run fails the check
rather than the server. `HermesCli` is faked; git runs for real against
temporary bare repositories over `file://`.

- `dump`: a fixture database with ordinary and `WITHOUT ROWID` tables, both
  FTS5 content modes, indexes, views, triggers, blobs and a `user_version`
  round-trips through `dumpDatabase` and `restoreDatabase` with identical rows,
  identical FTS `MATCH` results and the same `user_version`; dumping twice is
  byte-identical; an unsupported virtual table fails.
- `webhook`: valid, invalid and missing signatures; repository and branch
  filtering; `ping`; the body cap; collapsing of concurrent pushes; rollback
  when the fake gateway stays down; a concurrent fallback apply skips while
  the webhook holds `apply.lock`.
- `sync`: no commit without changes; mirrored deletions; bundled-skill
  exclusion; the bootstrap-marker guard; a non-fast-forward is recorded and
  never forced; local commits survive an unreachable remote.
- `bootstrap`: cold and warm volumes; unreachable remotes (warm continues,
  cold exits non-zero); the `external_dirs` warning.

`bun run check` gains `test` (`node --test`).

### Smoke test

A CI job `smoke`, after `check`, runs the compose stack without the `tunnel`
profile against bare-repository fixtures mounted into the container. The
config fixture enables only the API server (`API_SERVER_ENABLED=true`), so no
LLM or platform credentials are needed; the gateway's `:8642` health endpoint
stands in for a platform.

1. Cold boot from a memory fixture containing a sample `state.sql`; the
   container becomes healthy.
2. `sync.ts --once` commits to the memory fixture, and its `state.sql`
   restores to the sample's rows.
3. A `SOUL.md` change pushed to the config fixture plus a signed request to
   `:9000` is applied and the gateway restarts.
4. A broken `config.yaml` pushed the same way is rolled back and recorded.

`dependabot.yml` gains the `docker-compose` ecosystem, so each Hermes bump is a
pull request whose smoke test restores through the new image's migrations
before merge.
