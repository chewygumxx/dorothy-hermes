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
- The agent is untrusted. The
  [security design](2026-10-03-hermes-security-design.md) sets the trust model
  and its threat identifiers (`S1` to `S15`) are cited below; where the two
  documents disagree, it wins.

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
    bin/dorothy-cycle                        memories/MEMORY.md
    cont-init.d/                             memories/USER.md
      005-dorothy-bootstrap                  skills/<agent-made>/...
    cont-finish.d/                           sessions/state.sql
      dorothy-final-sync
    s6-rc.d/
      dorothy-sync/                        (run, type, dependencies.d)
      dorothy-webhook/                     (run, type, dependencies.d)
      user/contents.d/dorothy-sync         (empty registration files)
      user/contents.d/dorothy-webhook
    src/            TypeScript entry points and modules
```

### Compose stack

- `hermes`: `nousresearch/hermes-agent:<calver>@sha256:<digest>`, command
  `gateway run`, named volumes `hermes-data` at `/opt/data` and
  `dorothy-state` at `/var/lib/dorothy` (S3), and `hermes/` bind-mounted
  read-only:
  - `hermes/cont-init.d/005-dorothy-bootstrap` to
    `/etc/cont-init.d/005-dorothy-bootstrap`
  - `hermes/cont-finish.d/dorothy-final-sync` to
    `/etc/cont-finish.d/dorothy-final-sync`
  - each `hermes/s6-rc.d/<service>` directory and registration file to the same
    path under `/etc/s6-overlay/s6-rc.d/`
  - `hermes/bin`, `hermes/src` and `hermes/known_hosts` to `/opt/dorothy/`

  No host ports are published (S9). Environment: the secrets below, the
  non-secret settings below, `S6_BEHAVIOUR_IF_STAGE2_FAILS=2`, and
  `S6_SERVICES_GRACETIME` matching `stop_grace_period: 90s`. Hardening
  (`no-new-privileges`, dropped capabilities, limits) is as S10. A
  `healthcheck` runs
  `/command/s6-setuidgid hermes node /opt/dorothy/src/health.ts`.
- `cloudflared`: `cloudflare/cloudflared` pinned the same way, `tunnel run`
  with `TUNNEL_TOKEN`, hardened as S10. The tunnel routes the webhook
  hostname to `http://hermes:9000` and everything else to `http_status:404`
  (S8). It sits in the compose profile `tunnel`, which `mise run up` enables
  and CI does not.

### Paths in the volume

| Path                                | Owner            | Contents                                  |
| ----------------------------------- | ---------------- | ----------------------------------------- |
| `/opt/data/SOUL.md`, `config.yaml`  | `hermes`         | copied from `dorothy-config`              |
| `/opt/data/dorothy/config/`         | `hermes`         | `dorothy-config` checkout                 |
| `/opt/data/dorothy/outbox/`         | `hermes`         | `bundle.json`, the hand-off to publish    |
| `/opt/data/dorothy/status/`         | `hermes`         | `apply.json`                              |
| `/var/lib/dorothy/memory/`          | `dorothy`        | `dorothy-memory` checkout                 |
| `/var/lib/dorothy/bootstrapped`     | root             | both commit SHAs, ISO time                |
| `/var/lib/dorothy/status/`          | `dorothy`        | `sync.json`                               |
| `/run/dorothy/private/`             | `dorothy`, 0700  | memory deploy key                         |
| `/run/dorothy/hermes/`              | `hermes`, 0750   | config key, webhook secret, `apply.lock`  |
| `/run/dorothy/sync.lock`            | root             | sync cycle lock                           |

`/run/dorothy` is tmpfs, so keys never touch disk and a container restart
clears stale locks.

Config files are copied, never symlinked: upstream's boot hook refuses to
operate through symlinked paths. Hand-written skills are not copied: the user's
`config.yaml` lists `/opt/data/dorothy/config/skills` in `skills.external_dirs`,
which Hermes loads read-only.

