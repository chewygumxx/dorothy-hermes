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

- A fresh server becomes Dorothy, with her personality, memories, skills,
  scheduled jobs and conversation history, from a clone of this repository,
  one private key and `mise run up`.
- Config pushed to `dorothy-config` reaches the running agent within seconds,
  and a broken config never takes the agent offline.
- What the agent learns (memories, skills it writes, scheduled jobs, sessions)
  reaches `dorothy-memory` within one sync interval, and nothing ever
  overwrites that repository's history.
- Upgrading Hermes is a reviewed pull request whose CI proves that a restore
  through the new version's migrations boots.

## Constraints

- The upstream image `nousresearch/hermes-agent` runs as published: no derived
  image, no build step, no registry. Our code is bind-mounted into it, and the
  `dorothy-sync` sidecar runs the same image with a different entrypoint.
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
- Memory providers other than Hermes's built-in Markdown memory. Plugin
  stores such as `memory_store.db` are not synced.

## Architecture

```text
dorothy-hermes (this repo, deployed)       dorothy-config (you edit)
  compose.yaml                               SOUL.md
  .env              dotenvx-encrypted        config.yaml
  mise.toml         adds node, dotenvx       skills/<name>/...
  hermes/
    known_hosts     GitHub SSH host keys   dorothy-memory (sidecar writes)
    cont-init.d/                             memories/MEMORY.md
      005-dorothy-bootstrap                  memories/USER.md
    cont-finish.d/                           skills/<category>/<name>/...
      dorothy-final-snapshot                 cron/jobs.json
    s6-rc.d/                                 sessions/state.sql
      dorothy-snapshot/    (run, type, dependencies.d)
      dorothy-webhook/     (run, type, dependencies.d)
      user/contents.d/dorothy-snapshot   (empty registration files)
      user/contents.d/dorothy-webhook
    src/            TypeScript entry points and modules
```

### Containers

| Service        | Trust                                    | Secrets it holds                                       |
| -------------- | ---------------------------------------- | ------------------------------------------------------ |
| `hermes`       | Untrusted: the agent can become root (S4) | LLM credential, platform tokens, config key, webhook secret |
| `dorothy-sync` | Trusted                                  | Memory deploy key only                                 |
| `cloudflared`  | Edge                                     | `TUNNEL_TOKEN` only                                    |

The memory deploy key is the one secret that would give the agent power it
does not already have, so it lives in a container the agent cannot reach.

### Volumes

| Volume            | In `hermes`                       | In `dorothy-sync`                  | Contents                 |
| ----------------- | --------------------------------- | ---------------------------------- | ------------------------ |
| `hermes-data`     | `/opt/data`, read-write           | not mounted                        | Hermes state             |
| `dorothy-outbox`  | `/var/lib/dorothy/outbox`, rw     | `/var/lib/dorothy/outbox`, ro      | `bundle.json`            |
| `dorothy-restore` | `/var/lib/dorothy/restore`, ro    | `/var/lib/dorothy/restore`, rw     | `restore.json`           |
| `dorothy-state`   | not mounted                       | `/var/lib/dorothy/state`, rw       | memory checkout, status  |

Data crosses between the two containers only as two single files, each
written by one side and mounted read-only on the other. Remounting read-write
needs `CAP_SYS_ADMIN`, which neither container has (S10).

### Compose stack

