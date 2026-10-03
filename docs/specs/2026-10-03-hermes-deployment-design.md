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
  `dorothy-init` and `dorothy-sync` services run the same image with other
  entrypoints.
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
- Sharding `state.sql` per session, until the size warning below fires.
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
      dorothy-snapshot/    (run, type, dependencies.d/base)
      dorothy-webhook/     (run, type, dependencies.d/base)
      user/contents.d/dorothy-snapshot   (empty registration files)
      user/contents.d/dorothy-webhook
    src/            TypeScript entry points and modules
```

### Services

| Service        | Trust                                     | Secrets it holds                                         |
| -------------- | ----------------------------------------- | -------------------------------------------------------- |
| `dorothy-init` | Trusted, one-shot                         | None                                                     |
| `dorothy-sync` | Trusted                                   | Memory deploy key only                                   |
| `hermes`       | Untrusted: the agent can become root (S4) | LLM credential, platform tokens, config key, webhook secret |
| `cloudflared`  | Edge                                      | `TUNNEL_TOKEN` only                                      |

The memory deploy key is the one secret that would give the agent power it
does not already have, so it lives in a container the agent cannot reach.

### Volumes

| Volume            | In `hermes`                    | In `dorothy-sync`               | Contents                       |
| ----------------- | ------------------------------ | ------------------------------- | ------------------------------ |
| `hermes-data`     | `/opt/data`, rw                | not mounted                     | Hermes state                   |
| `dorothy-outbox`  | `/var/lib/dorothy/outbox`, rw  | `/var/lib/dorothy/outbox`, ro   | `bundle.json`                  |
| `dorothy-restore` | `/var/lib/dorothy/restore`, ro | `/var/lib/dorothy/restore`, rw  | `restore.json`, `status.json`  |
| `dorothy-state`   | not mounted                    | `/var/lib/dorothy/state`, rw    | memory checkout, `generation`  |

Data crosses between `hermes` and `dorothy-sync` only as single files, each
written by one side and mounted read-only on the other. Remounting read-write
needs `CAP_SYS_ADMIN`, which no service has (S10). Docker creates each volume
root as `root:root`; `dorothy-init` hands the three `dorothy-*` roots to UID
10000 before anything else starts.

### Compose stack

- `dorothy-init`: the pinned image, `user: "0:0"`, `entrypoint:
  ["/bin/chown", "10000:10000", "/v/outbox", "/v/restore", "/v/state"]` with
  the three `dorothy-*` volumes at those paths. Not recursive: volume roots
  only. `cap_drop: [ALL]`, `cap_add: [CHOWN]`, `read_only: true`,
  `network_mode: none`, `restart: "no"`.
- `dorothy-sync`: the pinned image, `entrypoint:
  ["/usr/local/bin/node", "/opt/dorothy/src/sidecar.ts"]` (no s6),
  `init: true` (to reap git and ssh children), `user: "10000:10000"`,
  `read_only: true`, tmpfs at `/tmp` and at `/opt/data` (the image declares
  `VOLUME /opt/data`; the tmpfs stops Docker creating an anonymous volume).
  `hermes/src` and `hermes/known_hosts` bind-mounted read-only to
  `/opt/dorothy/`. Environment: `DOROTHY_MEMORY_DEPLOY_KEY`, its settings,
  `PATH=/usr/local/bin:/usr/bin:/bin`, `HOME=/opt/data`,
  `GIT_CONFIG_GLOBAL=/dev/null`, `GIT_CONFIG_NOSYSTEM=1`. Its own network,
  `sync`, shared with nothing. `depends_on: dorothy-init` with
  `condition: service_completed_successfully`. `stop_grace_period: 60s`,
  `restart: unless-stopped`, hardening as S10. A `healthcheck` runs
  `/usr/local/bin/node /opt/dorothy/src/sidecar-health.ts` with
  `start_period: 6m`.
- `hermes`: the pinned image, command `gateway run`, the volumes above, and
  `hermes/` bind-mounted read-only:
  - `hermes/cont-init.d/005-dorothy-bootstrap` to
    `/etc/cont-init.d/005-dorothy-bootstrap`
  - `hermes/cont-finish.d/dorothy-final-snapshot` to
    `/etc/cont-finish.d/dorothy-final-snapshot`
  - each `hermes/s6-rc.d/<service>` directory and registration file to the same
    path under `/etc/s6-overlay/s6-rc.d/`
  - `hermes/src` and `hermes/known_hosts` to `/opt/dorothy/`

  Environment: the LLM credential, platform tokens, allowlists,
  `DOROTHY_CONFIG_DEPLOY_KEY`, `DOROTHY_WEBHOOK_SECRET`, non-secret settings,
  `S6_BEHAVIOUR_IF_STAGE2_FAILS=2`, and `S6_KILL_FINISH_MAXTIME=60000` within
  `stop_grace_period: 90s`. `tmpfs: /run:exec`. Hardening as S10.
  `restart: unless-stopped`. `depends_on: dorothy-sync` with
  `condition: service_healthy`. A `healthcheck` runs
  `/command/s6-setuidgid hermes /usr/local/bin/node /opt/dorothy/src/health.ts`
  with `start_period: 6m`. No ports (S9).
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
| `/opt/data/dorothy/restored`           | restore-complete sentinel: memory SHA, generation |
| `/opt/data/dorothy/status/`            | `apply.json`, `snapshot.json`                   |
| `/run/dorothy/config.key`              | config deploy key (`0600`, tmpfs)               |
| `/run/dorothy/*.lock`                  | lock directories (tmpfs)                        |

### Paths in the `dorothy-sync` container

| Path                                   | Contents                                        |
| -------------------------------------- | ----------------------------------------------- |
| `/var/lib/dorothy/state/memory/`       | `dorothy-memory` checkout                       |
| `/var/lib/dorothy/state/generation`    | random id minted with a fresh checkout          |
| `/var/lib/dorothy/restore/status.json` | sync status, readable by `hermes` health        |
| `/tmp/dorothy/memory.key`              | memory deploy key (`0600`, tmpfs)               |

Config files are copied, never symlinked: upstream's boot hook refuses to
operate through symlinked paths. Hand-written skills are not copied: the user's
`config.yaml` lists `/opt/data/dorothy/config/skills` in `skills.external_dirs`,
which Hermes loads read-only.

### Repository access

Two GitHub deploy keys: read-only on `dorothy-config`, held by `hermes`;
read-write on `dorothy-memory`, held only by `dorothy-sync` (S1). Each side
writes its key from the environment to a `0600` file on tmpfs at startup.
Each git invocation sets `GIT_SSH_COMMAND` to `/usr/bin/ssh -F none -i <key>
-o IdentitiesOnly=yes -o UserKnownHostsFile=/opt/dorothy/known_hosts
-o StrictHostKeyChecking=yes` and runs with its working directory inside its
own checkout. Commits are authored as `Dorothy <noreply@dorothy.invalid>`.

## Source layout

Every module that talks to the outside world takes its collaborators as
parameters, so tests substitute fakes.

```text
hermes/src/
  package.json       {"type": "module"}
  tsconfig.json      types: ["node"], separate from the repo's Bun config
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
                     restartGateway(), startGateway(), gatewayStatus()
  status.ts          read and write status files atomically (temp, rename)
  lock.ts            withLock(name, fn): mkdir lock recording its owner's pid
  settings.ts        reads and validates the environment once, at startup
```

Shell stubs in the `hermes` container begin `#!/command/with-contenv sh`, set
`HOME=/opt/data` as upstream's do, and use absolute paths
(`/command/s6-setuidgid`, `/usr/local/bin/node`): upstream puts the
agent-writable `/opt/data/.local/bin` on `PATH`. This is for correctness;
inside that container it is not a security control (S4).

- `005-dorothy-bootstrap` (root): creates `/run/dorothy` owned by `hermes`,
  then runs `bootstrap.ts` as `hermes`.
- `dorothy-snapshot/run`, `dorothy-webhook/run`: run their entry as `hermes`.
- `dorothy-final-snapshot`: runs `snapshot.ts --final` as `hermes`.

Entries that spawn long-running children (`hermes backup`, git) forward
`SIGTERM` to them before exiting.

## Bundle format

One format serves both directions (`bundle.json` and `restore.json`):

```json
{
  "version": 1,
  "createdAt": "<ISO time>",
  "generation": "<sidecar generation>",
  "memorySha": "<restore only: the checkout commit>",
  "bundleHash": "<restore only: sha256 of the last bundle consumed>",
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
- Writers use a temporary file in the same directory, then rename. Readers of
  a directory tree (the snapshot over `/opt/data`, the sidecar over its
  checkout) never follow symlinks.
- `seed: true` with no files means a brand-new `dorothy-memory` (first boot).
- A bundle carries the `generation` of the `restore.json` its snapshot read.
  The sidecar refuses bundles from any other generation, so a bundle written
  before a reset of `dorothy-state` can never be published after it (S13).

## Boot

Compose runs `dorothy-init`, then starts `dorothy-sync`, then `hermes` once
the sidecar is healthy, so `restore.json` exists and reflects the checkout.

### Sidecar startup

1. Write the key to tmpfs. Remove a stale `.git/index.lock`; the sidecar is
   the only git user of its checkout.
2. Clone `dorothy-memory` into `/var/lib/dorothy/state/memory` and mint a new
   `generation`, or fetch an existing checkout and fast-forward when the
   local branch is behind. Unpushed local commits are kept. A diverged
   history sets `pushRejected` and is left untouched (see Operations).
3. A local branch with no commits is a first-ever deployment: `restore.json`
   is written with `seed: true`. A local head without `sessions/state.sql`
   fails startup.
4. Write `restore.json` from the local head, with the generation and the
   hash of the last bundle consumed (none after a fresh clone).
5. Report healthy and start the publish loop. Health reflects only whether
   the sidecar can serve a restore; `pushRejected` and errors are reported
   through `status.json` (see Health).

When GitHub is unreachable: with an existing checkout, continue from the local
head and warn; without one, retry with exponential backoff for five minutes,
then exit non-zero. `restart: unless-stopped` retries, and `hermes` waits.

### `hermes` container

`005-dorothy-bootstrap` sorts before upstream's `01-hermes-setup`, so `01-`
finds our `SOUL.md` and `config.yaml` present, does not seed defaults, and runs
its config-schema migrations on ours.

`bootstrap.ts`, as `hermes`:

1. Validate settings (S6). Remove from `/opt/data/.env` every variable the
   deployment provides and every allowlist and allow-all variable in the
   pinned image's platform registry (upstream loads that file over the
   process environment). Empty `/opt/data/pairing/` and
   `/opt/data/platforms/pairing/`.
2. Write the config key. Clone `dorothy-config`, or fetch it and hard-reset to
   `origin/main`; when GitHub is unreachable, use the existing checkout, or
   retry for five minutes and exit non-zero when there is none. Unless the
   head equals `rolledBackSha` in `status/apply.json`, copy `SOUL.md` and
   `config.yaml` into `/opt/data`. Warn when `config.yaml` does not contain
   the string `/opt/data/dorothy/config/skills` (no YAML parser in the
   standard library).
3. Restore, decided by `/opt/data/dorothy/restored`:
   - Present (warm): the volume wins; nothing is restored.
   - Absent (cold, including a restore interrupted part-way):
     1. Wait up to two minutes for the sidecar to consume the outbox: until
        `restore.json`'s `bundleHash` matches the outbox bundle, or the outbox
        bundle is absent or of another generation. On timeout, warn and
        continue (at most one interval is lost).
     2. Delete `state.db-wal`, `state.db-shm` and `state.db-journal`, then
        `restoreDatabase` the `state.sql` into a temporary file and rename it
        over any existing `state.db`.
     3. Write the memories, skills and `cron/jobs.json`, replacing what is
        there. When `seed` is true, keep Hermes's fresh state instead.
     4. Run `hermes sessions optimize-storage` to build the CJK search index
        (see Dump format).
     5. Write `restored` with `memorySha` and `generation` last.

Any failure exits non-zero, which stops the container.

### Boot check

`dorothy-webhook` starts by verifying the booted config, under `apply.lock`.
It waits up to 120 seconds for the `gateway run` command to register the
`gateway-default` slot, then applies the gateway test below. Success copies
the config into `last-good/` and records `appliedSha`. Failure, when a
`last-good/` copy differs, rolls back as an apply does.

## Sync

### Snapshot (`hermes` container)

`dorothy-snapshot` runs `snapshot.ts` every `DOROTHY_SYNC_INTERVAL` seconds
(default 900), starting one interval after boot, under `snapshot.lock`. It
returns without effect while `/opt/data/dorothy/restored` is missing.

1. Fetch `dorothy-config`; when `origin/main` differs from both `appliedSha`
   and `rolledBackSha`, run the same apply as the webhook (the fallback for
   lost deliveries). Skipped when `apply.lock` is held, and with `--final`.
2. `hermes backup --quick --label dorothy-sync`, which creates
   `/opt/data/state-snapshots/<timestamp>-dorothy-sync` (with a `-<n>` suffix
   on collision). Fail when its `manifest.json` lists `state.db` among
   `failed_dbs`. Run `PRAGMA quick_check(<table>)` on each ordinary table of
   the copy (a whole-database check would connect the FTS tables, whose CJK
   tokenizer Node cannot load). Dump it, read `cron/jobs.json` from the same
   snapshot, and delete the snapshot directory.
3. Collect `memories/*.md` and `skills/`, skipping dotfiles, symlinks,
   special files, and every `skills/<category>/<name>` whose `<name>` appears
   in `skills/.bundled_manifest` (lines `name:hash`). A user skill that
   shares a bundled skill's name is therefore not synced; agent-made skills
   need unique names.
4. Read `generation` from `restore.json`, redact (S5), and write
   `bundle.json` to the outbox.
5. Write `status/snapshot.json`: `lastSuccessAt`, `lastError`.

`cont-finish.d/dorothy-final-snapshot` runs `snapshot.ts --final` once at
shutdown, retrying the backup lock for 30 seconds in case an interrupted
snapshot's child still holds it. s6-overlay v3 stops our `s6-rc` services
before `cont-finish.d`; the gateway, a dynamic slot, may still be running,
which is safe because the backup is consistent. `S6_KILL_FINISH_MAXTIME`
gives the script 60 seconds. `docker compose down` stops `hermes` before
`dorothy-sync`, which publishes the final bundle on its way out. A host or
daemon shutdown stops containers in parallel; the final bundle then waits in
the outbox and is published at the next boot.

### Publish (`dorothy-sync`)

Every 30 seconds, and once on `SIGTERM`:

1. Open and validate `bundle.json` (S2). Stop when its hash equals the last
   consumed one or its generation differs from the sidecar's.
2. Refuse a bundle that lacks `sessions/state.sql` or `memories/MEMORY.md`
   while the checkout has them, unless `DOROTHY_ALLOW_EMPTY=1` (S13).
3. Fetch, and fast-forward when there are no unpushed commits, so that human
   edits are built on rather than rejected.
4. Mirror the bundle into the checkout, deleting files under `memories/`,
   `skills/` and `cron/` that it no longer lists.
5. Commit only when `git status --porcelain` is non-empty, with the message
   `chore(sync): Snapshot from <hostname>` and a body listing which of
   sessions, memories, skills and scheduled jobs changed.
6. Push `HEAD:refs/heads/main`, fast-forward only (explicit, so the first
   push to an empty repository works).
   - Network failure: the commit stays local; retried with backoff up to one
     interval.
   - Rejected because the remote moved while commits were unpushed: record
     `pushRejected` and stop pushing until a person resolves it. Never
     rebase, never force.
7. Record the bundle's hash as consumed and rewrite `restore.json` from the
   new head.
8. Write `status.json`: `lastSuccessAt`, `lastError`, `pendingCommits`,
   `pushRejected`, `lastBundleAt`, `largestFileBytes`.

A file over 80 MB sets a size warning; one over 95 MB fails the publish
(GitHub rejects files over 100 MB). The warning is the trigger to bring
`state.sql` sharding into scope.

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
- Omitted: `sqlite_stat*` (reserved names that cannot be created), FTS5
  tables and their shadow tables, the views and triggers that refer to them,
  and `fts_v22_trash_*` tables (orphaned index data).
- Indexes, then views, then triggers, after all data, so restored triggers do
  not fire on restored rows.
- `COMMIT;`.

After a restore, Hermes's first open recreates and rebuilds the base and
trigram FTS indexes. It creates the CJK index empty with backfill markers,
which `hermes sessions optimize-storage` (boot step 3.4) fills. The smoke test
proves search works after a restore.

Values are SQL literals: integers read as `BigInt` and written exactly; reals
in the shortest round-trip form, always with a `.` or exponent, infinities as
`9e999` and `-9e999`; text with doubled single quotes; blobs as `X'<hex>'`;
`NULL`. Any other virtual table fails the dump loudly.

## Webhook

`dorothy-webhook` runs as `hermes` and listens with `node:http` on
`0.0.0.0:9000`, reachable only on the compose network.

1. Only `POST /github`; anything else is `404`. A content type other than
   `application/json` is `415`. Bodies over 1 MiB are `413`.
   `headersTimeout` is 10 s, `requestTimeout` 15 s, `keepAliveTimeout` 5 s.
2. HMAC-SHA256 of the raw body bytes with `DOROTHY_WEBHOOK_SECRET`, before
   parsing, compared to `X-Hub-Signature-256` with `timingSafeEqual`.
   Missing or wrong is `401`.
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
3. `hermes gateway restart`, then `hermes gateway start`: upstream's slot
   stops for good after a fatal config exit (78) or a clean exit, and a
   restart alone does not bring a stopped slot back.
4. Gateway test: within 30 seconds `s6-svstat` reports the slot up, and 10
   seconds later it is still up with the same pid. Pass: copy into
   `last-good/`, record `appliedSha`, clear `rolledBackSha` and
   `configRolledBack`. Fail: restore `last-good/`, restart and start again,
   and record the bad SHA as `rolledBackSha` with `configRolledBack` set.

Passing the test does not prove the config does what was intended. Restarts
interrupt any in-flight reply; config pushes are rare and deliberate.

## Secrets and settings

`.env` is committed, encrypted with dotenvx (`.gitignore` gains `!.env`). The
server holds only `DOTENV_PRIVATE_KEY`, in a gitignored `.env.keys` (`0600`).
`mise.toml` pins `dotenvx` and Node 26.7 (the image's version); the `up` task
runs `dotenvx run -- docker compose --profile tunnel up -d`. Compose passes
each variable only to the services that list it. Decrypted values are visible
to `docker inspect`, which already implies root on the host.

| Variable                                         | Secret | Reaches                       |
| ------------------------------------------------ | ------ | ----------------------------- |
| `ANTHROPIC_API_KEY` or `CLAUDE_CODE_OAUTH_TOKEN` | yes    | `hermes`                      |
| Platform tokens (e.g. `TELEGRAM_BOT_TOKEN`)      | yes    | `hermes`                      |
| `*_ALLOWED_USERS` for each enabled platform      | no     | `hermes` (S6)                 |
| `DOROTHY_CONFIG_DEPLOY_KEY` (base64)             | yes    | `hermes`                      |
| `DOROTHY_WEBHOOK_SECRET`                         | yes    | `hermes`                      |
| `DOROTHY_MEMORY_DEPLOY_KEY` (base64)             | yes    | `dorothy-sync` only           |
| `TUNNEL_TOKEN`                                   | yes    | `cloudflared`                 |
| `DOROTHY_CONFIG_REPO`                            | no     | `hermes`                      |
| `DOROTHY_CONFIG_REPO_NAME`                       | no     | `hermes` (derived for GitHub) |
| `DOROTHY_SYNC_INTERVAL`                          | no     | `hermes`, `dorothy-sync`      |
| `DOROTHY_MEMORY_REPO`                            | no     | `dorothy-sync`                |
| `DOROTHY_BUNDLE_MAX_BYTES`                       | no     | `dorothy-sync` (S2)           |
| `DOROTHY_ALLOW_EMPTY`                            | no     | `dorothy-sync`, normally unset |

Compose file secrets are not used: Compose refuses them on read-only services
and copies them into the container before `tmpfs: /run` hides them.

Non-secret settings live in `compose.yaml`. Repository URLs accept any git URL,
which is how tests use `file://` remotes. `DOROTHY_CONFIG_REPO_NAME` defaults to
`owner/name` parsed from a GitHub URL and is required otherwise. `settings.ts`
rejects a missing or malformed variable at startup with a message naming it.

## Health and operations

`health.ts` (`hermes`) exits 1 when `restored` is missing, the snapshot's
`lastSuccessAt` is older than three intervals (after the first),
`configRolledBack` is set, the gateway is down, or the sidecar's
`status.json` (on the read-only restore volume) reports `pushRejected`, a
size warning, or no successful publish for three intervals.
`sidecar-health.ts` exits 1 until this run's `restore.json` is written or when
its loop has stalled. Health is an operational signal, not a security
control (S13).

Logs go to stdout with `[dorothy-bootstrap]`, `[dorothy-snapshot]`,
`[dorothy-webhook]` and `[dorothy-sync]` prefixes.

- Fresh server: install Docker and mise, apply the host checklist (S11),
  clone, add `.env.keys`, `mise run up`. Once per account: the GitHub
  rulesets (S1, S7) and the Cloudflare rules (S8).
- Upgrade: read upstream's release notes and advisories, merge the
  Dependabot pull request once CI is green, then `git pull && mise run up`.
- Sync now: run `/usr/local/bin/node /opt/dorothy/src/snapshot.ts --once` as
  `hermes` in the `hermes` service (`docker compose exec -u hermes hermes`);
  the sidecar publishes within 30 seconds.
- `pushRejected`: something pushed to `dorothy-memory` while the sidecar had
  unpushed commits. Remove the `dorothy-state` volume and restart
  `dorothy-sync`; it re-clones under a new generation, and the next snapshot
  commits the volume's state on top. Unpushed local commits are dropped, but
  the next bundle carries everything they held.
- Human edits to `dorothy-memory` are fetched before each publish, then
  overwritten by the next bundle in a new commit. To make one stick, push it,
  then cold boot (remove `hermes-data`).
- Recovering from bad memories: S13.

## Testing

Tests run with `node --test` under the mise-pinned Node 26.7 through a mise
task. They do not run through `bun run`, because `bunfig.toml` sets
`[run] bun = true`, which substitutes Bun for `node`; implementation confirms
`check` reaches Node 26.7. `hermes/src/tsconfig.json` uses
`types: ["node"]` with `@types/node` (a development dependency, never
shipped), `noEmit`, `allowImportingTsExtensions` and `erasableSyntaxOnly`, so
syntax that type stripping cannot run fails the check rather than the server.
`HermesCli` is faked; git runs for real against temporary bare repositories
over `file://`. Owner and path constants are parameters, so no unit test needs
root.

- `dump`: a fixture database with ordinary and `WITHOUT ROWID` tables,
  `AUTOINCREMENT`, an FTS5 table with its triggers and views, a `sqlite_stat1`
  table, indexes, blobs, integers beyond 2^53, whole-number reals and a
  `user_version` round-trips with identical rows and `user_version`; omitted
  objects are absent; dumping twice is byte-identical; an unsupported virtual
  table fails.
- `bundle` and `redact`: the rules in S2, including a FIFO, a file growing
  after `fstat` and a foreign generation; the forms in S5.
- `snapshot`: exclusions; the `restored` guard; a failed manifest entry or
  table check; the snapshot directory is deleted; the fallback apply skips a
  held lock and a rolled-back SHA; `--final` retries the backup lock.
- `sidecar`: no commit without changes; mirrored deletions; the empty-state
  guard and its override; a human edit is fast-forwarded and built on; a
  non-fast-forward with unpushed commits is recorded and never forced; local
  commits survive an unreachable remote; the first push to an empty remote;
  `seed` from the local head; a head without `state.sql` fails; a stale
  `index.lock` is removed; a fresh clone mints a new generation;
  `restore.json` follows the head and records the consumed hash.
- `webhook`: signatures; content type; repository name and branch filtering;
  `ping`; the body cap; timeouts; collapsing; rollback including a slot that
  stopped itself; a crash-looping gateway fails the test; the boot check.
- `lock`: a dead owner's lock is taken over; waits are bounded.
- `settings`: missing or malformed variables; a platform token without its
  allowlist; repository name derivation.
- `bootstrap`: cold, warm and interrupted restores; stale WAL files removed;
  waiting for the outbox to be consumed; `seed`; an unreachable config
  remote; a rolled-back head is not copied; the `external_dirs` warning;
  `.env` and pairing cleanup.

### Smoke test

A CI job `smoke`, after `check`, runs the compose stack without the `tunnel`
profile against bare-repository fixtures mounted into both containers. The
config fixture enables only the API server (`API_SERVER_ENABLED=true`), so no
LLM or platform credentials are needed; the gateway's `:8642` health endpoint
stands in for a platform. The fixture `state.sql` was dumped by an earlier
image and is refreshed only deliberately, so every upgrade proves migration
from an older schema. The job also asserts that mise's Node version equals the
image's.

1. Cold boot from the memory fixture; all services become healthy, and
   session search finds a fixture message, including a CJK one.
2. `snapshot.ts --once`; the sidecar commits to the memory fixture, and its
   `state.sql` restores to the fixture's rows.
3. A `SOUL.md` change pushed to the config fixture plus a signed request to
   `:9000` is applied and the gateway restarts.
4. A `config.yaml` that makes the gateway exit 78 is rolled back, the gateway
   comes back up, and the rollback is recorded and not re-applied.
5. A first boot against an empty memory fixture seeds and pushes `main`.
6. The security design's smoke test additions.

`dependabot.yml` gains the `docker-compose` ecosystem, so each Hermes bump,
which updates every service's reference, is a pull request whose smoke test
restores through the new image's migrations before merge.

## Open items

Verified against the pinned image during implementation and recorded here:

- The platform registry's allowlist and allow-all variable names (S6).
- The API server's bind address when its key is generated (S9).
- That `userns-remap` works with s6-overlay and that the bind-mounted
  `hermes/` is readable under it (S11).
- That a tmpfs at the `VOLUME` path suppresses the anonymous volume.
- That Dependabot's `docker-compose` ecosystem follows the calendar-version
  tags.
- That `check` and the reusable lint workflow run mise's Node, not Bun.
- The final `cap_add` list (S10).

## Implementation phasing

Three plans, each ending with green CI:

1. Libraries and unit tests: `dump`, `bundle`, `redact`, `git`, `lock`,
   `status`, `settings`, `config`, plus the tooling fixes.
2. Containers: `bootstrap`, `snapshot`, `sidecar`, both health checks,
   `compose.yaml` and the smoke test.
3. Config delivery: `webhook`, the boot check, `cloudflared` and the
   operator checklists.