### Repository access

Two GitHub deploy keys: read-only on `dorothy-config`, read-write on
`dorothy-memory`. Only the publish step, running as `dorothy`, can read the
memory key (S1). Each git invocation sets `GIT_SSH_COMMAND` to
`ssh -i <key> -o IdentitiesOnly=yes
-o UserKnownHostsFile=/opt/dorothy/known_hosts -o StrictHostKeyChecking=yes`.
Commits are authored as `Dorothy <noreply@dorothy.invalid>`.

## Source layout

Every module that talks to the outside world takes its collaborators as
parameters, so tests substitute fakes.

```text
hermes/src/
  bootstrap.ts   entry (hermes): config checkout and apply, cold restore
  snapshot.ts    entry (hermes): fallback apply, backup, dump, write bundle
  publish.ts     entry (dorothy): validate bundle, redact, commit, push;
                 --fetch only clones or fetches the memory checkout
  webhook.ts     entry (hermes): the HTTP listener and apply queue
  health.ts      entry (hermes): exits 0 or 1 from status files and gateway
  bundle.ts      write the snapshot hand-off; open and validate it (S2)
  redact.ts      replace known secret values in bundle content (S5)
  dump.ts        dumpDatabase(path) -> SQL text; restoreDatabase(sql, path)
  config.ts      applyConfig(): copy files, keep *.prev, restore on rollback
  git.ts         thin wrapper over the git binary (execFile, never a shell)
  hermes.ts      HermesCli interface: backup(), restartGateway(), gatewayUp()
  status.ts      read and write status files atomically (write temp, rename)
  lock.ts        withLock(name, fn): mkdir-based lock, used for apply.lock
  settings.ts    reads and validates the environment once, at startup (S6)
```

Shell code is limited to stubs that prepare `/run/dorothy` and drop
privileges. They never touch a path `hermes` can write (S4).

- `005-dorothy-bootstrap` (root): boot steps 1 and 4 below, and runs steps 2
  and 3 through `s6-setuidgid`.
- `bin/dorothy-cycle` (root): takes `sync.lock`, runs `snapshot.ts` as
  `hermes`, then `publish.ts` as `dorothy` with the snapshot's exit status,
  and releases the lock. The `dorothy-sync` service, the final sync and a
  manual sync all run it.
- `dorothy-sync/run` (root): sleeps one interval, runs `dorothy-cycle`, and
  repeats.
- `dorothy-webhook/run`: `exec s6-setuidgid hermes node
  /opt/dorothy/src/webhook.ts`.

## Boot sequence

`005-dorothy-bootstrap` sorts before upstream's `01-hermes-setup`, so `01-`
finds our `SOUL.md` and `config.yaml` present, does not seed defaults, and runs
its config-schema migrations on ours. `02-reconcile-profiles` then starts the
gateway.

1. Root prepares:
   - adds the `dorothy` user (UID 10001, supplementary group `hermes`) when
     absent;
   - creates `/run/dorothy` and its subdirectories, writes the deploy keys and
     webhook secret into them, and deletes those variables from
     `/run/s6/container_environment` (S1);
   - sets the `/var/lib/dorothy` mount point to `dorothy:hermes`, `0750`;
   - records whether `/opt/data/state.db` exists (cold or warm volume).
2. As `dorothy`, `publish.ts --fetch`: clone `dorothy-memory` into
   `/var/lib/dorothy/memory`, or fetch it and fast-forward when the local
   branch is behind. Local commits not yet pushed are kept.
3. As `hermes`, `bootstrap.ts`:
   - Validate settings (S6).
   - Clone `dorothy-config`, or fetch it and hard-reset to `origin/main`. Copy
     `SOUL.md` and `config.yaml` into `/opt/data`. Warn when `config.yaml`
     does not contain the string `/opt/data/dorothy/config/skills` (no YAML
     parser in the standard library; the user's file declares
     `skills.external_dirs`).
   - Cold volume: `restoreDatabase` from the memory checkout's
     `sessions/state.sql` into a temporary file in `/opt/data`, then rename it
     to `state.db`; nothing has it open yet. Copy `memories/*.md` and
     `skills/*` into place.
   - Warm volume: the volume wins and nothing is copied from the memory
     checkout. The volume is never older than what it last pushed.