- `hermes`: `nousresearch/hermes-agent:<calver>@sha256:<digest>`, command
  `gateway run`, the volumes above, and `hermes/` bind-mounted read-only:
  - `hermes/cont-init.d/005-dorothy-bootstrap` to
    `/etc/cont-init.d/005-dorothy-bootstrap`
  - `hermes/cont-finish.d/dorothy-final-snapshot` to
    `/etc/cont-finish.d/dorothy-final-snapshot`
  - each `hermes/s6-rc.d/<service>` directory and registration file to the same
    path under `/etc/s6-overlay/s6-rc.d/`
  - `hermes/src` and `hermes/known_hosts` to `/opt/dorothy/`

  Compose secrets `config_deploy_key` and `webhook_secret`. Environment: the
  LLM credential, platform tokens, allowlists and non-secret settings below,
  `S6_BEHAVIOUR_IF_STAGE2_FAILS=2`, and `S6_KILL_FINISH_MAXTIME=60000` within
  `stop_grace_period: 90s`. `tmpfs: /run:exec`. Hardening as S10.
  `restart: unless-stopped`. `depends_on: dorothy-sync` with
  `condition: service_healthy`. A `healthcheck` runs
  `/command/s6-setuidgid hermes /usr/local/bin/node /opt/dorothy/src/health.ts`
  with `start_period: 6m`. No ports (S9).
- `dorothy-sync`: the same image and digest, `entrypoint:
  ["/usr/local/bin/node", "/opt/dorothy/src/sidecar.ts"]` (no s6),
  `user: "10000:10000"`, `read_only: true`, tmpfs at `/tmp` and at `/opt/data`
  (the image declares `VOLUME /opt/data`; the tmpfs stops Docker creating an
  anonymous volume there). Compose secret `memory_deploy_key`. `hermes/src`
  and `hermes/known_hosts` bind-mounted read-only as above. Environment:
  `PATH=/usr/local/bin:/usr/bin:/bin`, `HOME=/opt/data`,
  `GIT_CONFIG_GLOBAL=/dev/null`, `GIT_CONFIG_NOSYSTEM=1`, and its settings.
  Its own network, `sync`, shared with nothing. `stop_grace_period: 60s`,
  `restart: unless-stopped`, hardening as S10. A `healthcheck` runs
  `node /opt/dorothy/src/sidecar-health.ts` with `start_period: 6m`.
- `cloudflared`: `cloudflare/cloudflared` pinned the same way, `tunnel run`
  with `TUNNEL_TOKEN`, hardened as S10. The tunnel routes the webhook
  hostname to `http://hermes:9000` and everything else to `http_status:404`
  (S8). It sits in the compose profile `tunnel`, which `mise run up` enables
  and CI does not.

UID 10000 is `hermes` in the image's `/etc/passwd`, which ssh requires. The
sidecar shares no writable path with the `hermes` container, so sharing the
number grants nothing.

### Paths in the `hermes` container

| Path                                   | Contents                                        |
| -------------------------------------- | ----------------------------------------------- |
| `/opt/data/SOUL.md`, `config.yaml`     | copied from `dorothy-config`                    |
| `/opt/data/dorothy/config/`            | `dorothy-config` checkout                       |
| `/opt/data/dorothy/last-good/`         | `SOUL.md`, `config.yaml` last confirmed working |
| `/opt/data/dorothy/restored`           | restore-complete sentinel with the memory SHA   |
| `/opt/data/dorothy/status/`            | `apply.json`, `snapshot.json`                   |
| `/run/dorothy/config.key`              | config deploy key copy (`0600`, tmpfs)          |
| `/run/dorothy/*.lock`                  | lock directories (tmpfs)                        |

### Paths in the `dorothy-sync` container

| Path                                   | Contents                                        |
| -------------------------------------- | ----------------------------------------------- |
| `/var/lib/dorothy/state/memory/`       | `dorothy-memory` checkout                       |
| `/var/lib/dorothy/state/status.json`   | sync status                                     |
| `/tmp/dorothy/memory.key`              | memory deploy key copy (`0600`, tmpfs)          |

Config files are copied, never symlinked: upstream's boot hook refuses to
operate through symlinked paths. Hand-written skills are not copied: the user's
`config.yaml` lists `/opt/data/dorothy/config/skills` in `skills.external_dirs`,
which Hermes loads read-only.

### Repository access

Two GitHub deploy keys: read-only on `dorothy-config`, held by `hermes`;
read-write on `dorothy-memory`, held only by `dorothy-sync` (S1). Compose
mounts secrets world-readable, which ssh refuses for private keys, so each
side copies its key to a `0600` file on tmpfs at startup. Each git invocation
sets `GIT_SSH_COMMAND` to `/usr/bin/ssh -F none -i <key> -o IdentitiesOnly=yes
-o UserKnownHostsFile=/opt/dorothy/known_hosts -o StrictHostKeyChecking=yes`
and runs with its working directory inside its own checkout. Commits are
authored as `Dorothy <noreply@dorothy.invalid>`.

## Source layout

Every module that talks to the outside world takes its collaborators as
parameters, so tests substitute fakes.

```text
hermes/src/
  package.json       {"type": "module"}
  bootstrap.ts       entry (hermes): config checkout and apply, restore
  snapshot.ts        entry (hermes): fallback apply, backup, dump, redact,
                     write bundle.json; --once, --final
  webhook.ts         entry (hermes): HTTP listener, applies, boot check
  health.ts          entry (hermes): healthcheck
  sidecar.ts         entry (dorothy-sync): fetch, restore.json, publish loop
  sidecar-health.ts  entry (dorothy-sync): healthcheck
  bundle.ts          the bundle format: write, open and validate (S2)
  redact.ts          replace known secret values (S5)
  dump.ts            dumpDatabase(path) -> SQL text; restoreDatabase(sql, path)
  config.ts          applyConfig(), last-good copies, rollback
  git.ts             thin wrapper over the git binary (execFile, never a shell)
  hermes.ts          HermesCli: snapshot(label), deleteSnapshot(id),
                     restartGateway(), gatewayUp()
  status.ts          read and write status files atomically (temp, rename)
  lock.ts            withLock(name, fn): mkdir lock recording its owner's pid
  settings.ts        reads and validates the environment once, at startup
```

Shell stubs in the `hermes` container only prepare and drop privileges, using
absolute paths (`/command/s6-setuidgid`, `/usr/local/bin/node`): upstream puts
the agent-writable `/opt/data/.local/bin` on `PATH`. This is for correctness;
inside that container it is not a security control (S4).

- `005-dorothy-bootstrap` (root): creates `/run/dorothy` owned by `hermes`,
  then runs `bootstrap.ts` as `hermes`.
- `dorothy-snapshot/run`, `dorothy-webhook/run`: run their entry as `hermes`.
- `dorothy-final-snapshot`: runs `snapshot.ts --final` as `hermes`.

## Bundle format

One format serves both directions (`bundle.json` and `restore.json`):

```json
{
  "version": 1,
  "createdAt": "<ISO time>",
  "memorySha": "<restore only: the checkout commit>",
  "seed": false,
  "files": [
    {
      "path": "sessions/state.sql",
      "mode": 420,
      "encoding": "utf8",
      "content": "..."
    }
  ]
}
```

- `mode` is `0644` or `0755`; `encoding` is `utf8` or `base64`.
- Paths are relative and lie under `memories/`, `skills/`, or are exactly
  `sessions/state.sql` or `cron/jobs.json`, with no empty, `.` or `..` segment
  and no segment starting with `.`.
- Writers use a temporary file in the same directory, then rename.
- `seed: true` with no files means a brand-new `dorothy-memory` (first boot).

## Boot

Compose starts `dorothy-sync` first and `hermes` once it is healthy, so
`restore.json` always reflects the memory checkout's current head.

### Sidecar startup

1. Copy the key to tmpfs. Remove a stale `.git/index.lock`; the sidecar is the
   only git user of its checkout.
2. Clone `dorothy-memory` into `/var/lib/dorothy/state/memory`, or fetch it
   and fast-forward when the local branch is behind. Unpushed local commits
   are kept. A diverged history sets `pushRejected` and is left untouched
   (see Operations).
3. A remote with no commits is a first-ever deployment: `restore.json` is
   written with `seed: true`. A remote with commits but no
   `sessions/state.sql` fails startup.
4. Write `restore.json` from the checkout head.
5. Report healthy and start the publish loop.