4. Root writes `/var/lib/dorothy/bootstrapped` with both commit SHAs.

Any failing step exits non-zero, which stops the container.

When GitHub is unreachable:

- Warm volume: continue with the last checkout, log a warning, and leave the
  retry to the sync loop.
- Cold volume: retry with exponential backoff for five minutes, then exit
  non-zero. `S6_BEHAVIOUR_IF_STAGE2_FAILS=2` stops the container.

A cold boot must never continue: it would run as generic Hermes with empty
memory, and the sync loop would then push that emptiness to `dorothy-memory`.

## Sync loop

`dorothy-sync` runs `dorothy-cycle` every `DOROTHY_SYNC_INTERVAL` seconds
(default 900), starting one interval after boot. Both steps return without
effect when `/var/lib/dorothy/bootstrapped` is missing.

The snapshot step, as `hermes`:

1. Fetches `dorothy-config` and, when `origin/main` moved, runs the same apply
   as the webhook (the fallback for lost deliveries).
2. Runs `hermes backup --quick -o <tmp>.zip`, extracts `state.db` to a
   temporary directory, and runs `dumpDatabase` on it.
3. Collects `memories/MEMORY.md`, `memories/USER.md`, and `skills/` except
   entries named in `skills/.bundled_manifest` and dotfiles.
4. Writes the dump and the collected files to
   `/opt/data/dorothy/outbox/bundle.json` (temporary file, then rename;
   mode `0640`).

The publish step, as `dorothy`:

1. Opens and validates the bundle (S2). When the snapshot step failed, it
   records that failure and only retries pushing pending commits.
2. Redacts known secret values (S5), then mirrors the bundle into the
   checkout, deletions included: files under `memories/` and `skills/` that
   the bundle no longer lists are removed.
3. Commits only when `git status --porcelain` is non-empty, with the message
   `chore(sync): Snapshot from <hostname>` and a body listing which of
   sessions, memories and skills changed.
4. Pushes, fast-forward only.
   - Network failure: the commit stays local; the next cycle pushes it.
   - Rejected because the remote has commits that are not ours: record
     `pushRejected` in `status/sync.json`, log an error each cycle, and stop
     pushing until a person resolves it. Never rebase, never force.
5. Writes `status/sync.json`: `lastSuccessAt`, `lastError`, `pendingCommits`,
   `pushRejected`.

### Locking and status

The sync cycle and the webhook are separate processes. Two locks, each a
directory created with `mkdir`, serialise them:

- `sync.lock` in root-owned `/run/dorothy`, held by `dorothy-cycle` around
  both steps, so the service loop, the final sync and a manual sync never
  overlap. Only the publish step writes `status/sync.json` or touches the
  memory checkout.
- `apply.lock` in `/run/dorothy/hermes`, around every config apply, whether
  the webhook or the snapshot step's fallback started it. Only an apply
  writes `status/apply.json`.

A process waits for a held lock rather than skipping its work, except the
snapshot step's fallback apply, which skips when `apply.lock` is held (the
holder is already applying).

`cont-finish.d/dorothy-final-sync` runs `dorothy-cycle` once at shutdown.
Implementation confirms s6-overlay v3's stage 3 order (whether the gateway is
already down); either order is safe because `hermes backup` is consistent.

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

`dorothy-webhook` runs as `hermes` and listens with `node:http` on
`0.0.0.0:9000`, reachable only on the compose network. It reads its secret
from `/run/dorothy/hermes/webhook.secret`.