When GitHub is unreachable: with an existing checkout, continue from the local
head and warn; without one, retry with exponential backoff for five minutes,
then exit non-zero. `restart: unless-stopped` retries, and `hermes` waits.

### `hermes` container

`005-dorothy-bootstrap` sorts before upstream's `01-hermes-setup`, so `01-`
finds our `SOUL.md` and `config.yaml` present, does not seed defaults, and runs
its config-schema migrations on ours.

`bootstrap.ts`, as `hermes`:

1. Validate settings (S6). Remove from `/opt/data/.env` every variable the
   deployment provides (upstream loads that file over the process
   environment), and empty the pairing stores (S6).
2. Copy the config key. Clone `dorothy-config`, or fetch it and hard-reset to
   `origin/main`; when GitHub is unreachable, use the existing checkout, or
   retry for five minutes and exit non-zero when there is none. Copy
   `SOUL.md` and `config.yaml` into `/opt/data`. Warn when `config.yaml` does
   not contain the string `/opt/data/dorothy/config/skills` (no YAML parser in
   the standard library). Record the SHA as `pendingSha` in
   `status/apply.json` for the boot check.
3. Restore, decided by `/opt/data/dorothy/restored`:
   - Present (warm): the volume wins; nothing is restored.
   - Absent (cold, including a restore interrupted part-way): read
     `restore.json`; `restoreDatabase` its `state.sql` into a temporary file
     and rename it over any existing `state.db`; write its memories, skills
     and `cron/jobs.json`, replacing what is there. When `seed` is true, keep
     Hermes's fresh state. Write `restored` with `memorySha` last.

Any failure exits non-zero, which stops the container.

### Boot check

`dorothy-webhook` starts by verifying the booted config, under `apply.lock`.
It waits up to 120 seconds for the gateway (the `gateway run` command
registers its s6 slot after cont-init), then applies the same test as an
apply: up and still up 10 seconds later. Success copies the config into
`last-good/` and records `appliedSha`. Failure with a `last-good/` copy that
differs restores it, restarts the gateway and sets `configRolledBack`.

## Sync

### Snapshot (`hermes` container)

`dorothy-snapshot` runs `snapshot.ts` every `DOROTHY_SYNC_INTERVAL` seconds
(default 900), starting one interval after boot, under `snapshot.lock`. It
returns without effect while `/opt/data/dorothy/restored` is missing.

1. Fetch `dorothy-config`; when `origin/main` differs from `appliedSha`, run
   the same apply as the webhook (the fallback for lost deliveries). Skipped
   when `apply.lock` is held, and with `--final`.
2. `hermes backup --quick --label dorothy-sync`. Read `state.db` and
   `cron/jobs.json` from the new directory under `/opt/data/state-snapshots/`,
   run `PRAGMA quick_check` on the copy (the command exits 0 even when a copy
   fails), dump it, and delete the snapshot directory.
3. Collect `memories/*.md`, `cron/jobs.json` and `skills/`, skipping
   dotfiles, symlinks, special files, and every `skills/<category>/<name>`
   whose `<name>` appears in `skills/.bundled_manifest` (lines `name:hash`).
4. Redact (S5) and write `bundle.json` to the outbox.
5. Write `status/snapshot.json`: `lastSuccessAt`, `lastError`.

`cont-finish.d/dorothy-final-snapshot` runs `snapshot.ts --final` once at
shutdown. s6-overlay v3 stops the `s6-rc` services before running
`cont-finish.d`, and `S6_KILL_FINISH_MAXTIME` gives it 60 seconds. Compose
stops `hermes` before `dorothy-sync`, which publishes the final bundle.

### Publish (`dorothy-sync`)

Every 30 seconds, and once on `SIGTERM`:

1. Open and validate `bundle.json` (S2). Stop when its content hash equals
   the last published one.
2. Refuse a bundle that lacks `sessions/state.sql` or `memories/MEMORY.md`
   while the checkout has them, unless `DOROTHY_ALLOW_EMPTY=1` (S13).
3. Mirror the bundle into the checkout, deleting files under `memories/`,
   `skills/` and `cron/` that it no longer lists.
4. Commit only when `git status --porcelain` is non-empty, with the message
   `chore(sync): Snapshot from <hostname>` and a body listing which of
   sessions, memories, skills and scheduled jobs changed.
5. Push `HEAD:refs/heads/main`, fast-forward only (explicit, so the first
   push to an empty repository works). A file over 95 MB fails loudly first
   (GitHub rejects files over 100 MB).
   - Network failure: the commit stays local; retried with backoff up to one
     interval.
   - Rejected because the remote has commits that are not ours: record
     `pushRejected` and stop pushing until a person resolves it. Never
     rebase, never force.
6. Rewrite `restore.json` from the new head.
7. Write `status.json`: `lastSuccessAt`, `lastError`, `pendingCommits`,
   `pushRejected`, `lastBundleAt`.

### Locking

In the `hermes` container, two lock directories under `/run/dorothy`:

- `snapshot.lock`: the snapshot loop, the final snapshot and a manual run.
- `apply.lock`: webhook applies, the fallback apply and the boot check.

Each lock records its owner's pid. A waiter that finds the owner gone removes
the lock; waits give up after ten minutes with an error. The fallback apply
skips a held `apply.lock` rather than waiting. The sidecar is one process and
needs no locks.

### Dump format

`dumpDatabase` produces deterministic SQL so that git diffs stay small:

- `PRAGMA foreign_keys=OFF;`, `BEGIN;`, then `PRAGMA user_version=<n>;`.
- Ordinary tables in name order: `CREATE TABLE` from `sqlite_master`, then one
  `INSERT` per row ordered by `rowid` (or primary key for `WITHOUT ROWID`).
- `sqlite_sequence` rows after every `CREATE TABLE`, since it exists only
  once an `AUTOINCREMENT` table does.
- FTS5 tables, their shadow tables, and the views and triggers that refer to
  them are omitted. Hermes's schema setup recreates them on first open and
  backfills them; the smoke test proves search works after a restore. When
  the pinned image does not backfill, the restore runs the rebuild through
  Hermes's own Python, which can load its `cjk_unicode61` tokenizer.
- Indexes, then views, then triggers, after all data, so restored triggers do
  not fire on restored rows.
- `COMMIT;`.

Values are SQL literals: integers read as `BigInt` and written exactly; reals
in the shortest round-trip form, always with a `.` or exponent, infinities as
`9e999` and `-9e999`; text with doubled single quotes; blobs as `X'<hex>'`;
`NULL`. Any other virtual table fails the dump loudly.

## Webhook

`dorothy-webhook` runs as `hermes` and listens with `node:http` on
`0.0.0.0:9000`, reachable only on the compose network. Its secret is
`/run/secrets/webhook_secret`.

1. Only `POST /github`; anything else is `404`. A content type other than
   `application/json` is `415`. Bodies over 1 MiB are `413`.
   `headersTimeout` is 10 s, `requestTimeout` 15 s, `keepAliveTimeout` 5 s.
2. HMAC-SHA256 of the raw body bytes, before parsing, compared to
   `X-Hub-Signature-256` with `timingSafeEqual`. Missing or wrong is `401`.
3. `ping` is `200`. A `push` whose `repository.full_name` equals
   `DOROTHY_CONFIG_REPO_NAME` and whose `ref` is `refs/heads/main` is accepted
   with `202`. Every other event is `202` and ignored.
4. Accepted pushes enqueue an apply and respond before it runs (GitHub times out
   after ten seconds). Applies run one at a time; any pushes arriving during an
   apply collapse into a single further apply.

An apply, under `apply.lock`:

1. `git fetch`; when `origin/main` equals `appliedSha`, stop. The payload only
   triggers work, so a replayed delivery causes at most a redundant fetch.
2. Hard-reset the checkout and copy `SOUL.md` and `config.yaml` in.
3. `hermes gateway restart`.
4. Up within 30 seconds and still up 10 seconds later: copy into `last-good/`,
   record `appliedSha`, clear `configRolledBack`. Otherwise restore
   `last-good/`, restart again, and set `configRolledBack` with the bad SHA.