1. Only `POST /github`; anything else is `404`. Bodies over 1 MiB are `413`.
   `headersTimeout` is 10 s, `requestTimeout` 15 s, `keepAliveTimeout` 5 s
   (S8).
2. HMAC-SHA256 of the raw body bytes, before parsing, compared to
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
`docker inspect`, which already implies root on the host. The bootstrap stub
moves the deploy keys and webhook secret into `/run/dorothy` and removes them
from the environment Hermes and its children receive (S1).

| Variable                                         | Secret | Consumer              |
| ------------------------------------------------ | ------ | --------------------- |
| `ANTHROPIC_API_KEY` or `CLAUDE_CODE_OAUTH_TOKEN` | yes    | Hermes                |
| Platform tokens (e.g. `TELEGRAM_BOT_TOKEN`)      | yes    | Hermes                |
| `DOROTHY_CONFIG_DEPLOY_KEY` (base64)             | yes    | bootstrap stub        |
| `DOROTHY_MEMORY_DEPLOY_KEY` (base64)             | yes    | bootstrap stub        |
| `DOROTHY_WEBHOOK_SECRET`                         | yes    | bootstrap stub        |
| `TUNNEL_TOKEN`                                   | yes    | cloudflared           |
| `*_ALLOWED_USERS` for each enabled platform      | no     | Hermes, settings (S6) |
| `DOROTHY_CONFIG_REPO`, `DOROTHY_MEMORY_REPO`     | no     | bootstrap, sync       |
| `DOROTHY_SYNC_INTERVAL`                          | no     | sync                  |
| `DOROTHY_BUNDLE_MAX_BYTES`                       | no     | publish (S2)          |

Non-secret settings live in `compose.yaml`. Repository URLs accept any git URL,
which is how tests use `file://` remotes. `settings.ts` rejects a missing or
malformed variable at startup with a message naming it.

## Health and operations

`health.ts` reads both status files and exits 1 when any of these hold, and 0
otherwise:

- `/var/lib/dorothy/bootstrapped` is missing.
- `lastSuccessAt` is older than three sync intervals (after the first
  interval).
- `pushRejected` or `configRolledBack` is set.
- `hermes` reports the gateway down.

The health check is an operational signal, not a security control: the
agent can write `status/apply.json` (S13).

Logs go to stdout with `[dorothy-bootstrap]`, `[dorothy-sync]` and
`[dorothy-webhook]` prefixes, read with `docker compose logs`.

- Fresh server: install Docker and mise, apply the host checklist (S11),
  clone, add `.env.keys`, `mise run up`. Once per account: the GitHub
  rulesets (S1, S7) and the Cloudflare rules (S8).
- Upgrade: read upstream's release notes and advisories, merge the
  Dependabot pull request once CI is green, then `git pull && mise run up` on
  the server.
- Sync now: `docker compose exec hermes /opt/dorothy/bin/dorothy-cycle`.

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
- `snapshot`: bundled-skill and dotfile exclusion; the bootstrap-marker
  guard; the fallback apply skips while `apply.lock` is held.
- `publish`: no commit without changes; mirrored deletions; the
  bootstrap-marker guard; a non-fast-forward is recorded and never forced;
  local commits survive an unreachable remote; a failed snapshot still
  pushes pending commits; `--fetch` keeps unpushed local commits.
- `bundle` and `redact`: the rejections in S2 and the redaction forms in S5.
- `settings`: missing or malformed variables; a platform token without its
  allowlist (S6).
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
2. `dorothy-cycle` commits to the memory fixture, and its `state.sql`
   restores to the sample's rows.
3. A `SOUL.md` change pushed to the config fixture plus a signed request to
   `:9000` is applied and the gateway restarts.
4. A broken `config.yaml` pushed the same way is rolled back and recorded.
5. The security design's smoke test additions.

`dependabot.yml` gains the `docker-compose` ecosystem, so each Hermes bump is a
pull request whose smoke test restores through the new image's migrations
before merge.