"Up" means the gateway's s6 slot is running; it does not prove the config
does what was intended. Restarts interrupt any in-flight reply; config pushes
are rare and deliberate.

## Secrets and settings

`.env` is committed, encrypted with dotenvx (`.gitignore` gains `!.env`). The
server holds only `DOTENV_PRIVATE_KEY`, in a gitignored `.env.keys` (`0600`).
`mise.toml` pins `dotenvx` and Node 26.7 (the image's version); the `up` task
runs `dotenvx run -- docker compose --profile tunnel up -d`. Compose turns
the deploy keys and webhook secret into secrets sourced from the environment,
so each reaches only the services that list it. Decrypted values are visible
to `docker inspect`, which already implies root on the host.

| Variable                                         | Secret | Reaches                       |
| ------------------------------------------------ | ------ | ----------------------------- |
| `ANTHROPIC_API_KEY` or `CLAUDE_CODE_OAUTH_TOKEN` | yes    | `hermes` environment          |
| Platform tokens (e.g. `TELEGRAM_BOT_TOKEN`)      | yes    | `hermes` environment          |
| `*_ALLOWED_USERS` for each enabled platform      | no     | `hermes` environment (S6)     |
| `DOROTHY_CONFIG_DEPLOY_KEY`                      | yes    | `hermes` secret               |
| `DOROTHY_WEBHOOK_SECRET`                         | yes    | `hermes` secret               |
| `DOROTHY_MEMORY_DEPLOY_KEY`                      | yes    | `dorothy-sync` secret only    |
| `TUNNEL_TOKEN`                                   | yes    | `cloudflared` environment     |
| `DOROTHY_CONFIG_REPO`                            | no     | `hermes`                      |
| `DOROTHY_CONFIG_REPO_NAME`                       | no     | `hermes` (derived for GitHub) |
| `DOROTHY_SYNC_INTERVAL`                          | no     | `hermes`                      |
| `DOROTHY_MEMORY_REPO`                            | no     | `dorothy-sync`                |
| `DOROTHY_BUNDLE_MAX_BYTES`                       | no     | `dorothy-sync` (S2)           |
| `DOROTHY_ALLOW_EMPTY`                            | no     | `dorothy-sync`, normally unset |

Non-secret settings live in `compose.yaml`. Repository URLs accept any git URL,
which is how tests use `file://` remotes. `DOROTHY_CONFIG_REPO_NAME` defaults to
`owner/name` parsed from a GitHub URL and is required otherwise. `settings.ts`
rejects a missing or malformed variable at startup with a message naming it.

## Health and operations

`health.ts` (`hermes`) exits 1 when `restored` is missing, the snapshot's
`lastSuccessAt` is older than three intervals (after the first),
`configRolledBack` is set, or the gateway is down. `sidecar-health.ts` exits 1
before the first `restore.json` of the run, when `pushRejected` is set, or
when the newest bundle has gone unpublished, or no bundle has arrived, for
three intervals. Health is an operational signal, not a security control
(S13).

Logs go to stdout with `[dorothy-bootstrap]`, `[dorothy-snapshot]`,
`[dorothy-webhook]` and `[dorothy-sync]` prefixes.

- Fresh server: install Docker and mise, apply the host checklist (S11),
  clone, add `.env.keys`, `mise run up`. Once per account: the GitHub
  rulesets (S1, S7) and the Cloudflare rules (S8).
- Upgrade: read upstream's release notes and advisories, merge the
  Dependabot pull request once CI is green, then `git pull && mise run up`.
- Sync now: run `snapshot.ts --once` as `hermes` in the `hermes` service
  (`docker compose exec -u hermes hermes node <path> --once`); the sidecar
  publishes within 30 seconds.
- `pushRejected`: something else pushed to `dorothy-memory`. Remove the
  `dorothy-state` volume and restart `dorothy-sync`; it re-clones, and the
  next bundle commits the volume's state on top. Unpushed local commits are
  dropped, but the bundle carries everything they held.
- Human edits to `dorothy-memory` are not merged into a warm volume; the next
  bundle overwrites them in a new commit. To make one stick, push it, then
  cold boot (remove `hermes-data`).
- Recovering from bad memories: S13.

## Testing

Tests run with `node --test` under the mise-pinned Node 26.7 through a mise
task. They do not run through `bun run`, because `bunfig.toml` sets
`[run] bun = true`, which substitutes Bun for `node`; implementation confirms
`check` reaches Node 26.7. `tsconfig.json` includes `hermes/src` with
`@types/node` (a development dependency, never shipped), `noEmit`,
`allowImportingTsExtensions` and `erasableSyntaxOnly`, so syntax that type
stripping cannot run fails the check rather than the server. `HermesCli` is
faked; git runs for real against temporary bare repositories over `file://`.
Owner and path constants are parameters, so no unit test needs root.

- `dump`: a fixture database with ordinary and `WITHOUT ROWID` tables,
  `AUTOINCREMENT`, an FTS5 table with its triggers, indexes, views, blobs,
  integers beyond 2^53, whole-number reals and a `user_version` round-trips
  with identical rows and `user_version`; FTS objects are omitted; dumping
  twice is byte-identical; an unsupported virtual table fails.
- `bundle` and `redact`: the rules in S2 and the forms in S5.
- `snapshot`: exclusions; the `restored` guard; a failed `quick_check`; the
  snapshot directory is deleted; the fallback apply skips a held lock.
- `sidecar`: no commit without changes; mirrored deletions; the empty-state
  guard and its override; a non-fast-forward is recorded and never forced;
  local commits survive an unreachable remote; the first push to an empty
  remote; `seed` detection; a remote without `state.sql` fails; a stale
  `index.lock` is removed; `restore.json` follows the head.
- `webhook`: signatures; content type; repository name and branch filtering;
  `ping`; the body cap; timeouts; collapsing; rollback; the boot check.
- `lock`: a dead owner's lock is taken over; waits are bounded.
- `settings`: missing or malformed variables; a platform token without its
  allowlist; repository name derivation.
- `bootstrap`: cold, warm and interrupted restores; `seed`; an unreachable
  config remote; the `external_dirs` warning; `.env` and pairing cleanup.

### Smoke test

A CI job `smoke`, after `check`, runs the compose stack without the `tunnel`
profile against bare-repository fixtures mounted into both containers. The
config fixture enables only the API server (`API_SERVER_ENABLED=true`), so no
LLM or platform credentials are needed; the gateway's `:8642` health endpoint
stands in for a platform. The fixture `state.sql` was dumped by an earlier
image and is refreshed only deliberately, so every upgrade proves migration
from an older schema.

1. Cold boot from the memory fixture; both containers become healthy, and
   session search finds a fixture message (FTS backfill).
2. `snapshot.ts --once`; the sidecar commits to the memory fixture, and its
   `state.sql` restores to the fixture's rows.
3. A `SOUL.md` change pushed to the config fixture plus a signed request to
   `:9000` is applied and the gateway restarts.
4. A broken `config.yaml` pushed the same way is rolled back and recorded.
5. A first boot against an empty memory fixture seeds and pushes `main`.
6. The security design's smoke test additions.

`dependabot.yml` gains the `docker-compose` ecosystem, so each Hermes bump,
which updates both services' references, is a pull request whose smoke test
restores through the new image's migrations before merge.

## Implementation phasing

Three plans, each ending with green CI:

1. Libraries and unit tests: `dump`, `bundle`, `redact`, `git`, `lock`,
   `status`, `settings`, `config`, plus the tooling fixes.
2. Containers: `bootstrap`, `snapshot`, `sidecar`, both health checks,
   `compose.yaml` and the smoke test.
3. Config delivery: `webhook`, the boot check, `cloudflared` and the
   operator checklists.
