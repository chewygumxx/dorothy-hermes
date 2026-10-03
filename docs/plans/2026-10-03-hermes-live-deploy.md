---
__cgxx: |
  # vim:set expandtab shiftwidth=2 filetype=markdown foldlevel=3:
  # SPDX-License-Identifier: GPL-3.0-only

  #
  #
  # ~chewygumxx/dorothy-hermes.git
  # ::: :/docs/plans/2026-10-03-hermes-live-deploy.md
  #
  #

ctime: 2026-10-03
title: Hermes live deploy implementation plan
description: "Plan from an upstream probe to a live, observed deployment"
tags:
  - dorothy
  - hermes
  - plan
---

# Hermes live deploy implementation plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use
> superpowers:subagent-driven-development (recommended) or
> superpowers:executing-plans to implement this plan task-by-task. Steps use
> checkbox (`- [ ]`) syntax for tracking.

**Goal:** Take the approved design from nothing to a live, hardened Dorothy
whose behaviour is recorded for review.

**Architecture:** Four compose services run the pinned upstream image:
`dorothy-init` chowns the volume roots, `dorothy-sync` holds the memory key
and publishes, `hermes` runs the agent with our s6 stubs, and (later)
`cloudflared`. Our TypeScript runs on the image's Node 26.7 with type
stripping and imports only `node:*`. Data crosses between `hermes` and the
sidecar only as `bundle.json` and `restore.json`.

**Tech Stack:** Node 26.7 (`node:sqlite`, `node:test`), TypeScript 7 for type
checking only, git and OpenSSH from the image, s6-overlay v3, Docker Compose
v2, mise, dotenvx, Bun for repository tooling.

**Spec:** [deployment design](../specs/2026-10-03-hermes-deployment-design.md)
and [security design](../specs/2026-10-03-hermes-security-design.md). Read
both before starting; this plan argues from them and cites their threat
identifiers (`S1` to `S15`).

## Scope

This plan merges the spec's phases 1 and 2 and ends at a live deployment. It
defers phase 3: the webhook, `cloudflared` and the Cloudflare rules. Without
the webhook, config reaches the agent through the snapshot loop's fallback
apply (within one interval), and the boot check runs at the start of the
`dorothy-snapshot` service instead of `dorothy-webhook`. Plan 3 moves it.

Deliberate departures from the spec, each folded back into it in Task 18:

- `util.ts`, `files.ts` and `test-helpers.ts` join the source layout; tests
  sit beside their modules as `*.test.ts`.
- `platforms.json` is generated from the pinned image by
  `scripts/platforms.py`, so the S6 variable names come from upstream.
- Blob redaction (S5) runs on raw bytes inside `dumpDatabase`, before hex
  encoding, rather than on the hex text.
- The gateway test ignores the pid that was up before the restart, so a
  slow-to-stop old process is not mistaken for the new one, and starts its
  30 s window only once that process has exited (bounded at 90 s): upstream
  drains running cron jobs before it restarts.
- Smoke step 3 (webhook apply) becomes a fallback apply through
  `snapshot.ts --once`.
- `DOROTHY_HOST` names the server in sync commit messages; the container's
  own hostname is meaningless.
- The S15 ssh command gains `ConnectTimeout` and `ServerAlive*` options, and
  git has no overall timeout: a first clone of a long memory history must
  not be killed, while a stalled connection still ends.

## Global Constraints

- The image runs as published: no derived image, no build step, no registry.
- Image pin: `nousresearch/hermes-agent:v2026.9.24@sha256:fca358f12efd65bfaaca05884166f15c0e2788375ca30d77061ac1ebc96452b7`
  (Task 1 confirms the digest).
- Runtime code imports only `node:*` modules and runs under Node 26.7 type
  stripping: no enums, namespaces or parameter properties; relative imports
  end in `.ts`; type-only imports use `import type`.
- Our code never opens the live `state.db`; only `hermes backup --quick`
  copies.
- git runs as `/usr/bin/git` through `execFile`, never a shell, with no
  overall timeout and `GIT_SSH_COMMAND` set to `/usr/bin/ssh -F none -i <key>
  -o IdentitiesOnly=yes -o UserKnownHostsFile=/opt/dorothy/known_hosts -o
  StrictHostKeyChecking=yes -o ConnectTimeout=30 -o ServerAliveInterval=15 -o
  ServerAliveCountMax=4`.
- Commits by our code are authored `Dorothy <noreply@dorothy.invalid>`.
- Sync commit message: `chore(sync): Snapshot from <host>` with a body listing
  which of sessions, memories, skills and scheduled jobs changed.
- Push is `HEAD:refs/heads/main`, never forced, never rebased.
- Size limits: warn above 80 MB, fail above 95 MB per file. Bundle cap
  `DOROTHY_BUNDLE_MAX_BYTES`, default 256 MiB.
- `DOROTHY_SYNC_INTERVAL` defaults to 900 seconds; publish loop every 30 s.
- Locks: `/run/dorothy/snapshot.lock` and `/run/dorothy/apply.lock`, 10 minute
  bounded wait, dead owners taken over.
- Gateway test: once the old pid has gone (waited for up to 90 s), up within
  30 s, then still up with the same pid 10 s later.
- No em dashes anywhere (hook and `lint:emdash`). Commit headers at most 50
  characters, body lines at most 72 (commitlint).
- Format with `bunx biome check --write <paths>` before each commit; the
  pre-commit hook runs the repository checks.
- Deletions under `~` use `gtrash`, not `rm -rf`.

## Review Focus

Inputs the spec implies but its test list does not name, each pinned by a test
in the owning task:

1. `dorothy-config` lacking `config.yaml` or `SOUL.md`: bootstrap must fail
   with a message naming the file, not a stack trace, unless a last-good
   copy exists, which then boots; an apply must leave the running config
   alone (Tasks 11 and 12).
2. Transcript text containing NUL characters: the dump must round-trip it,
   since `sqlite3_exec` stops at the first NUL (Task 6).
3. Two backups in the same second: Hermes suffixes `-<n>`, and the snapshot
   must still find exactly its own directory (Task 10).
4. A gateway that takes most of the 30 s window to come back after a restart,
   or whose old process drains a cron job first: a good config must not be
   rolled back (Task 11).
5. `.env` lines with `export`, quotes or comments: both the S6 cleanup and the
   S5 secret collection must read them as upstream does (Tasks 5 and 12).

## File map

| Path                                        | Responsibility                                      |
| ------------------------------------------- | --------------------------------------------------- |
| `scripts/platforms.py`                      | Dumps the image's platform registry to JSON         |
| `hermes/src/package.json`, `tsconfig.json`  | ESM marker; Node-typed check config                 |
| `hermes/src/platforms.json`                 | Generated allowlist registry (S6)                   |
| `hermes/src/util.ts`                        | Logging, clocks, retry, `lstat` helper              |
| `hermes/src/status.ts`                      | Atomic writes, JSON status files                    |
| `hermes/src/lock.ts`                        | `withLock`, `tryWithLock`                           |
| `hermes/src/settings.ts`                    | Environment validation, S6 refusals                 |
| `hermes/src/redact.ts`                      | Secret collection and replacement (S5)              |
| `hermes/src/dump.ts`                        | Deterministic SQL dump, restore, table checks       |
| `hermes/src/bundle.ts`                      | Bundle format, validation, safe open (S2)           |
| `hermes/src/files.ts`                       | Tree collection and safe writes, no symlinks        |
| `hermes/src/git.ts`                         | git wrapper                                         |
| `hermes/src/hermes.ts`                      | `HermesCli`, container paths                        |
| `hermes/src/config.ts`                      | Config copy, apply, gateway test, rollback, boot check |
| `hermes/src/bootstrap.ts`                   | Entry: cleanup, config checkout, restore            |
| `hermes/src/snapshot.ts`                    | Entry: snapshot loop, `--once`, `--final`           |
| `hermes/src/sidecar.ts`                     | Entry: memory checkout, restore.json, publish loop  |
| `hermes/src/health.ts`, `sidecar-health.ts` | Health checks                                       |
| `hermes/src/test-helpers.ts`                | Temporary dirs, bare repos, fakes                   |
| `hermes/known_hosts`                        | GitHub SSH host keys                                |
| `hermes/cont-init.d/`, `cont-finish.d/`, `s6-rc.d/` | s6 stubs                                    |
| `compose.yaml`                              | The stack                                           |
| `smoke/`                                    | Smoke script, fixtures, helpers                     |
| `docs/notes/`                               | Probe and live-run records                          |

---

### Task 1: Probe the pinned image

A spike: its output is recorded facts and two generated files, not runtime
code. Later tasks depend on its results, so do not skip a step; when a result
contradicts this plan, stop and report before continuing.

**Files:**

- Create: `scripts/platforms.py`
- Create: `hermes/src/platforms.json` (generated)
- Create: `smoke/fixtures/config/config.yaml`,
  `smoke/fixtures/config/SOUL.md`, `smoke/fixtures/config-broken.yaml`
- Create: `docs/notes/2026-10-03-upstream-probe.md`

**Interfaces:**

- Produces: `hermes/src/platforms.json` with the shape
  `{platforms: {<name>: {enabledBy: string[], allowedUsers: string,
  allowAllUsers: string}}, globalAllowlist: string, globalAllowAll: string,
  extraAllowVariables: string[]}`, read by `settings.ts` (Task 4).
- Produces: the confirmed image reference, Node version, `cap_add` list,
  gateway restart time and broken-config fixture used by Tasks 2, 11, 15, 16
  and 17.

- [ ] **Step 1: Start Docker and pull the image**

The local daemon may be stopped. If `docker info` fails, ask the user to start
it (`sudo systemctl start docker`); do not use sudo yourself.

```bash
IMAGE='nousresearch/hermes-agent:v2026.9.24@sha256:fca358f12efd65bfaaca05884166f15c0e2788375ca30d77061ac1ebc96452b7'
docker pull "$IMAGE"
docker buildx imagetools inspect nousresearch/hermes-agent:v2026.9.24 --format '{{json .Manifest.Digest}}'
```

Expected: the pull succeeds and the printed digest equals the pinned one. If
it differs, the tag was re-pushed: record both and use the printed digest
everywhere this plan names the pin.

- [ ] **Step 2: Record runtime facts**

```bash
docker run --rm --entrypoint /usr/local/bin/node "$IMAGE" --version
docker run --rm --entrypoint /bin/sh "$IMAGE" -c 'ls -l /opt/hermes/bin/hermes /opt/hermes/.venv/bin/python /usr/bin/git /usr/bin/ssh /command/s6-svstat /command/s6-setuidgid; id hermes'
```

Expected: `v26.7.0`; every path exists; `uid=10000(hermes)`. Record each line.

- [ ] **Step 3: Write `scripts/platforms.py`**

```python
# SPDX-License-Identifier: GPL-3.0-only
"""Print the pinned image's platform allowlist registry as JSON (S6).

Run inside the image:
  docker run --rm --entrypoint /opt/hermes/.venv/bin/python \
    -e HERMES_HOME=/tmp/probe -v "$PWD/scripts:/s:ro" IMAGE /s/platforms.py
"""

import json
import pathlib
import re
import sys

sys.path.insert(0, "/opt/hermes")

from gateway import authz_mixin  # noqa: E402
from gateway.config_env import _ENV_ENABLE_CREDENTIALS  # noqa: E402
from gateway.pairing import _PLATFORM_ALLOWLIST_ENV  # noqa: E402
from gateway.platform_registry import platform_registry  # noqa: E402

platforms = {}
for platform, names in _ENV_ENABLE_CREDENTIALS.items():
    allowed = _PLATFORM_ALLOWLIST_ENV.get(platform.value, "")
    platforms[platform.value] = {
        "enabledBy": sorted(names),
        "allowedUsers": allowed,
        "allowAllUsers": allowed.replace("_ALLOWED_USERS", "_ALLOW_ALL_USERS")
        if allowed
        else "",
    }

extra = (
    set(authz_mixin._ALLOW_BOTS_ENV.values())
    | set(authz_mixin._GROUP_USER_ENV.values())
    | set(authz_mixin._GROUP_CHAT_ENV.values())
)

# Plugin platforms declare their own allowlist and allow-all switches.
for entry in platform_registry.all_entries():
    extra |= {entry.allowed_users_env, entry.allow_all_env} - {""}

# Role allowlists (Discord) grant access before the user allowlist is read.
ROLES = re.compile(r"\b[A-Z][A-Z0-9_]*_ALLOWED_ROLES\b")
for root in ("gateway", "plugins"):
    for source in pathlib.Path("/opt/hermes", root).rglob("*.py"):
        extra |= set(ROLES.findall(source.read_text(errors="replace")))

for entry in platforms.values():
    extra -= {entry["allowedUsers"], entry["allowAllUsers"]}

json.dump(
    {
        "platforms": platforms,
        "globalAllowlist": "GATEWAY_ALLOWED_USERS",
        "globalAllowAll": "GATEWAY_ALLOW_ALL_USERS",
        "extraAllowVariables": sorted(extra),
    },
    sys.stdout,
    indent=4,
    sort_keys=True,
)
sys.stdout.write("\n")
```

- [ ] **Step 4: Generate `platforms.json`**

```bash
mkdir -p hermes/src
docker run --rm --entrypoint /opt/hermes/.venv/bin/python \
  -e HERMES_HOME=/tmp/probe -v "$PWD/scripts:/s:ro" "$IMAGE" /s/platforms.py \
  > hermes/src/platforms.json
bunx biome format --write hermes/src/platforms.json
jq '.platforms.telegram, .globalAllowAll, (.extraAllowVariables | length)' hermes/src/platforms.json
jq '.extraAllowVariables | map(select(test("_ROLES$|_ALLOW_ALL_USERS$")))' hermes/src/platforms.json
```

The `biome format` keeps the pre-commit hook from rejecting the generated
file. Expected: telegram shows `enabledBy: ["TELEGRAM_BOT_TOKEN"]`,
`allowedUsers: "TELEGRAM_ALLOWED_USERS"`; then `"GATEWAY_ALLOW_ALL_USERS"`; then
a positive count; then a list including `DISCORD_ALLOWED_ROLES` (when Discord
ships in the image) and any plugin platform's allow-all switch. An import
error means upstream moved a name: find it with
`docker run --rm --entrypoint grep "$IMAGE" -rn _PLATFORM_ALLOWLIST_ENV /opt/hermes/gateway`
and adjust the script.

- [ ] **Step 5: Confirm a tmpfs at `VOLUME` stops the anonymous volume**

```bash
docker run --name probe-vol --tmpfs /opt/data --entrypoint /bin/true "$IMAGE"
docker inspect probe-vol --format '{{json .Mounts}}'
docker rm probe-vol
```

Expected: `[]` or a list without any `"Type":"volume"` entry for `/opt/data`.

- [ ] **Step 6: Write the smoke config fixtures**

`smoke/fixtures/config/config.yaml`:

```yaml
# Smoke-test config: no messaging platforms; the API server, enabled by the
# key upstream generates, stands in for one.
skills:
    external_dirs:
        - /opt/data/dorothy/config/skills
```

`smoke/fixtures/config/SOUL.md`:

```markdown
# Smoke Dorothy

You are a smoke-test fixture. Version 1.
```

- [ ] **Step 7: Boot the gateway hardened, with no credentials**

Seed the volume with the smoke config first, so the probe boots the config
the smoke test uses rather than upstream's default:

```bash
docker volume create probe-data
docker run --rm -v probe-data:/opt/data \
  -v "$PWD/smoke/fixtures/config:/probe:ro" --entrypoint /bin/sh "$IMAGE" \
  -c 'cp /probe/config.yaml /opt/data/config.yaml && chown 10000:10000 /opt/data /opt/data/config.yaml'
docker run -d --name probe-gw \
  --security-opt no-new-privileges:true --cap-drop ALL \
  --cap-add CHOWN --cap-add DAC_OVERRIDE --cap-add FOWNER \
  --cap-add SETUID --cap-add SETGID --cap-add KILL \
  --tmpfs /run:exec --pids-limit 512 --memory 4g \
  -e S6_BEHAVIOUR_IF_STAGE2_FAILS=2 \
  -v probe-data:/opt/data \
  "$IMAGE" gateway run
sleep 90
docker exec probe-gw /command/s6-svstat -o up,pid /run/service/gateway-default
docker exec probe-gw sh -c 'grep -iE ":21C2 [0-9A-F]+:0000 0A" /proc/net/tcp /proc/net/tcp6'
docker exec probe-gw ls -l /opt/data/state.db
docker logs probe-gw 2>&1 | grep -iE 'operation not permitted|permission denied|EPERM' || echo "no permission errors"
```

Expected: `true <pid>`; one listening (`0A`) line whose local address (the
column before `:21C2`) is `0100007F` (127.0.0.1), closing the S9 open item;
`state.db` exists although no conversation has happened (the seed deploy's
first snapshot depends on it: if absent, record it and stop); no permission
errors. Record all four. If the slot is not up, record the logs and stop: the
smoke test assumes a credential-free gateway stays up.

- [ ] **Step 8: Narrow `cap_add`**

For each capability in `CHOWN DAC_OVERRIDE FOWNER SETUID SETGID KILL`, rerun
Step 7 under a new container and volume name with that one capability
removed. A capability stays when its removal stops the slot coming up or adds
permission errors to the logs. Record the minimal list; Task 15 uses it.
Remove each probe container and volume afterwards
(`docker rm -f <name>; docker volume rm <volume>`).

- [ ] **Step 9: Time a restart and find a config that stops the gateway**

On `probe-gw`:

```bash
start=$(date +%s)
docker exec -u hermes probe-gw /opt/hermes/bin/hermes gateway restart
docker exec probe-gw /command/s6-svstat -o up,pid /run/service/gateway-default
for i in $(seq 1 60); do docker exec probe-gw /command/s6-svstat -o up,pid /run/service/gateway-default; sleep 1; done
echo "elapsed $(( $(date +%s) - start ))"
```

Record how long the old pid takes to go and how long the new one takes to come
up after that. If coming up exceeds 25 s, stop and report: the 30 s window in
the spec needs widening. Also record the drain budget the old process may
spend before exiting (Task 11 waits for it before starting the 30 s window):

```bash
docker exec probe-gw grep -rn "cron_drain_timeout" /opt/hermes/gateway /opt/hermes/hermes_cli | head
```

Then try candidate broken configs in order. For each, write it over
`/opt/data/config.yaml`, restart, and log `s6-svstat` once a second for 40 s,
noting the time from the new pid being up to its exit:

```bash
docker exec -i -u hermes probe-gw sh -c 'cat > /opt/data/config.yaml' < candidate.yaml
docker exec -u hermes probe-gw /opt/hermes/bin/hermes gateway restart
```

Candidate A (no reachable platform, a rejected Telegram token):

```yaml
skills:
    external_dirs:
        - /opt/data/dorothy/config/skills
platforms:
    api_server:
        enabled: false
    telegram:
        enabled: true
        token: "0:dorothy-smoke-invalid-token"
```

Candidate B (the API server on an unbindable address):

```yaml
skills:
    external_dirs:
        - /opt/data/dorothy/config/skills
platforms:
    api_server:
        enabled: true
        extra:
            host: 203.0.113.7
```

Candidate C (unparseable YAML):

```yaml
platforms: [unclosed
```

The first candidate whose new pid exits within 6 s of coming up (or that never
comes up) becomes `smoke/fixtures/config-broken.yaml`: the gateway test only
watches 10 s past "up", so a candidate failing later would pass it and become
last-good. Record which one, its up-to-exit time and the exit code from
`docker logs`. If none qualifies, stop and report.

- [ ] **Step 10: Check the CJK tokenizer and the search entry point**

```bash
docker exec probe-gw sh -c 'find / -name "libfts5_cjk*" 2>/dev/null; echo done'
cat > /tmp/probe-search.py <<'EOF'
import sys
sys.path.insert(0, "/opt/hermes")
from hermes_state import SessionDB
print(len(SessionDB().search_messages("anything")))
EOF
docker cp /tmp/probe-search.py probe-gw:/tmp/probe-search.py
docker exec -u hermes probe-gw /opt/hermes/.venv/bin/python /tmp/probe-search.py
```

Expected: a path or none for the tokenizer (record which: when absent, CJK
search uses the trigram index and boot step 3.4 only compacts); the search
prints `0` without an import error.

Then run the command boot step 3.4 relies on and record its exact output for
both outcomes it can report, so bootstrap can tell "done" from "skipped":

```bash
docker exec -u hermes probe-gw /opt/hermes/bin/hermes sessions optimize-storage --yes; echo "exit $?"
docker exec probe-gw grep -rn "Not enough free disk\|nothing to do" /opt/hermes/hermes_cli | head
```

Then remove the probe:
`docker rm -f probe-gw; docker volume rm probe-data`.

- [ ] **Step 11: Record the probe**

Write `docs/notes/2026-10-03-upstream-probe.md` with the same front matter
pattern as the specs (`ctime`, `title`, `description`, `tags`) and one section
per step: command, observed output, conclusion. End with "Effects on the
plan", listing any constant that changed (digest, `cap_add`, broken config,
timings).

- [ ] **Step 12: Lint and commit**

The lint scripts list files with `git ls-files`, so stage first:

```bash
git add scripts/platforms.py hermes/src/platforms.json smoke/fixtures docs/notes/2026-10-03-upstream-probe.md
bun run lint:md && bun run lint:emdash
git commit -m "docs: Record the upstream image probe"
```

---

### Task 2: Tooling for Node-run TypeScript

**Files:**

- Create: `hermes/src/package.json`, `hermes/src/tsconfig.json`,
  `hermes/src/util.ts`, `hermes/src/util.test.ts`
- Modify: `package.json` (`typecheck` script, `@types/node`), `mise.toml`
  (Node, dotenvx, tasks), `.gitignore` (`!.env`),
  `.github/workflows/ci.yaml` (SHA pins, `test` job),
  `.github/dependabot.yml` (`docker-compose`)

**Interfaces:**

- Produces (`util.ts`): `type Log = (message: string) => void`;
  `interface Clock { now(): number; sleep(ms: number): Promise<void> }`;
  `realClock: Clock`; `logger(prefix: string): Log`;
  `errorMessage(error: unknown): string`;
  `errorCode(error: unknown): string | undefined`; `iso(ms: number): string`;
  `lstatOrNull(path: string): Stats | null`;
  `interface RetryOptions extends Clock { forMs: number; log: Log }`;
  `retry<T>(what: string, fn: () => Promise<T>, options: RetryOptions): Promise<T>`.
- Produces: `mise run test` runs every `hermes/src/**/*.test.ts` under Node
  26.7.

- [ ] **Step 1: Add the package marker and type-check config**

`hermes/src/package.json`:

```json
{
    "private": true,
    "type": "module"
}
```

`hermes/src/tsconfig.json`:

```json
{
    "$schema": "https://json.schemastore.org/tsconfig.json",
    "compilerOptions": {
        "target": "esnext",
        "module": "nodenext",
        "moduleResolution": "nodenext",
        "strict": true,
        "noEmit": true,
        "allowImportingTsExtensions": true,
        "erasableSyntaxOnly": true,
        "verbatimModuleSyntax": true,
        "resolveJsonModule": true,
        "types": ["node"],
        "skipLibCheck": true
    },
    "include": ["**/*.ts"]
}
```

- [ ] **Step 2: Install `@types/node` and extend the typecheck**

```bash
bun add --dev @types/node@26.6.4
```

In `package.json`, change `"typecheck": "tsc"` to
`"typecheck": "tsc && tsc -p hermes/src"`.

- [ ] **Step 3: Pin Node and dotenvx, add tasks**

In `mise.toml`, under `# Runtimes` after `bun = "1.4"`:

```toml
# Node runs our TypeScript in the image; tests run on the same version.
node = "26.7.0"
```

Under `# Utilities` after the jq line:

```toml
# `dotenvx` decrypts `.env` for `mise run up`.
"aqua:dotenvx/dotenvx" = "1"
```

At the end of the file:

```toml
[tasks.test]
description = "Unit tests under the image's Node"
run         = "node --test --test-reporter=spec 'hermes/src/**/*.test.ts'"

[tasks.smoke]
description = "Boot the stack against fixture repositories"
run         = "sh smoke/run.sh"

[tasks.up]
description = "Start Dorothy"
run         = "DOROTHY_HOST=$(hostname) dotenvx run -- docker compose up -d --wait --wait-timeout 600"
```

tombi aligns `=` within a group, which is why `run` is padded; let it settle
the rest (the neighbouring `bun` and `jq` lines realign):

Run `mise install`, `bun run format:toml` and `bun run lint:toml`. Expected:
all succeed.

- [ ] **Step 4: Track the encrypted `.env`**

In `.gitignore`, directly after `.env*`, add:

```gitignore
!.env
```

Verify: `touch .env.keys .env && git check-ignore .env.keys && ! git check-ignore .env; rm .env .env.keys`.
Expected: prints `.env.keys` only.

- [ ] **Step 5: Write the failing `util` tests**

`hermes/src/util.test.ts`:

```ts
import assert from "node:assert/strict";
import { test } from "node:test";
import { iso, lstatOrNull, retry } from "./util.ts";

function clock() {
    let t = 0;
    return {
        now: () => t,
        sleep: async (ms: number) => {
            t += ms;
        },
    };
}

test("retry returns once the function succeeds", async () => {
    let calls = 0;
    const value = await retry(
        "thing",
        async () => {
            calls += 1;
            if (calls < 3) throw new Error("not yet");
            return "ok";
        },
        { ...clock(), forMs: 60_000, log: () => {} },
    );
    assert.equal(value, "ok");
    assert.equal(calls, 3);
});

test("retry gives up after its window and names the failure", async () => {
    await assert.rejects(
        retry(
            "clone",
            async () => {
                throw new Error("unreachable");
            },
            { ...clock(), forMs: 5_000, log: () => {} },
        ),
        /clone kept failing for 5 s: unreachable/,
    );
});

test("iso formats milliseconds", () => {
    assert.equal(iso(0), "1970-01-01T00:00:00.000Z");
});

test("lstatOrNull returns null for a missing path", () => {
    assert.equal(lstatOrNull("/nonexistent/dorothy"), null);
});
```

- [ ] **Step 6: Run to verify it fails**

Run: `mise exec -- node --test hermes/src/util.test.ts`
Expected: FAIL, cannot find module `./util.ts`.

- [ ] **Step 7: Implement `util.ts`**

```ts
import { lstatSync, type Stats } from "node:fs";
import { setTimeout as delay } from "node:timers/promises";

export type Log = (message: string) => void;

export interface Clock {
    now(): number;
    sleep(ms: number): Promise<void>;
}

export const realClock: Clock = {
    now: () => Date.now(),
    sleep: (ms) => delay(ms),
};

export function logger(prefix: string): Log {
    return (message) => console.log(`[${prefix}] ${message}`);
}

export function errorMessage(error: unknown): string {
    return error instanceof Error ? error.message : String(error);
}

export function errorCode(error: unknown): string | undefined {
    return (error as NodeJS.ErrnoException | null)?.code;
}

export function iso(ms: number): string {
    return new Date(ms).toISOString();
}

/** `lstat` that answers null for a missing path or a missing parent. */
export function lstatOrNull(path: string): Stats | null {
    try {
        return lstatSync(path);
    } catch (error) {
        const code = errorCode(error);
        if (code === "ENOENT" || code === "ENOTDIR") return null;
        throw error;
    }
}

export interface RetryOptions extends Clock {
    forMs: number;
    log: Log;
}

/** Retries fn with exponential backoff (1 s doubling to 30 s) for forMs. */
export async function retry<T>(
    what: string,
    fn: () => Promise<T>,
    options: RetryOptions,
): Promise<T> {
    const deadline = options.now() + options.forMs;
    let wait = 1_000;
    for (;;) {
        try {
            return await fn();
        } catch (error) {
            if (options.now() + wait > deadline) {
                const seconds = Math.round(options.forMs / 1000);
                throw new Error(
                    `${what} kept failing for ${seconds} s: ${errorMessage(error)}`,
                );
            }
            options.log(
                `${what} failed, retrying in ${wait / 1000} s: ${errorMessage(error)}`,
            );
            await options.sleep(wait);
            wait = Math.min(wait * 2, 30_000);
        }
    }
}
```

- [ ] **Step 8: Run tests and the typecheck**

Run: `mise run test && bun run typecheck`
Expected: 4 tests pass; typecheck exits 0.

- [ ] **Step 9: Pin Actions by SHA, add the test job and Dependabot ecosystem**

In `.github/workflows/ci.yaml` replace both
`chewygumxx/.github/.github/workflows/<name>.yaml@v1` references with
`@6a93bf782466c25b173b05d92d8b5b10dc356441 # v1` (re-resolve with
`gh api repos/chewygumxx/.github/commits/v1 --jq .sha` first). Append:

```yaml
    test:
        runs-on: ubuntu-latest
        permissions:
            contents: read
        steps:
            - name: Checkout
              uses: actions/checkout@3d3c42e5aac5ba805825da76410c181273ba90b1 # v7.0.1
              with:
                  persist-credentials: false

            - name: Setup Toolchain
              uses: jdx/mise-action@7a4e45a543138629540c9a1616d08632b893e492 # v5.0.1

            - name: Unit Tests
              run: mise run test
```

In `.github/dependabot.yml` append:

```yaml
    - package-ecosystem: docker-compose
      directory: /
      schedule:
          interval: weekly
      commit-message:
          prefix: build
```

Run: `bun run lint:yaml`. Expected: pass.

- [ ] **Step 10: Commit**

```bash
bunx biome check --write hermes/src
git add hermes/src/package.json hermes/src/tsconfig.json hermes/src/util.ts hermes/src/util.test.ts package.json bun.lock mise.toml .gitignore .github
git commit -m "build: Add Node 26 TypeScript tooling" -m "Tests run through mise because bunfig's [run] bun = true would
substitute Bun for node. Actions are pinned by commit SHA (S14)."
```

---

### Task 3: Status files and locks

**Files:**

- Create: `hermes/src/status.ts`, `hermes/src/lock.ts`,
  `hermes/src/test-helpers.ts`, `hermes/src/status.test.ts`,
  `hermes/src/lock.test.ts`

**Interfaces:**

- Consumes: `errorCode` from `util.ts`.
- Produces (`status.ts`):
  `writeFileAtomic(path: string, data: string | Uint8Array, mode?: number): void`;
  `writeJson(path: string, value: unknown, mode?: number): void`;
  `readJson<T>(path: string): T | null`; `readText(path: string): string`;
  `interface ApplyStatus { appliedSha?; rolledBackSha?; configRolledBack?: boolean; lastApplyAt?; lastError? }`;
  `interface SnapshotStatus { lastSuccessAt?; lastAttemptAt?; lastError? }`;
  `interface SyncStatus { startedAt: string; restoreWrittenAt?; loopAt?; lastSuccessAt?; lastError?; lastBundleAt?; pendingCommits: number; pushRejected: boolean; largestFileBytes: number; sizeWarning: boolean }`
  (unmarked fields are `string`).
- Produces (`lock.ts`): `class LockTimeout extends Error`;
  `interface LockOptions { waitMs?; pollMs?; pid?; isAlive?(pid: number): boolean }`;
  `withLock<T>(path, fn: () => Promise<T>, options?): Promise<T>`;
  `tryWithLock<T>(path, fn, options?): Promise<{ ran: true; value: T } | { ran: false }>`.
- Produces (`test-helpers.ts`): `tempDir(t: TestContext): string`;
  `fakeClock(start?: number): Clock`;
  `writeFiles(root: string, files: Record<string, string>): void`.

- [ ] **Step 1: Write the test helpers**

`hermes/src/test-helpers.ts`:

```ts
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import type { TestContext } from "node:test";
import type { Clock } from "./util.ts";

export function tempDir(t: TestContext): string {
    const dir = mkdtempSync(join(tmpdir(), "dorothy-test-"));
    t.after(() => rmSync(dir, { recursive: true, force: true }));
    return dir;
}

/** A clock whose sleep advances time instantly. */
export function fakeClock(start = 1_800_000_000_000): Clock {
    let t = start;
    return {
        now: () => t,
        sleep: async (ms) => {
            t += ms;
        },
    };
}

export function writeFiles(root: string, files: Record<string, string>): void {
    for (const [path, content] of Object.entries(files)) {
        mkdirSync(dirname(join(root, path)), { recursive: true });
        writeFileSync(join(root, path), content);
    }
}
```

- [ ] **Step 2: Write the failing tests**

`hermes/src/status.test.ts`:

```ts
import assert from "node:assert/strict";
import { readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { readJson, readText, writeJson } from "./status.ts";
import { tempDir } from "./test-helpers.ts";

test("writeJson round-trips through readJson and leaves no temp file", (t) => {
    const dir = tempDir(t);
    const path = join(dir, "nested", "apply.json");
    writeJson(path, { appliedSha: "abc" });
    assert.deepEqual(readJson(path), { appliedSha: "abc" });
    assert.deepEqual(readdirSync(join(dir, "nested")), ["apply.json"]);
});

test("writeJson applies the mode", (t) => {
    const path = join(tempDir(t), "key.json");
    writeJson(path, {}, 0o600);
    assert.equal(statSync(path).mode & 0o777, 0o600);
});

test("missing files read as null and empty text", (t) => {
    const dir = tempDir(t);
    assert.equal(readJson(join(dir, "none.json")), null);
    assert.equal(readText(join(dir, "none")), "");
});
```

`hermes/src/lock.test.ts`:

```ts
import assert from "node:assert/strict";
import {
    existsSync,
    mkdirSync,
    readFileSync,
    rmSync,
    utimesSync,
    writeFileSync,
} from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { LockTimeout, tryWithLock, withLock } from "./lock.ts";
import { tempDir } from "./test-helpers.ts";

function heldBy(path: string, pid: number): void {
    mkdirSync(path);
    writeFileSync(join(path, "pid"), String(pid));
}

test("a dead owner's lock is taken over", async (t) => {
    const path = join(tempDir(t), "snapshot.lock");
    heldBy(path, 999_999);
    const owner = await withLock(
        path,
        async () => readFileSync(join(path, "pid"), "utf8"),
        { isAlive: () => false },
    );
    assert.equal(owner, String(process.pid));
    assert.equal(existsSync(path), false);
});

test("a takeover leaves a lock that changed owner meanwhile", async (t) => {
    const path = join(tempDir(t), "snapshot.lock");
    heldBy(path, 999_999);
    const result = await tryWithLock(path, async () => "ran", {
        isAlive: (pid) => {
            if (pid !== 999_999) return true;
            // Another waiter takes the dead lock over between our read and our takeover.
            rmSync(path, { recursive: true });
            heldBy(path, 4242);
            return false;
        },
    });
    assert.deepEqual(result, { ran: false });
    assert.equal(readFileSync(join(path, "pid"), "utf8"), "4242");
    assert.equal(existsSync(`${path}.takeover`), false);
});

test("a crashed takeover's guard expires", async (t) => {
    const path = join(tempDir(t), "snapshot.lock");
    heldBy(path, 999_999);
    mkdirSync(`${path}.takeover`);
    const old = new Date(Date.now() - 120_000);
    utimesSync(`${path}.takeover`, old, old);
    const ran = await withLock(path, async () => "ran", {
        isAlive: () => false,
        waitMs: 1_000,
        pollMs: 10,
    });
    assert.equal(ran, "ran");
});

test("waits are bounded", async (t) => {
    const path = join(tempDir(t), "snapshot.lock");
    heldBy(path, process.pid);
    await assert.rejects(
        withLock(path, async () => "never", { waitMs: 50, pollMs: 10 }),
        LockTimeout,
    );
});

test("tryWithLock skips a held lock", async (t) => {
    const path = join(tempDir(t), "apply.lock");
    heldBy(path, process.pid);
    assert.deepEqual(await tryWithLock(path, async () => 1), { ran: false });
});

test("the lock is released when the function throws", async (t) => {
    const path = join(tempDir(t), "apply.lock");
    await assert.rejects(
        withLock(path, async () => {
            throw new Error("boom");
        }),
        /boom/,
    );
    assert.equal(existsSync(path), false);
    assert.deepEqual(await tryWithLock(path, async () => 2), {
        ran: true,
        value: 2,
    });
});
```

- [ ] **Step 3: Run to verify they fail**

Run: `mise exec -- node --test hermes/src/status.test.ts hermes/src/lock.test.ts`
Expected: FAIL, modules not found.

- [ ] **Step 4: Implement `status.ts`**

```ts
import { randomBytes } from "node:crypto";
import {
    closeSync,
    fsyncSync,
    mkdirSync,
    openSync,
    readFileSync,
    renameSync,
    rmSync,
    writeFileSync,
} from "node:fs";
import { dirname } from "node:path";
import { errorCode } from "./util.ts";

function fsyncPath(path: string, flags: string): void {
    const fd = openSync(path, flags);
    try {
        fsyncSync(fd);
    } finally {
        closeSync(fd);
    }
}

/**
 * Writes through a temporary file in the same directory, then renames. Both
 * the file and the directory are synced, so a host crash leaves the old
 * content or the new, never an empty file.
 */
export function writeFileAtomic(
    path: string,
    data: string | Uint8Array,
    mode = 0o644,
): void {
    mkdirSync(dirname(path), { recursive: true });
    const temp = `${path}.${process.pid}.${randomBytes(4).toString("hex")}.tmp`;
    try {
        const fd = openSync(temp, "wx", mode);
        try {
            writeFileSync(fd, data);
            fsyncSync(fd);
        } finally {
            closeSync(fd);
        }
        renameSync(temp, path);
    } catch (error) {
        rmSync(temp, { force: true });
        throw error;
    }
    fsyncPath(dirname(path), "r");
}

export function writeJson(path: string, value: unknown, mode = 0o644): void {
    writeFileAtomic(path, `${JSON.stringify(value, null, 2)}\n`, mode);
}

export function readJson<T>(path: string): T | null {
    const text = readText(path);
    return text === "" ? null : (JSON.parse(text) as T);
}

export function readText(path: string): string {
    try {
        return readFileSync(path, "utf8");
    } catch (error) {
        if (errorCode(error) === "ENOENT") return "";
        throw error;
    }
}

/** `/opt/data/dorothy/status/apply.json` */
export interface ApplyStatus {
    appliedSha?: string;
    rolledBackSha?: string;
    configRolledBack?: boolean;
    lastApplyAt?: string;
    lastError?: string;
}

/** `/opt/data/dorothy/status/snapshot.json` */
export interface SnapshotStatus {
    lastSuccessAt?: string;
    lastAttemptAt?: string;
    lastError?: string;
}

/** `/var/lib/dorothy/restore/status.json`, written by the sidecar. */
export interface SyncStatus {
    startedAt: string;
    restoreWrittenAt?: string;
    loopAt?: string;
    lastSuccessAt?: string;
    lastError?: string;
    lastBundleAt?: string;
    pendingCommits: number;
    pushRejected: boolean;
    largestFileBytes: number;
    sizeWarning: boolean;
}
```

- [ ] **Step 5: Implement `lock.ts`**

```ts
import {
    mkdirSync,
    mkdtempSync,
    readFileSync,
    renameSync,
    rmSync,
    statSync,
    writeFileSync,
} from "node:fs";
import { basename, dirname, join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { errorCode } from "./util.ts";

export class LockTimeout extends Error {}

export interface LockOptions {
    /** Give up after this long; default ten minutes. */
    waitMs?: number;
    pollMs?: number;
    pid?: number;
    isAlive?(pid: number): boolean;
}

export function pidAlive(pid: number): boolean {
    try {
        process.kill(pid, 0);
        return true;
    } catch (error) {
        return (error as NodeJS.ErrnoException).code === "EPERM";
    }
}

function owner(path: string): number | null {
    try {
        const pid = Number.parseInt(readFileSync(join(path, "pid"), "utf8"), 10);
        return Number.isInteger(pid) && pid > 0 ? pid : null;
    } catch {
        return null;
    }
}

/** A takeover guard is held for a few system calls; older means its holder died. */
const GUARD_STALE_MS = 60_000;

/**
 * The lock directory is built aside with its pid file, then renamed into
 * place, so a lock never exists without its owner recorded.
 */
function place(path: string, pid: number): boolean {
    const temp = mkdtempSync(join(dirname(path), `.${basename(path)}-`));
    writeFileSync(join(temp, "pid"), String(pid));
    try {
        renameSync(temp, path);
        return true;
    } catch (error) {
        rmSync(temp, { recursive: true, force: true });
        const code = errorCode(error);
        if (code !== "ENOTEMPTY" && code !== "EEXIST") throw error;
        return false;
    }
}

/**
 * Removes a dead owner's lock. Takeovers are serialised through a guard
 * directory, and the owner is read again under it, so a waiter never removes
 * a lock another waiter has meanwhile taken. Returns whether it held the guard.
 */
function takeOver(path: string, dead: number | null): boolean {
    const guard = `${path}.takeover`;
    try {
        mkdirSync(guard);
    } catch (error) {
        if (errorCode(error) !== "EEXIST") throw error;
        try {
            if (Date.now() - statSync(guard).mtimeMs > GUARD_STALE_MS) {
                rmSync(guard, { recursive: true, force: true });
            }
        } catch {}
        return false;
    }
    try {
        if (owner(path) === dead) rmSync(path, { recursive: true, force: true });
    } finally {
        rmSync(guard, { recursive: true, force: true });
    }
    return true;
}

/** One attempt. */
function tryAcquire(path: string, options: LockOptions): boolean {
    const pid = options.pid ?? process.pid;
    const isAlive = options.isAlive ?? pidAlive;
    if (place(path, pid)) return true;
    const held = owner(path);
    if (held !== null && isAlive(held)) return false;
    return takeOver(path, held) && place(path, pid);
}

function release(path: string, pid: number): void {
    if (owner(path) === pid) rmSync(path, { recursive: true, force: true });
}

export async function withLock<T>(
    path: string,
    fn: () => Promise<T>,
    options: LockOptions = {},
): Promise<T> {
    const deadline = Date.now() + (options.waitMs ?? 600_000);
    while (!tryAcquire(path, options)) {
        if (Date.now() >= deadline) {
            throw new LockTimeout(`timed out waiting for ${basename(path)}`);
        }
        await delay(options.pollMs ?? 500);
    }
    try {
        return await fn();
    } finally {
        release(path, options.pid ?? process.pid);
    }
}

export async function tryWithLock<T>(
    path: string,
    fn: () => Promise<T>,
    options: LockOptions = {},
): Promise<{ ran: true; value: T } | { ran: false }> {
    if (!tryAcquire(path, options)) return { ran: false };
    try {
        return { ran: true, value: await fn() };
    } finally {
        release(path, options.pid ?? process.pid);
    }
}
```

- [ ] **Step 6: Run the tests**

Run: `mise exec -- node --test hermes/src/status.test.ts hermes/src/lock.test.ts`
Expected: 9 pass.

- [ ] **Step 7: Commit**

```bash
bunx biome check --write hermes/src && bun run typecheck
git add hermes/src/status.ts hermes/src/lock.ts hermes/src/test-helpers.ts hermes/src/status.test.ts hermes/src/lock.test.ts
git commit -m "feat: Add atomic status files and pid locks"
```

---

### Task 4: Settings and allowlist refusals (S6)

**Files:**

- Create: `hermes/src/settings.ts`, `hermes/src/settings.test.ts`

**Interfaces:**

- Consumes: `hermes/src/platforms.json` (Task 1).
- Produces: `type Env = Record<string, string | undefined>`;
  `class SettingsError extends Error`;
  `interface PlatformRegistry` (shape in Task 1);
  `loadRegistry(path?: string | URL): PlatformRegistry`;
  `allowlistNames(registry): string[]`;
  `checkAllowlists(env: Env, registry): void`;
  `repoName(url: string): string | null`; `syncInterval(env: Env): number`;
  `interface HermesSettings { configRepo: string; configRepoName: string; configKey: string; interval: number }`;
  `hermesSettings(env: Env, registry): HermesSettings`;
  `interface SidecarSettings { memoryRepo: string; memoryKey: string; interval: number; bundleMaxBytes: number; allowEmpty: boolean; host: string }`;
  `sidecarSettings(env: Env): SidecarSettings`.

- [ ] **Step 1: Write the failing tests**

`hermes/src/settings.test.ts`:

```ts
import assert from "node:assert/strict";
import { test } from "node:test";
import {
    allowlistNames,
    hermesSettings,
    loadRegistry,
    type PlatformRegistry,
    repoName,
    SettingsError,
    sidecarSettings,
} from "./settings.ts";

const KEY = Buffer.from(
    "-----BEGIN OPENSSH PRIVATE KEY-----\nAAAA\n-----END OPENSSH PRIVATE KEY-----\n",
).toString("base64");

const registry: PlatformRegistry = {
    platforms: {
        telegram: {
            enabledBy: ["TELEGRAM_BOT_TOKEN"],
            allowedUsers: "TELEGRAM_ALLOWED_USERS",
            allowAllUsers: "TELEGRAM_ALLOW_ALL_USERS",
        },
        relay: { enabledBy: ["GATEWAY_RELAY_URL"], allowedUsers: "", allowAllUsers: "" },
    },
    globalAllowlist: "GATEWAY_ALLOWED_USERS",
    globalAllowAll: "GATEWAY_ALLOW_ALL_USERS",
    extraAllowVariables: [
        "PLUGIN_ALLOW_ALL_USERS",
        "TELEGRAM_ALLOW_BOTS",
        "TELEGRAM_GROUP_ALLOWED_USERS",
    ],
};

const base = {
    DOROTHY_CONFIG_REPO: "git@github.com:me/dorothy-config.git",
    DOROTHY_CONFIG_DEPLOY_KEY: KEY,
};

test("a minimal hermes environment is accepted with defaults", () => {
    const settings = hermesSettings(base, registry);
    assert.equal(settings.configRepoName, "me/dorothy-config");
    assert.equal(settings.interval, 900);
    assert.match(settings.configKey, /^-----BEGIN OPENSSH PRIVATE KEY-----\n/);
});

test("missing or malformed variables are named", () => {
    assert.throws(() => hermesSettings({}, registry), /DOROTHY_CONFIG_REPO is required/);
    assert.throws(
        () => hermesSettings({ ...base, DOROTHY_CONFIG_DEPLOY_KEY: "bm90IGEga2V5" }, registry),
        /DOROTHY_CONFIG_DEPLOY_KEY must be a base64-encoded private key/,
    );
    assert.throws(
        () => hermesSettings({ ...base, DOROTHY_SYNC_INTERVAL: "fast" }, registry),
        /DOROTHY_SYNC_INTERVAL must be a whole number of at least 60/,
    );
});

test("a non-GitHub repository needs an explicit name", () => {
    const env = { ...base, DOROTHY_CONFIG_REPO: "file:///fixtures/config.git" };
    assert.throws(() => hermesSettings(env, registry), /DOROTHY_CONFIG_REPO_NAME is required/);
    const named = hermesSettings({ ...env, DOROTHY_CONFIG_REPO_NAME: "smoke/config" }, registry);
    assert.equal(named.configRepoName, "smoke/config");
});

test("repository names derive from GitHub URLs", () => {
    assert.equal(repoName("https://github.com/me/dorothy-config"), "me/dorothy-config");
    assert.equal(repoName("git@github.com:me/dorothy.config.git"), "me/dorothy.config");
    assert.equal(repoName("file:///tmp/x.git"), null);
});

test("a platform token without its allowlist is refused", () => {
    assert.throws(
        () => hermesSettings({ ...base, TELEGRAM_BOT_TOKEN: "1:abc" }, registry),
        (error) =>
            error instanceof SettingsError &&
            /TELEGRAM_BOT_TOKEN enables telegram, but TELEGRAM_ALLOWED_USERS is empty/.test(
                error.message,
            ),
    );
    assert.doesNotThrow(() =>
        hermesSettings(
            { ...base, TELEGRAM_BOT_TOKEN: "1:abc", TELEGRAM_ALLOWED_USERS: "42" },
            registry,
        ),
    );
});

test("allow-all and allow-bots overrides are refused", () => {
    for (const name of [
        "GATEWAY_ALLOW_ALL_USERS",
        "TELEGRAM_ALLOW_ALL_USERS",
        "PLUGIN_ALLOW_ALL_USERS",
        "TELEGRAM_ALLOW_BOTS",
    ]) {
        assert.throws(() => hermesSettings({ ...base, [name]: "true" }, registry), new RegExp(name));
    }
    assert.doesNotThrow(() => hermesSettings({ ...base, GATEWAY_ALLOW_ALL_USERS: "false" }, registry));
});

test("a wildcard entry in any allowlist is refused", () => {
    for (const [name, value] of [
        ["TELEGRAM_ALLOWED_USERS", "42,*"],
        ["GATEWAY_ALLOWED_USERS", " * "],
        ["TELEGRAM_GROUP_ALLOWED_USERS", '["*"]'],
    ] as const) {
        assert.throws(
            () => hermesSettings({ ...base, [name]: value }, registry),
            new RegExp(`${name} contains "\\*"`),
        );
    }
    assert.doesNotThrow(() => hermesSettings({ ...base, TELEGRAM_ALLOWED_USERS: "42,43" }, registry));
});

test("allowlistNames lists every allowlist and override once", () => {
    assert.deepEqual(allowlistNames(registry), [
        "GATEWAY_ALLOWED_USERS",
        "GATEWAY_ALLOW_ALL_USERS",
        "PLUGIN_ALLOW_ALL_USERS",
        "TELEGRAM_ALLOWED_USERS",
        "TELEGRAM_ALLOW_ALL_USERS",
        "TELEGRAM_ALLOW_BOTS",
        "TELEGRAM_GROUP_ALLOWED_USERS",
    ]);
});

test("the generated registry has the shape settings expect", () => {
    const real = loadRegistry();
    assert.equal(real.platforms.telegram?.allowedUsers, "TELEGRAM_ALLOWED_USERS");
    assert.ok(real.extraAllowVariables.length > 0);
});

test("sidecar settings validate and default", () => {
    const settings = sidecarSettings({
        DOROTHY_MEMORY_REPO: "git@github.com:me/dorothy-memory.git",
        DOROTHY_MEMORY_DEPLOY_KEY: KEY,
        DOROTHY_HOST: "server-1",
    });
    assert.equal(settings.bundleMaxBytes, 256 * 1024 * 1024);
    assert.equal(settings.allowEmpty, false);
    assert.equal(settings.host, "server-1");
    assert.throws(() => sidecarSettings({}), /DOROTHY_MEMORY_REPO is required/);
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `mise exec -- node --test hermes/src/settings.test.ts`
Expected: FAIL, module not found.

- [ ] **Step 3: Implement `settings.ts`**

```ts
import { readFileSync } from "node:fs";
import { hostname } from "node:os";

export type Env = Record<string, string | undefined>;

export class SettingsError extends Error {}

export interface PlatformEntry {
    enabledBy: string[];
    allowedUsers: string;
    allowAllUsers: string;
}

/** Generated from the pinned image by `scripts/platforms.py` (S6). */
export interface PlatformRegistry {
    platforms: Record<string, PlatformEntry>;
    globalAllowlist: string;
    globalAllowAll: string;
    extraAllowVariables: string[];
}

export function loadRegistry(
    path: string | URL = new URL("./platforms.json", import.meta.url),
): PlatformRegistry {
    return JSON.parse(readFileSync(path, "utf8")) as PlatformRegistry;
}

const FALSY = new Set(["", "0", "false", "no", "off"]);

function isSet(value: string | undefined): boolean {
    return !FALSY.has((value ?? "").trim().toLowerCase());
}

/** Every variable that grants access, for the `.env` cleanup. */
export function allowlistNames(registry: PlatformRegistry): string[] {
    const names = new Set<string>([
        registry.globalAllowlist,
        registry.globalAllowAll,
        ...registry.extraAllowVariables,
    ]);
    for (const entry of Object.values(registry.platforms)) {
        names.add(entry.allowedUsers);
        names.add(entry.allowAllUsers);
    }
    names.delete("");
    return [...names].sort();
}

/** Upstream reads a `*` entry in any allowlist as "everyone". */
function hasWildcard(value: string | undefined): boolean {
    return (value ?? "").split(/[\s,[\]"']+/).includes("*");
}

export function checkAllowlists(env: Env, registry: PlatformRegistry): void {
    const platforms = Object.values(registry.platforms);
    const allowAll = [
        registry.globalAllowAll,
        ...platforms.map((entry) => entry.allowAllUsers),
        ...registry.extraAllowVariables.filter((name) => name.endsWith("_ALLOW_ALL_USERS")),
    ];
    for (const name of allowAll) {
        if (name && isSet(env[name])) {
            throw new SettingsError(`${name} lets anyone talk to Dorothy; remove it`);
        }
    }
    const allowlists = [
        registry.globalAllowlist,
        ...platforms.map((entry) => entry.allowedUsers),
        ...registry.extraAllowVariables.filter((name) => /_ALLOWED_[A-Z]+$/.test(name)),
    ];
    for (const name of allowlists) {
        if (name && hasWildcard(env[name])) {
            throw new SettingsError(`${name} contains "*", which lets anyone in; remove it`);
        }
    }
    for (const name of registry.extraAllowVariables) {
        if (name.endsWith("_ALLOW_BOTS") && isSet(env[name])) {
            throw new SettingsError(`${name} admits bots past the allowlist; remove it`);
        }
    }
    for (const [platform, entry] of Object.entries(registry.platforms)) {
        if (!entry.allowedUsers) continue;
        const enabledBy = entry.enabledBy.filter((name) => isSet(env[name]));
        if (enabledBy.length > 0 && !(env[entry.allowedUsers] ?? "").trim()) {
            throw new SettingsError(
                `${enabledBy.join(", ")} enables ${platform}, but ${entry.allowedUsers} is empty`,
            );
        }
    }
}

function required(env: Env, name: string): string {
    const value = (env[name] ?? "").trim();
    if (!value) throw new SettingsError(`${name} is required`);
    return value;
}

function privateKey(env: Env, name: string): string {
    const text = Buffer.from(required(env, name), "base64").toString("utf8");
    if (!/-----BEGIN [A-Z ]*PRIVATE KEY-----/.test(text)) {
        throw new SettingsError(`${name} must be a base64-encoded private key`);
    }
    return text.endsWith("\n") ? text : `${text}\n`;
}

function wholeNumber(env: Env, name: string, fallback: number, minimum: number): number {
    const raw = (env[name] ?? "").trim() || String(fallback);
    if (!/^\d+$/.test(raw) || Number(raw) < minimum) {
        throw new SettingsError(`${name} must be a whole number of at least ${minimum}`);
    }
    return Number(raw);
}

export function repoName(url: string): string | null {
    return /github\.com[:/]([\w.-]+\/[\w.-]+?)(?:\.git)?\/?$/.exec(url)?.[1] ?? null;
}

export function syncInterval(env: Env): number {
    return wholeNumber(env, "DOROTHY_SYNC_INTERVAL", 900, 60);
}

export interface HermesSettings {
    configRepo: string;
    configRepoName: string;
    /** PEM text, decoded from base64. */
    configKey: string;
    interval: number;
}

export function hermesSettings(env: Env, registry: PlatformRegistry): HermesSettings {
    const configRepo = required(env, "DOROTHY_CONFIG_REPO");
    const configRepoName =
        (env.DOROTHY_CONFIG_REPO_NAME ?? "").trim() || repoName(configRepo);
    if (!configRepoName) {
        throw new SettingsError(
            "DOROTHY_CONFIG_REPO_NAME is required when DOROTHY_CONFIG_REPO is not a GitHub URL",
        );
    }
    const settings = {
        configRepo,
        configRepoName,
        configKey: privateKey(env, "DOROTHY_CONFIG_DEPLOY_KEY"),
        interval: syncInterval(env),
    };
    checkAllowlists(env, registry);
    return settings;
}

export interface SidecarSettings {
    memoryRepo: string;
    memoryKey: string;
    interval: number;
    bundleMaxBytes: number;
    allowEmpty: boolean;
    /** Names the server in sync commit messages. */
    host: string;
}

export function sidecarSettings(env: Env): SidecarSettings {
    return {
        memoryRepo: required(env, "DOROTHY_MEMORY_REPO"),
        memoryKey: privateKey(env, "DOROTHY_MEMORY_DEPLOY_KEY"),
        interval: syncInterval(env),
        bundleMaxBytes: wholeNumber(env, "DOROTHY_BUNDLE_MAX_BYTES", 256 * 1024 * 1024, 1),
        allowEmpty: (env.DOROTHY_ALLOW_EMPTY ?? "").trim() === "1",
        host: (env.DOROTHY_HOST ?? "").trim() || hostname(),
    };
}
```

- [ ] **Step 4: Run the tests**

Run: `mise exec -- node --test hermes/src/settings.test.ts`
Expected: 10 pass.

- [ ] **Step 5: Commit**

```bash
bunx biome check --write hermes/src && bun run typecheck
git add hermes/src/settings.ts hermes/src/settings.test.ts
git commit -m "feat: Validate settings and refuse open access"
```

---

### Task 5: Redaction (S5)

**Files:**

- Create: `hermes/src/redact.ts`, `hermes/src/redact.test.ts`

**Interfaces:**

- Produces: `SECRET_NAME: RegExp`; `MIN_SECRET_LENGTH = 8`;
  `interface DotenvSpan { text: string; name?: string; value?: string; invalid?: boolean }`;
  `dotenvSpans(text: string): DotenvSpan[]` (python-dotenv's grammar; the
  spans' texts join back into the input);
  `parseDotenv(text: string): Map<string, string>`;
  `collectSecrets(sources: Iterable<[string, string | undefined]>): Map<string, string>`
  (value to name);
  `class Redactor { constructor(secrets: Map<string, string>); text(input: string): string; bytes(input: Uint8Array): Uint8Array }`.

- [ ] **Step 1: Write the failing tests**

`hermes/src/redact.test.ts`:

```ts
import assert from "node:assert/strict";
import { test } from "node:test";
import { collectSecrets, dotenvSpans, parseDotenv, Redactor } from "./redact.ts";

test("named secrets are redacted as written", () => {
    const redactor = new Redactor(
        collectSecrets([
            ["TELEGRAM_BOT_TOKEN", "123456:telegram-secret"],
            ["HOME", "/opt/data/not-a-secret"],
        ]),
    );
    assert.equal(
        redactor.text("token 123456:telegram-secret in /opt/data/not-a-secret"),
        "token [REDACTED:TELEGRAM_BOT_TOKEN] in /opt/data/not-a-secret",
    );
});

test("values shorter than eight characters are skipped", () => {
    const redactor = new Redactor(collectSecrets([["SHORT_KEY", "abc1234"]]));
    assert.equal(redactor.text("abc1234"), "abc1234");
});

test("deploy keys are redacted per decoded line", () => {
    const pem =
        "-----BEGIN OPENSSH PRIVATE KEY-----\n" +
        "b3BlbnNzaC1rZXktdjEAAAAABG5vbmUAAAAEbm9uZQAAAAAAAAABAAAAMwAAAAtzc2gtZW\n" +
        "-----END OPENSSH PRIVATE KEY-----\n";
    const encoded = Buffer.from(pem).toString("base64");
    const redactor = new Redactor(collectSecrets([["DOROTHY_CONFIG_DEPLOY_KEY", encoded]]));
    const leaked = "cat key: b3BlbnNzaC1rZXktdjEAAAAABG5vbmUAAAAEbm9uZQAAAAAAAAABAAAAMwAAAAtzc2gtZW";
    assert.equal(redactor.text(leaked), "cat key: [REDACTED:DOROTHY_CONFIG_DEPLOY_KEY]");
    assert.equal(redactor.text(encoded), "[REDACTED:DOROTHY_CONFIG_DEPLOY_KEY]");
    assert.equal(redactor.text("-----BEGIN OPENSSH PRIVATE KEY-----"), "-----BEGIN OPENSSH PRIVATE KEY-----");
});

test("bytes are redacted too", () => {
    const redactor = new Redactor(collectSecrets([["API_SERVER_KEY", "generated-api-key-1"]]));
    const out = redactor.bytes(Buffer.from("\u0000generated-api-key-1\u0001"));
    assert.equal(Buffer.from(out).toString(), "\u0000[REDACTED:API_SERVER_KEY]\u0001");
});

test("longer secrets are replaced before the secrets they contain", () => {
    const redactor = new Redactor(
        collectSecrets([
            ["A_TOKEN", "abcdefgh"],
            ["B_TOKEN", "abcdefgh-ijklmnop"],
        ]),
    );
    assert.equal(redactor.text("abcdefgh-ijklmnop"), "[REDACTED:B_TOKEN]");
});

test("dotenv text is read as python-dotenv reads it", () => {
    const text = [
        "# comment",
        "API_SERVER_KEY=plain-value-1 # trailing comment",
        'export QUOTED_TOKEN="say \\"hi\\" \\\\ 2"',
        "SINGLE_SECRET='single value 3'",
        "'QUOTED_KEY'=value-4",
        'MULTI_TOKEN="line one',
        'line two"',
        "",
        "not a line",
        'BROKEN_TOKEN="unterminated',
    ].join("\n");
    assert.deepEqual([...parseDotenv(text)], [
        ["API_SERVER_KEY", "plain-value-1"],
        ["QUOTED_TOKEN", 'say "hi" \\ 2'],
        ["SINGLE_SECRET", "single value 3"],
        ["QUOTED_KEY", "value-4"],
        ["MULTI_TOKEN", "line one\nline two"],
    ]);
    const spans = dotenvSpans(text);
    assert.equal(spans.map((span) => span.text).join(""), text);
    assert.deepEqual(
        spans.filter((span) => span.invalid).map((span) => span.text.trim()),
        ["not a line", 'BROKEN_TOKEN="unterminated'],
    );
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `mise exec -- node --test hermes/src/redact.test.ts`
Expected: FAIL, module not found.

- [ ] **Step 3: Implement `redact.ts`**

```ts
/** Variable names whose values are treated as secrets (S5). */
export const SECRET_NAME = /_(TOKEN|KEY|SECRET|PASSWORD)$/;
export const MIN_SECRET_LENGTH = 8;

/** One piece of a `.env` file; joining every span's text gives the file back. */
export interface DotenvSpan {
    text: string;
    name?: string;
    value?: string;
    /** A line python-dotenv skips with a warning. */
    invalid?: boolean;
}

// python-dotenv's grammar (dotenv/parser.py), which upstream loads `.env` with.
const BLANK = /\s+/y;
const EXPORT = /export[^\S\r\n]+/y;
const QUOTED_KEY = /'([^']+)'/y;
const KEY = /[^=#\s]+/y;
const GAP = /[^\S\r\n]*/y;
const EQUALS = /=[^\S\r\n]*/y;
const SINGLE = /'((?:\\'|[^'])*)'/y;
const DOUBLE = /"((?:\\"|[^"])*)"/y;
const UNQUOTED = /[^\r\n]*/y;
const END = /[^\S\r\n]*(?:#[^\r\n]*)?[^\S\r\n]*(?:\r\n|\n|\r|$)/y;
const REST = /[^\r\n]*(?:\r|\n|\r\n)?/y;
const ESCAPES: Record<string, string> = {
    "\\": "\\",
    "'": "'",
    '"': '"',
    a: "\u0007",
    b: "\b",
    f: "\f",
    n: "\n",
    r: "\r",
    t: "\t",
    v: "\v",
};

interface Binding {
    name?: string;
    value?: string;
    /** Where reading stopped; on failure, python-dotenv skips the rest of that line. */
    end: number;
    failed: boolean;
}

function binding(source: string, start: number): Binding {
    let index = start;
    const step = (pattern: RegExp): RegExpExecArray | null => {
        pattern.lastIndex = index;
        const match = pattern.exec(source);
        if (match) index += match[0].length;
        return match;
    };
    const failed = (): Binding => {
        step(REST);
        return { end: index, failed: true };
    };
    let name: string | undefined;
    let value: string | undefined;
    step(EXPORT);
    if (source[index] !== "#") {
        const key = source[index] === "'" ? step(QUOTED_KEY)?.[1] : step(KEY)?.[0];
        if (key === undefined) return failed();
        name = key;
        step(GAP);
        if (step(EQUALS)) {
            const quote = source[index];
            if (quote === "'" || quote === '"') {
                const match = step(quote === "'" ? SINGLE : DOUBLE);
                if (!match) return failed();
                value = (match[1] ?? "").replace(
                    quote === "'" ? /\\([\\'])/g : /\\([\\'"abfnrtv])/g,
                    (_, escaped: string) => ESCAPES[escaped] ?? escaped,
                );
            } else {
                value = (step(UNQUOTED)?.[0] ?? "").replace(/\s+#.*/, "").trimEnd();
            }
        }
    }
    if (!step(END)) return failed();
    return { name, value, end: index, failed: false };
}

/** Splits `.env` text exactly as python-dotenv reads it, keeping every byte. */
export function dotenvSpans(source: string): DotenvSpan[] {
    const spans: DotenvSpan[] = [];
    let index = 0;
    while (index < source.length) {
        BLANK.lastIndex = index;
        const blank = BLANK.exec(source);
        if (blank) {
            index += blank[0].length;
            spans.push({ text: blank[0] });
            continue;
        }
        const entry = binding(source, index);
        const text = source.slice(index, entry.end);
        index = entry.end;
        spans.push(entry.failed ? { text, invalid: true } : { text, name: entry.name, value: entry.value });
    }
    return spans;
}

export function parseDotenv(text: string): Map<string, string> {
    const values = new Map<string, string>();
    for (const span of dotenvSpans(text)) {
        if (span.name !== undefined && span.value !== undefined) values.set(span.name, span.value);
    }
    return values;
}

/** Maps each secret value (and each decoded key line) to its variable name. */
export function collectSecrets(
    sources: Iterable<[string, string | undefined]>,
): Map<string, string> {
    const secrets = new Map<string, string>();
    const add = (value: string, name: string): void => {
        if (value.length >= MIN_SECRET_LENGTH && !secrets.has(value)) {
            secrets.set(value, name);
        }
    };
    for (const [name, value] of sources) {
        if (!value || !SECRET_NAME.test(name)) continue;
        add(value, name);
        const decoded = Buffer.from(value, "base64").toString("utf8");
        if (!decoded.includes("-----BEGIN")) continue;
        for (const line of decoded.split(/\r?\n/)) {
            const trimmed = line.trim();
            if (trimmed.length > 20 && !trimmed.startsWith("-----")) add(trimmed, name);
        }
    }
    return secrets;
}

export class Redactor {
    readonly #entries: [string, string][];

    constructor(secrets: Map<string, string>) {
        this.#entries = [...secrets].sort((a, b) => b[0].length - a[0].length);
    }

    text(input: string): string {
        let output = input;
        for (const [value, name] of this.#entries) {
            if (output.includes(value)) output = output.replaceAll(value, `[REDACTED:${name}]`);
        }
        return output;
    }

    bytes(input: Uint8Array): Uint8Array {
        let output = Buffer.from(input);
        for (const [value, name] of this.#entries) {
            const needle = Buffer.from(value);
            let at = output.indexOf(needle);
            if (at < 0) continue;
            const marker = Buffer.from(`[REDACTED:${name}]`);
            const parts: Buffer[] = [];
            let from = 0;
            while (at >= 0) {
                parts.push(output.subarray(from, at), marker);
                from = at + needle.length;
                at = output.indexOf(needle, from);
            }
            parts.push(output.subarray(from));
            output = Buffer.concat(parts);
        }
        return output;
    }
}
```

- [ ] **Step 4: Run the tests**

Run: `mise exec -- node --test hermes/src/redact.test.ts`
Expected: 6 pass.

- [ ] **Step 5: Commit**

```bash
bunx biome check --write hermes/src && bun run typecheck
git add hermes/src/redact.ts hermes/src/redact.test.ts
git commit -m "feat: Redact known secret values from bundles"
```

---

### Task 6: Deterministic dump and restore

**Files:**

- Create: `hermes/src/dump.ts`, `hermes/src/dump.test.ts`

**Interfaces:**

- Produces: `class DumpError extends Error`;
  `interface DumpOptions { mapText?(value: string): string; mapBlob?(value: Uint8Array): Uint8Array }`;
  `ident(name: string): string`;
  `literal(value: unknown, options?: DumpOptions): string`;
  `interface SchemaObject { type: string; name: string; tbl_name: string; sql: string | null }`;
  `omittedObjects(objects: SchemaObject[]): Set<string>`;
  `dumpDatabase(path: string, options?: DumpOptions): string`;
  `restoreDatabase(sql: string, path: string): void`;
  `checkTables(path: string): void` (throws `DumpError`).

- [ ] **Step 1: Write the failing tests**

`hermes/src/dump.test.ts`:

```ts
import assert from "node:assert/strict";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { type TestContext, test } from "node:test";
import { checkTables, DumpError, dumpDatabase, literal, restoreDatabase } from "./dump.ts";
import { tempDir } from "./test-helpers.ts";

function fixture(t: TestContext): string {
    const path = join(tempDir(t), "state.db");
    const db = new DatabaseSync(path);
    db.exec(`
        PRAGMA user_version = 7;
        CREATE TABLE messages (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            body TEXT, data BLOB, score REAL, big INTEGER
        );
        CREATE TABLE kv (k TEXT PRIMARY KEY, v TEXT) WITHOUT ROWID;
        CREATE TABLE audit (n INTEGER);
        CREATE INDEX messages_body ON messages(body);
        CREATE VIEW messages_fts_src AS SELECT id, body FROM messages;
        CREATE VIRTUAL TABLE messages_fts USING fts5(
            body, content='messages_fts_src', content_rowid='id'
        );
        CREATE TRIGGER messages_fts_insert AFTER INSERT ON messages BEGIN
            INSERT INTO messages_fts(rowid, body) VALUES (new.id, new.body);
        END;
        CREATE TRIGGER messages_audit AFTER INSERT ON messages BEGIN
            INSERT INTO audit(n) VALUES (new.id);
        END;
        CREATE VIEW recent AS SELECT id FROM messages ORDER BY id DESC;
        CREATE TABLE fts_v22_trash_1 (x);
        INSERT INTO messages(body, data, score, big)
            VALUES ('it''s plain', X'0001FEFF', 3.0, 1152921504606846977);
        INSERT INTO messages(body, data, score, big)
            VALUES ('東京は晴れです', NULL, 0.1, -4611686018427387904);
        INSERT INTO messages(body, data, score, big)
            VALUES ('nul' || char(0) || 'inside', X'', 1e300, 42);
        INSERT INTO messages(body) VALUES ('deleted');
        DELETE FROM messages WHERE body = 'deleted';
        INSERT INTO kv VALUES ('b', '2'), ('a', '1');
        ANALYZE;
    `);
    db.close();
    return path;
}

test("a dump restores to identical rows and dumps identically", (t) => {
    const original = fixture(t);
    const sql = dumpDatabase(original);
    assert.equal(dumpDatabase(original), sql, "dumping twice is byte-identical");
    const restored = join(tempDir(t), "restored.db");
    restoreDatabase(sql, restored);
    assert.equal(dumpDatabase(restored), sql);

    const db = new DatabaseSync(restored, { readOnly: true });
    const big = db.prepare("SELECT big, typeof(score) AS kind FROM messages WHERE id = 1");
    big.setReadBigInts(true);
    assert.deepEqual({ ...big.get() }, { big: 1152921504606846977n, kind: "real" });
    assert.deepEqual({ ...db.prepare("PRAGMA user_version").get() }, { user_version: 7 });
    assert.deepEqual({ ...db.prepare("SELECT seq FROM sqlite_sequence WHERE name = 'messages'").get() }, { seq: 4 });
    const nul = db.prepare("SELECT body FROM messages WHERE id = 3").get();
    assert.equal(nul?.body, "nul\u0000inside");
    db.close();
});

test("FTS objects, statistics and trash tables are omitted", (t) => {
    const sql = dumpDatabase(fixture(t));
    for (const absent of ["messages_fts", "sqlite_stat", "fts_v22_trash", "messages_fts_src"]) {
        assert.equal(sql.includes(absent), false, `${absent} is omitted`);
    }
    for (const present of ["CREATE TRIGGER messages_audit", "CREATE VIEW recent", "CREATE INDEX messages_body"]) {
        assert.ok(sql.includes(present), `${present} is kept`);
    }
});

test("indexes, views and triggers follow all data", (t) => {
    const sql = dumpDatabase(fixture(t));
    const lastInsert = sql.lastIndexOf("\nINSERT INTO ");
    assert.ok(sql.indexOf("CREATE INDEX") > lastInsert);
    assert.ok(sql.indexOf("CREATE TRIGGER") > lastInsert);
    assert.ok(sql.startsWith("PRAGMA foreign_keys=OFF;\nBEGIN;\nPRAGMA user_version=7;\n"));
    assert.ok(sql.endsWith("COMMIT;\n"));
});

test("an unsupported virtual table fails loudly", (t) => {
    const path = join(tempDir(t), "rtree.db");
    const db = new DatabaseSync(path);
    db.exec("CREATE VIRTUAL TABLE boxes USING rtree(id, x0, x1)");
    db.close();
    assert.throws(() => dumpDatabase(path), DumpError);
});

test("text and blob values pass through the redaction hooks", (t) => {
    const sql = dumpDatabase(fixture(t), {
        mapText: (value) => value.replaceAll("plain", "[REDACTED:X]"),
        mapBlob: () => Buffer.from("ab"),
    });
    assert.ok(sql.includes("'it''s [REDACTED:X]'"));
    assert.ok(sql.includes("X'6162'"));
});

test("literals cover every storage class", () => {
    assert.equal(literal(null), "NULL");
    assert.equal(literal(3), "3.0");
    assert.equal(literal(0.1), "0.1");
    assert.equal(literal(1e300), "1e+300");
    assert.equal(literal(Number.POSITIVE_INFINITY), "9e999");
    assert.equal(literal(Number.NEGATIVE_INFINITY), "-9e999");
    assert.equal(literal(2n ** 63n - 1n), "9223372036854775807");
    assert.equal(literal("o'k"), "'o''k'");
    assert.equal(literal("a\u0000b"), "CAST(X'610062' AS TEXT)");
    assert.equal(literal(new Uint8Array([0, 255])), "X'00FF'");
});

test("checkTables passes a healthy database", (t) => {
    assert.doesNotThrow(() => checkTables(fixture(t)));
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `mise exec -- node --test hermes/src/dump.test.ts`
Expected: FAIL, module not found.

- [ ] **Step 3: Implement `dump.ts`**

```ts
import { DatabaseSync } from "node:sqlite";

export class DumpError extends Error {}

export interface DumpOptions {
    mapText?(value: string): string;
    mapBlob?(value: Uint8Array): Uint8Array;
}

export interface SchemaObject {
    type: string;
    name: string;
    tbl_name: string;
    sql: string | null;
}

const FTS5 = /^\s*CREATE\s+VIRTUAL\s+TABLE\s+.*?\bUSING\s+fts5\b/is;
const VIRTUAL = /^\s*CREATE\s+VIRTUAL\s+TABLE\b/i;
const WITHOUT_ROWID = /\bWITHOUT\s+ROWID\s*$/i;
const SHADOW_SUFFIXES = ["_data", "_idx", "_content", "_docsize", "_config"];

export function ident(name: string): string {
    return `"${name.replaceAll('"', '""')}"`;
}

function escapeRegExp(text: string): string {
    return text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function refersTo(sql: string, names: Set<string>): boolean {
    for (const name of names) {
        if (new RegExp(`(^|[^\\w$])${escapeRegExp(name)}($|[^\\w$])`, "i").test(sql)) {
            return true;
        }
    }
    return false;
}

/**
 * FTS5 tables, their shadow tables and content views, statistics, orphaned
 * trash tables, and every view, trigger and index that depends on them.
 * Hermes rebuilds the search indexes on its first open after a restore.
 */
export function omittedObjects(objects: SchemaObject[]): Set<string> {
    const omitted = new Set<string>();
    const views = new Set(objects.filter((o) => o.type === "view").map((o) => o.name));
    for (const object of objects) {
        const sql = object.sql ?? "";
        if (object.type === "table" && FTS5.test(sql)) {
            omitted.add(object.name);
            for (const suffix of SHADOW_SUFFIXES) omitted.add(object.name + suffix);
            const content = /\bcontent\s*=\s*['"]?(\w+)/i.exec(sql)?.[1];
            if (content && views.has(content)) omitted.add(content);
        }
        if (/^sqlite_stat\d+$/.test(object.name) || object.name.startsWith("fts_v22_trash_")) {
            omitted.add(object.name);
        }
    }
    let grew = true;
    while (grew) {
        grew = false;
        for (const object of objects) {
            const dependent = object.type === "view" || object.type === "trigger";
            if (dependent && !omitted.has(object.name) && refersTo(object.sql ?? "", omitted)) {
                omitted.add(object.name);
                grew = true;
            }
        }
    }
    for (const object of objects) {
        if (object.type === "index" && omitted.has(object.tbl_name)) omitted.add(object.name);
    }
    return omitted;
}

export function literal(value: unknown, options: DumpOptions = {}): string {
    if (value === null) return "NULL";
    if (typeof value === "bigint") return value.toString();
    if (typeof value === "number") {
        if (value === Number.POSITIVE_INFINITY) return "9e999";
        if (value === Number.NEGATIVE_INFINITY) return "-9e999";
        if (Number.isNaN(value)) return "NULL";
        const text = String(value);
        return /[.e]/.test(text) ? text : `${text}.0`;
    }
    if (typeof value === "string") {
        const text = options.mapText?.(value) ?? value;
        // sqlite3_exec stops at a NUL, so such text travels as hex.
        if (text.includes("\u0000")) {
            return `CAST(X'${Buffer.from(text, "utf8").toString("hex").toUpperCase()}' AS TEXT)`;
        }
        return `'${text.replaceAll("'", "''")}'`;
    }
    if (value instanceof Uint8Array) {
        const bytes = options.mapBlob?.(value) ?? value;
        return `X'${Buffer.from(bytes).toString("hex").toUpperCase()}'`;
    }
    throw new DumpError(`unsupported value of type ${typeof value}`);
}

function schema(db: DatabaseSync): SchemaObject[] {
    return db
        .prepare("SELECT type, name, tbl_name, sql FROM sqlite_master ORDER BY name")
        .all() as unknown as SchemaObject[];
}

function dataTables(objects: SchemaObject[], omitted: Set<string>): SchemaObject[] {
    return objects.filter(
        (o) => o.type === "table" && !omitted.has(o.name) && !o.name.startsWith("sqlite_"),
    );
}

export function dumpDatabase(path: string, options: DumpOptions = {}): string {
    const db = new DatabaseSync(path, { readOnly: true });
    try {
        const objects = schema(db);
        const omitted = omittedObjects(objects);
        const version = db.prepare("PRAGMA user_version").get() as { user_version: number };
        const out = ["PRAGMA foreign_keys=OFF;", "BEGIN;", `PRAGMA user_version=${version.user_version};`];
        for (const table of dataTables(objects, omitted)) {
            const sql = table.sql ?? "";
            if (VIRTUAL.test(sql)) throw new DumpError(`unsupported virtual table ${table.name}`);
            out.push(`${sql};`);
            const columns = (
                db.prepare(`PRAGMA table_xinfo(${ident(table.name)})`).all() as unknown as {
                    name: string;
                    hidden: number;
                }[]
            )
                .filter((column) => column.hidden === 0)
                .map((column) => ident(column.name));
            const order = WITHOUT_ROWID.test(sql) ? "" : " ORDER BY rowid";
            const select = db.prepare(
                `SELECT ${columns.join(", ")} FROM ${ident(table.name)}${order}`,
            );
            select.setReadBigInts(true);
            select.setReturnArrays(true);
            const target = `INSERT INTO ${ident(table.name)}(${columns.join(",")}) VALUES(`;
            for (const row of select.iterate() as Iterable<unknown[]>) {
                out.push(`${target}${row.map((value) => literal(value, options)).join(",")});`);
            }
        }
        if (objects.some((o) => o.name === "sqlite_sequence")) {
            out.push("DELETE FROM sqlite_sequence;");
            const sequence = db.prepare("SELECT name, seq FROM sqlite_sequence ORDER BY name");
            sequence.setReadBigInts(true);
            for (const row of sequence.all() as unknown as { name: string; seq: bigint }[]) {
                if (omitted.has(row.name)) continue;
                out.push(
                    `INSERT INTO sqlite_sequence(name,seq) VALUES(${literal(row.name)},${literal(row.seq)});`,
                );
            }
        }
        for (const type of ["index", "view", "trigger"]) {
            for (const object of objects) {
                if (object.type === type && object.sql && !omitted.has(object.name)) {
                    out.push(`${object.sql};`);
                }
            }
        }
        out.push("COMMIT;");
        return `${out.join("\n")}\n`;
    } finally {
        db.close();
    }
}

export function restoreDatabase(sql: string, path: string): void {
    const db = new DatabaseSync(path);
    try {
        db.exec(sql);
    } catch (error) {
        if (db.isTransaction) db.exec("ROLLBACK");
        throw error;
    } finally {
        db.close();
    }
}

/**
 * `quick_check` per ordinary table: a whole-database check would touch the
 * FTS tables, whose CJK tokenizer Node cannot load.
 */
export function checkTables(path: string): void {
    const db = new DatabaseSync(path, { readOnly: true });
    try {
        const objects = schema(db);
        for (const table of dataTables(objects, omittedObjects(objects))) {
            if (VIRTUAL.test(table.sql ?? "")) continue;
            const quoted = `'${table.name.replaceAll("'", "''")}'`;
            const rows = db.prepare(`PRAGMA quick_check(${quoted})`).all() as unknown as {
                quick_check: string;
            }[];
            const problems = rows.map((row) => row.quick_check).filter((message) => message !== "ok");
            if (problems.length > 0) {
                throw new DumpError(`integrity check failed for ${table.name}: ${problems.join("; ")}`);
            }
        }
    } finally {
        db.close();
    }
}
```

- [ ] **Step 4: Run the tests**

Run: `mise exec -- node --test hermes/src/dump.test.ts`
Expected: 7 pass. If `setReturnArrays` or `isTransaction` is missing from
`@types/node`, stop: the pinned Node predates them, which Task 1 would have
caught.

- [ ] **Step 5: Dump a real Hermes database**

`~/.hermes` holds a reference install the user permits modifying. Its
`state.db` has the real schema:

```bash
(cd ~/.hermes && hermes backup --quick --label dumpcheck)
snap=$(ls -d ~/.hermes/state-snapshots/*-dumpcheck | tail -n 1)
mise exec -- node -e "
import('./hermes/src/dump.ts').then(({ checkTables, dumpDatabase, restoreDatabase }) => {
    const src = '$snap/state.db';
    checkTables(src);
    const sql = dumpDatabase(src);
    restoreDatabase(sql, '/tmp/dorothy-dumpcheck.db');
    console.log(dumpDatabase('/tmp/dorothy-dumpcheck.db') === sql ? 'identical' : 'DIFFERENT');
});"
rm -f /tmp/dorothy-dumpcheck.db
gtrash put "$snap"
```

Expected: `identical`. A difference or error is a dump bug against the real
schema: fix it, add the failing shape to the fixture, then continue.

- [ ] **Step 6: Commit**

```bash
bunx biome check --write hermes/src && bun run typecheck
git add hermes/src/dump.ts hermes/src/dump.test.ts
git commit -m "feat: Dump state.db as deterministic SQL"
```

---

### Task 7: The bundle format (S2)

**Files:**

- Create: `hermes/src/bundle.ts`, `hermes/src/bundle.test.ts`

**Interfaces:**

- Consumes: `writeFileAtomic` (Task 3).
- Produces: `type FileMode = 0o644 | 0o755`;
  `interface BundleFile { path: string; mode: FileMode; encoding: "utf8" | "base64"; content: string }`;
  `interface Bundle { version: 1; createdAt: string; generation: string; memorySha?: string; bundleHash?: string; seed: boolean; files: BundleFile[] }`;
  `class BundleError extends Error`; `validPath(path: string): boolean`;
  `encodeFile(path: string, bytes: Uint8Array, mode: FileMode): BundleFile`;
  `fileBytes(file: BundleFile): Buffer`; `sha256(bytes: Uint8Array): string`;
  `validateBundle(value: unknown): Bundle`;
  `writeBundle(path: string, bundle: Bundle): string` (returns the hash);
  `readExactly(fd: number, size: number): Buffer`;
  `interface OpenedBundle { bundle: Bundle; hash: string }`;
  `openBundle(path: string, maxBytes: number): OpenedBundle | null`;
  `readTrustedBundle(path: string): Bundle` (for `restore.json`).

- [ ] **Step 1: Write the failing tests**

`hermes/src/bundle.test.ts`:

```ts
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { closeSync, openSync, symlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import {
    type Bundle,
    BundleError,
    encodeFile,
    openBundle,
    readExactly,
    validateBundle,
    validPath,
    writeBundle,
} from "./bundle.ts";
import { tempDir } from "./test-helpers.ts";

const GENERATION = "0123456789abcdef0123456789abcdef";

function bundle(files: Bundle["files"] = []): Bundle {
    return { version: 1, createdAt: "2026-10-03T00:00:00.000Z", generation: GENERATION, seed: false, files };
}

test("allowed paths", () => {
    for (const ok of ["sessions/state.sql", "cron/jobs.json", "memories/MEMORY.md", "skills/a/b/SKILL.md"]) {
        assert.equal(validPath(ok), true, ok);
    }
    for (const bad of [
        "", "/etc/passwd", "memories", "memories/", "memories/../x", "memories/./x",
        "skills/.git/config", ".git/config", "sessions/other.sql", "cron/other.json",
        "memories//x", "memories/a\\b", "notes/x.md",
    ]) {
        assert.equal(validPath(bad), false, bad);
    }
});

test("a written bundle opens with the same hash", (t) => {
    const path = join(tempDir(t), "bundle.json");
    const hash = writeBundle(path, bundle([encodeFile("memories/MEMORY.md", Buffer.from("hi"), 0o644)]));
    const opened = openBundle(path, 1 << 20);
    assert.equal(opened?.hash, hash);
    assert.equal(opened?.bundle.files[0]?.content, "hi");
});

test("binary content is base64", () => {
    const file = encodeFile("skills/a/b/icon.png", Buffer.from([0xff, 0xfe]), 0o644);
    assert.equal(file.encoding, "base64");
});

test("a missing bundle is null", (t) => {
    assert.equal(openBundle(join(tempDir(t), "none.json"), 1 << 20), null);
});

test("a symlinked bundle is refused", (t) => {
    const dir = tempDir(t);
    writeFileSync(join(dir, "secret"), "{}");
    symlinkSync(join(dir, "secret"), join(dir, "bundle.json"));
    assert.throws(() => openBundle(join(dir, "bundle.json"), 1 << 20), /symbolic link/);
});

test("a FIFO bundle is refused without blocking", (t) => {
    const path = join(tempDir(t), "bundle.json");
    execFileSync("mkfifo", [path]);
    assert.throws(() => openBundle(path, 1 << 20), /not a regular file/);
});

test("an oversized bundle is refused", (t) => {
    const path = join(tempDir(t), "bundle.json");
    writeBundle(path, bundle());
    assert.throws(() => openBundle(path, 10), /over the 10-byte limit/);
});

test("reads stop at the size fstat reported", (t) => {
    const path = join(tempDir(t), "grown");
    writeFileSync(path, "0123456789");
    const fd = openSync(path, "r");
    try {
        assert.equal(readExactly(fd, 4).toString(), "0123");
    } finally {
        closeSync(fd);
    }
});

test("structural violations fail the whole bundle", () => {
    const file = encodeFile("memories/MEMORY.md", Buffer.from("x"), 0o644);
    const cases: [string, unknown][] = [
        ["unknown field", { ...bundle(), extra: 1 }],
        ["bad generation", { ...bundle(), generation: "nope" }],
        ["bad mode", bundle([{ ...file, mode: 0o777 as never }])],
        ["bad encoding", bundle([{ ...file, encoding: "hex" as never }])],
        ["bad base64", bundle([{ ...file, encoding: "base64", content: "@@" }])],
        ["traversal", bundle([{ ...file, path: "memories/../../x" }])],
        ["git path", bundle([{ ...file, path: ".git/config" }])],
        ["duplicate", bundle([file, file])],
        ["file under a file", bundle([file, { ...file, path: "memories/MEMORY.md/x" }])],
        ["seed with files", { ...bundle([file]), seed: true }],
    ];
    for (const [name, value] of cases) {
        assert.throws(() => validateBundle(value), BundleError, name);
    }
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `mise exec -- node --test hermes/src/bundle.test.ts`
Expected: FAIL, module not found.

- [ ] **Step 3: Implement `bundle.ts`**

```ts
import { isUtf8 } from "node:buffer";
import { createHash } from "node:crypto";
import { closeSync, constants, fstatSync, openSync, readFileSync, readSync } from "node:fs";
import { writeFileAtomic } from "./status.ts";
import { errorCode } from "./util.ts";

export type FileMode = 0o644 | 0o755;

export interface BundleFile {
    path: string;
    mode: FileMode;
    encoding: "utf8" | "base64";
    content: string;
}

export interface Bundle {
    version: 1;
    createdAt: string;
    generation: string;
    memorySha?: string;
    bundleHash?: string;
    seed: boolean;
    files: BundleFile[];
}

export class BundleError extends Error {}

const GENERATION = /^[0-9a-f]{32}$/;
const SHA = /^[0-9a-f]{40}(?:[0-9a-f]{24})?$/;
const HASH = /^[0-9a-f]{64}$/;
const BUNDLE_KEYS = new Set(["version", "createdAt", "generation", "memorySha", "bundleHash", "seed", "files"]);
const FILE_KEYS = new Set(["path", "mode", "encoding", "content"]);

function fail(message: string): never {
    throw new BundleError(message);
}

export function validPath(path: string): boolean {
    if (path === "sessions/state.sql" || path === "cron/jobs.json") return true;
    if (path.includes("\\") || path.includes("\0")) return false;
    const parts = path.split("/");
    if (parts.length < 2 || (parts[0] !== "memories" && parts[0] !== "skills")) return false;
    return parts.every((part) => part !== "" && !part.startsWith("."));
}

export function encodeFile(path: string, bytes: Uint8Array, mode: FileMode): BundleFile {
    const buffer = Buffer.from(bytes);
    return isUtf8(buffer)
        ? { path, mode, encoding: "utf8", content: buffer.toString("utf8") }
        : { path, mode, encoding: "base64", content: buffer.toString("base64") };
}

export function fileBytes(file: BundleFile): Buffer {
    return Buffer.from(file.content, file.encoding);
}

export function sha256(bytes: Uint8Array): string {
    return createHash("sha256").update(bytes).digest("hex");
}

export function validateBundle(value: unknown): Bundle {
    if (typeof value !== "object" || value === null || Array.isArray(value)) fail("bundle is not an object");
    const bundle = value as Record<string, unknown>;
    for (const key of Object.keys(bundle)) if (!BUNDLE_KEYS.has(key)) fail(`unknown bundle field ${key}`);
    if (bundle.version !== 1) fail("unsupported bundle version");
    if (typeof bundle.createdAt !== "string" || Number.isNaN(Date.parse(bundle.createdAt))) fail("bad createdAt");
    if (typeof bundle.generation !== "string" || !GENERATION.test(bundle.generation)) fail("bad generation");
    if (bundle.memorySha !== undefined && (typeof bundle.memorySha !== "string" || !SHA.test(bundle.memorySha))) {
        fail("bad memorySha");
    }
    if (bundle.bundleHash !== undefined && (typeof bundle.bundleHash !== "string" || !HASH.test(bundle.bundleHash))) {
        fail("bad bundleHash");
    }
    if (typeof bundle.seed !== "boolean") fail("bad seed");
    if (!Array.isArray(bundle.files)) fail("files is not an array");
    if (bundle.seed && bundle.files.length > 0) fail("a seed bundle carries no files");
    const paths = new Set<string>();
    for (const entry of bundle.files) {
        if (typeof entry !== "object" || entry === null) fail("file entry is not an object");
        const file = entry as Record<string, unknown>;
        for (const key of Object.keys(file)) if (!FILE_KEYS.has(key)) fail(`unknown file field ${key}`);
        if (typeof file.path !== "string" || !validPath(file.path)) fail(`path not allowed: ${String(file.path)}`);
        if (file.mode !== 0o644 && file.mode !== 0o755) fail(`bad mode for ${file.path}`);
        if (file.encoding !== "utf8" && file.encoding !== "base64") fail(`bad encoding for ${file.path}`);
        if (typeof file.content !== "string") fail(`bad content for ${file.path}`);
        if (file.encoding === "base64" && Buffer.from(file.content, "base64").toString("base64") !== file.content) {
            fail(`bad base64 for ${file.path}`);
        }
        if (paths.has(file.path)) fail(`duplicate path ${file.path}`);
        paths.add(file.path);
    }
    for (const path of paths) {
        const parts = path.split("/");
        for (let i = 1; i < parts.length; i++) {
            const parent = parts.slice(0, i).join("/");
            if (paths.has(parent)) fail(`${path} lies under the file ${parent}`);
        }
    }
    return bundle as unknown as Bundle;
}

export function writeBundle(path: string, bundle: Bundle): string {
    const bytes = Buffer.from(JSON.stringify(bundle));
    writeFileAtomic(path, bytes, 0o644);
    return sha256(bytes);
}

/** Reads at most size bytes: the writer may append after fstat. */
export function readExactly(fd: number, size: number): Buffer {
    const buffer = Buffer.alloc(size);
    let offset = 0;
    while (offset < size) {
        const read = readSync(fd, buffer, offset, size - offset, offset);
        if (read === 0) break;
        offset += read;
    }
    return buffer.subarray(0, offset);
}

export interface OpenedBundle {
    bundle: Bundle;
    hash: string;
}

/** Opens agent-written bundle.json without trusting it (S2). */
export function openBundle(path: string, maxBytes: number): OpenedBundle | null {
    let fd: number;
    try {
        fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
    } catch (error) {
        if (errorCode(error) === "ENOENT") return null;
        if (errorCode(error) === "ELOOP") fail(`${path} is a symbolic link`);
        throw error;
    }
    try {
        const stat = fstatSync(fd);
        if (!stat.isFile()) fail(`${path} is not a regular file`);
        if (stat.size > maxBytes) fail(`${path} is ${stat.size} bytes, over the ${maxBytes}-byte limit`);
        const bytes = readExactly(fd, stat.size);
        let parsed: unknown;
        try {
            parsed = JSON.parse(bytes.toString("utf8"));
        } catch {
            fail(`${path} is not valid JSON`);
        }
        return { bundle: validateBundle(parsed), hash: sha256(bytes) };
    } finally {
        closeSync(fd);
    }
}

/** Reads restore.json, which the trusted sidecar wrote. */
export function readTrustedBundle(path: string): Bundle {
    return validateBundle(JSON.parse(readFileSync(path, "utf8")));
}
```

- [ ] **Step 4: Run the tests**

Run: `mise exec -- node --test hermes/src/bundle.test.ts`
Expected: 9 pass.

- [ ] **Step 5: Commit**

```bash
bunx biome check --write hermes/src && bun run typecheck
git add hermes/src/bundle.ts hermes/src/bundle.test.ts
git commit -m "feat: Define and validate the bundle format"
```

---

### Task 8: Safe tree reads and writes

**Files:**

- Create: `hermes/src/files.ts`, `hermes/src/files.test.ts`

**Interfaces:**

- Consumes: `encodeFile`, `fileBytes`, `readExactly`, `BundleFile`,
  `FileMode` (Task 7); `lstatOrNull`, `errorCode` (Task 2).
- Produces:
  `collectFile(root: string, path: string): BundleFile | null`;
  `interface TreeOptions { skipDirectory?(path: string): boolean; includeFile?(path: string): boolean }`;
  `collectTree(root: string, top: string, options?: TreeOptions): BundleFile[]`
  (sorted, dotfiles and non-regular files skipped, links never followed);
  `writeTreeFile(root: string, file: BundleFile): void` (writes aside and
  renames; replaces a link or file standing where a directory belongs);
  `removeUnlisted(root: string, top: string, keep: Set<string>): void`;
  `emptyDirectory(path: string): void`;
  `skillDirectory(path: string): string | null`.

- [ ] **Step 1: Write the failing tests**

`hermes/src/files.test.ts`:

```ts
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { chmodSync, existsSync, lstatSync, mkdirSync, readFileSync, statSync, symlinkSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { encodeFile } from "./bundle.ts";
import { collectFile, collectTree, emptyDirectory, removeUnlisted, skillDirectory, writeTreeFile } from "./files.ts";
import { tempDir, writeFiles } from "./test-helpers.ts";

test("collectTree skips dotfiles, links and special files, sorted", (t) => {
    const root = tempDir(t);
    writeFiles(root, {
        "skills/b/run.sh": "#!/bin/sh\n",
        "skills/a/SKILL.md": "a",
        "skills/.hidden/x": "x",
        "skills/a/.cache": "x",
        "outside/secret": "s",
    });
    chmodSync(join(root, "skills/b/run.sh"), 0o755);
    symlinkSync(join(root, "outside/secret"), join(root, "skills/a/link"));
    symlinkSync(join(root, "outside"), join(root, "skills/linked-dir"));
    execFileSync("mkfifo", [join(root, "skills/a/fifo")]);
    const files = collectTree(root, "skills");
    assert.deepEqual(files.map((f) => [f.path, f.mode]), [
        ["skills/a/SKILL.md", 0o644],
        ["skills/b/run.sh", 0o755],
    ]);
});

test("collectTree honours skipDirectory and includeFile", (t) => {
    const root = tempDir(t);
    writeFiles(root, { "memories/MEMORY.md": "m", "memories/notes.txt": "n", "memories/sub/x.md": "x" });
    const files = collectTree(root, "memories", {
        skipDirectory: () => true,
        includeFile: (path) => path.endsWith(".md"),
    });
    assert.deepEqual(files.map((f) => f.path), ["memories/MEMORY.md"]);
});

test("a symlinked top directory is not followed", (t) => {
    const root = tempDir(t);
    writeFiles(root, { "real/MEMORY.md": "m" });
    symlinkSync(join(root, "real"), join(root, "memories"));
    assert.deepEqual(collectTree(root, "memories"), []);
    assert.equal(collectFile(root, "memories/MEMORY.md"), null);
});

test("writeTreeFile replaces a link where a directory belongs", (t) => {
    const root = tempDir(t);
    const outside = tempDir(t);
    symlinkSync(outside, join(root, "memories"));
    writeTreeFile(root, encodeFile("memories/MEMORY.md", Buffer.from("new"), 0o644));
    assert.equal(lstatSync(join(root, "memories")).isDirectory(), true);
    assert.equal(readFileSync(join(root, "memories/MEMORY.md"), "utf8"), "new");
    assert.equal(existsSync(join(outside, "MEMORY.md")), false);
});

test("writeTreeFile applies the mode and replaces a final link", (t) => {
    const root = tempDir(t);
    const outside = join(tempDir(t), "target");
    writeFiles(root, { "skills/a/placeholder": "" });
    symlinkSync(outside, join(root, "skills/a/run.sh"));
    writeTreeFile(root, encodeFile("skills/a/run.sh", Buffer.from("#!/bin/sh\n"), 0o755));
    assert.equal(statSync(join(root, "skills/a/run.sh")).mode & 0o777, 0o755);
    assert.equal(existsSync(outside), false);
});

test("removeUnlisted deletes the rest and empty directories", (t) => {
    const root = tempDir(t);
    writeFiles(root, { "skills/a/SKILL.md": "a", "skills/b/SKILL.md": "b", "skills/b/.keep": "" });
    mkdirSync(join(root, "skills/empty"));
    removeUnlisted(root, "skills", new Set(["skills/a/SKILL.md"]));
    assert.equal(existsSync(join(root, "skills/a/SKILL.md")), true);
    assert.equal(existsSync(join(root, "skills/b")), false);
    assert.equal(existsSync(join(root, "skills/empty")), false);
});

test("emptyDirectory keeps the directory", (t) => {
    const root = tempDir(t);
    writeFiles(root, { "pairing/a.json": "{}", "pairing/sub/b.json": "{}" });
    emptyDirectory(join(root, "pairing"));
    emptyDirectory(join(root, "missing"));
    assert.deepEqual(execFileSync("ls", ["-A", join(root, "pairing")], { encoding: "utf8" }), "");
});

test("skillDirectory finds the directory a restore replaces", () => {
    assert.equal(skillDirectory("skills/cat/name/SKILL.md"), "skills/cat/name");
    assert.equal(skillDirectory("skills/name/SKILL.md"), "skills/name");
    assert.equal(skillDirectory("skills/cat/name/deep/file.md"), "skills/cat/name");
    assert.equal(skillDirectory("skills/loose.md"), null);
    // A category's own file: replacing the category would delete its bundled skills.
    assert.equal(skillDirectory("skills/cat/DESCRIPTION.md"), null);
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `mise exec -- node --test hermes/src/files.test.ts`
Expected: FAIL, module not found.

- [ ] **Step 3: Implement `files.ts`**

```ts
import { randomBytes } from "node:crypto";
import {
    closeSync,
    constants,
    type Dirent,
    fchmodSync,
    fstatSync,
    mkdirSync,
    openSync,
    readdirSync,
    renameSync,
    rmdirSync,
    rmSync,
    writeFileSync,
} from "node:fs";
import { basename, dirname, join } from "node:path";
import { type BundleFile, encodeFile, type FileMode, fileBytes, readExactly } from "./bundle.ts";
import { errorCode, lstatOrNull } from "./util.ts";

const READ = constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK;
const WRITE = constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW;

function byName(a: Dirent, b: Dirent): number {
    if (a.name < b.name) return -1;
    return a.name > b.name ? 1 : 0;
}

function parentsAreDirectories(root: string, path: string): boolean {
    let dir = root;
    for (const part of path.split("/").slice(0, -1)) {
        dir = join(dir, part);
        if (!lstatOrNull(dir)?.isDirectory()) return false;
    }
    return true;
}

/** Reads root/path, or null when it is missing, a link, or not a regular file. */
export function collectFile(root: string, path: string): BundleFile | null {
    if (!parentsAreDirectories(root, path)) return null;
    let fd: number;
    try {
        fd = openSync(join(root, path), READ);
    } catch (error) {
        const code = errorCode(error);
        if (code === "ENOENT" || code === "ELOOP") return null;
        throw error;
    }
    try {
        const stat = fstatSync(fd);
        if (!stat.isFile()) return null;
        const mode: FileMode = stat.mode & 0o111 ? 0o755 : 0o644;
        return encodeFile(path, readExactly(fd, stat.size), mode);
    } finally {
        closeSync(fd);
    }
}

export interface TreeOptions {
    skipDirectory?(path: string): boolean;
    includeFile?(path: string): boolean;
}

export function collectTree(root: string, top: string, options: TreeOptions = {}): BundleFile[] {
    const files: BundleFile[] = [];
    const walk = (dir: string): void => {
        const entries = readdirSync(join(root, dir), { withFileTypes: true }).sort(byName);
        for (const entry of entries) {
            if (entry.name.startsWith(".")) continue;
            const path = `${dir}/${entry.name}`;
            if (entry.isDirectory()) {
                if (!options.skipDirectory?.(path)) walk(path);
            } else if (entry.isFile() && (options.includeFile?.(path) ?? true)) {
                const file = collectFile(root, path);
                if (file) files.push(file);
            }
        }
    };
    if (lstatOrNull(join(root, top))?.isDirectory()) walk(top);
    return files;
}

/** Writes one bundle file, replacing anything but a directory in its way. */
export function writeTreeFile(root: string, file: BundleFile): void {
    let dir = root;
    for (const part of file.path.split("/").slice(0, -1)) {
        dir = join(dir, part);
        const stat = lstatOrNull(dir);
        if (stat?.isDirectory()) continue;
        if (stat) rmSync(dir, { force: true });
        mkdirSync(dir, { mode: 0o755 });
    }
    const target = join(root, file.path);
    if (lstatOrNull(target)?.isDirectory()) rmSync(target, { recursive: true, force: true });
    // Written aside and renamed over the target (a link is replaced, not
    // followed), so no reader or crash ever sees a half-written file.
    const temp = join(dirname(target), `.${basename(target)}.${randomBytes(4).toString("hex")}.tmp`);
    try {
        const fd = openSync(temp, WRITE, file.mode);
        try {
            writeFileSync(fd, fileBytes(file));
            fchmodSync(fd, file.mode);
        } finally {
            closeSync(fd);
        }
        renameSync(temp, target);
    } catch (error) {
        rmSync(temp, { force: true });
        throw error;
    }
}

/** Deletes everything under root/top that keep does not list; links are removed, not followed. */
export function removeUnlisted(root: string, top: string, keep: Set<string>): void {
    const walk = (dir: string): void => {
        for (const entry of readdirSync(join(root, dir), { withFileTypes: true })) {
            const path = `${dir}/${entry.name}`;
            if (entry.isDirectory()) {
                walk(path);
                if (readdirSync(join(root, path)).length === 0) rmdirSync(join(root, path));
            } else if (!keep.has(path)) {
                rmSync(join(root, path), { force: true });
            }
        }
    };
    const stat = lstatOrNull(join(root, top));
    if (stat === null) return;
    if (!stat.isDirectory()) {
        rmSync(join(root, top), { force: true });
        return;
    }
    walk(top);
}

export function emptyDirectory(path: string): void {
    let names: string[];
    try {
        names = readdirSync(path);
    } catch (error) {
        if (errorCode(error) === "ENOENT") return;
        throw error;
    }
    for (const name of names) rmSync(join(path, name), { recursive: true, force: true });
}

/** `skills/<category>/<name>` (or `skills/<name>`) holding path, or null. */
/**
 * The directory a restored skill file replaces: `skills/<cat>/<name>` or an
 * uncategorised `skills/<name>`. A category's own files (`DESCRIPTION.md`)
 * name none, since the category also holds bundled skills the bundle omits.
 */
export function skillDirectory(path: string): string | null {
    const parts = path.split("/");
    if (parts.length < 3) return null;
    if (parts.length === 3 && parts[2] !== "SKILL.md") return null;
    return parts.slice(0, Math.min(3, parts.length - 1)).join("/");
}
```

- [ ] **Step 4: Run the tests**

Run: `mise exec -- node --test hermes/src/files.test.ts`
Expected: 8 pass.

- [ ] **Step 5: Commit**

```bash
bunx biome check --write hermes/src && bun run typecheck
git add hermes/src/files.ts hermes/src/files.test.ts
git commit -m "feat: Read and write trees without following links"
```

---

### Task 9: The git wrapper

**Files:**

- Create: `hermes/src/git.ts`, `hermes/src/git.test.ts`
- Modify: `hermes/src/test-helpers.ts` (git fixtures)

**Interfaces:**

- Produces: `GIT = "/usr/bin/git"`;
  `class GitError extends Error { output: string; exitCode: number | null }`;
  `interface GitOptions { keyPath?; knownHostsPath?; env?: NodeJS.ProcessEnv; timeoutMs?: number; signal?: AbortSignal }`;
  `sshCommand(keyPath: string, knownHostsPath: string): string`;
  `type PushResult = "pushed" | "rejected" | "failed"`;
  `class Git { readonly dir: string; constructor(dir, options?); run(args, cwd?): Promise<string>; clone(url): Promise<void>; head(): Promise<string | null>; remoteHead(): Promise<string | null>; fetch(): Promise<void>; isAncestor(a, b): Promise<boolean>; resetHard(ref): Promise<void>; unpushed(): Promise<number>; addAll(): Promise<void>; clean(): Promise<void>; stagedPaths(): Promise<string[]>; commit(message): Promise<void>; push(): Promise<PushResult>; setRemote(url): Promise<void> }`.
- Produces (`test-helpers.ts`): `GIT_ENV`; `git(args: string[], cwd: string): string`;
  `bareRepo(t): string` (a `file://` URL); `pushFiles(t, url, files, message?): string`;
  `remoteMain(url): string | null`; `remoteShow(url, path): string | null`.

- [ ] **Step 1: Add the git fixtures to `test-helpers.ts`**

Add imports `execFileSync` from `node:child_process` and `rmSync` (already
present) and append:

```ts
export const GIT_ENV: NodeJS.ProcessEnv = {
    ...process.env,
    GIT_CONFIG_GLOBAL: "/dev/null",
    GIT_CONFIG_NOSYSTEM: "1",
};

const AS_TEST = ["-c", "user.name=Test", "-c", "user.email=test@example.invalid", "-c", "commit.gpgsign=false"];

export function git(args: string[], cwd: string): string {
    return execFileSync("/usr/bin/git", [...AS_TEST, ...args], { cwd, env: GIT_ENV, encoding: "utf8" });
}

export function bareRepo(t: TestContext): string {
    const path = join(tempDir(t), "remote.git");
    git(["init", "--bare", "--quiet", "--initial-branch=main", path], tmpdir());
    return `file://${path}`;
}

/** Commits files on main from a separate clone, as a person would. */
/** Commits files to main and pushes; a null content deletes that file. */
export function pushFiles(
    t: TestContext,
    url: string,
    files: Record<string, string | null>,
    message = "human edit",
): string {
    const work = join(tempDir(t), "work");
    git(["clone", "--quiet", url, work], tmpdir());
    git(["symbolic-ref", "HEAD", "refs/heads/main"], work);
    const written: Record<string, string> = {};
    for (const [path, content] of Object.entries(files)) {
        if (content === null) rmSync(join(work, path), { force: true });
        else written[path] = content;
    }
    writeFiles(work, written);
    git(["add", "--all"], work);
    git(["commit", "--quiet", "-m", message], work);
    git(["push", "--quiet", "origin", "HEAD:refs/heads/main"], work);
    return git(["rev-parse", "HEAD"], work).trim();
}

export function remoteMain(url: string): string | null {
    try {
        return git(["--git-dir", url.slice("file://".length), "rev-parse", "--verify", "--quiet", "main"], tmpdir()).trim();
    } catch {
        return null;
    }
}

export function remoteShow(url: string, path: string): string | null {
    try {
        return git(["--git-dir", url.slice("file://".length), "show", `main:${path}`], tmpdir());
    } catch {
        return null;
    }
}
```

- [ ] **Step 2: Write the failing tests**

`hermes/src/git.test.ts`:

```ts
import assert from "node:assert/strict";
import { renameSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { Git, sshCommand } from "./git.ts";
import { bareRepo, GIT_ENV, git, pushFiles, remoteMain, tempDir, writeFiles } from "./test-helpers.ts";

async function cloned(t: Parameters<typeof tempDir>[0], url: string): Promise<Git> {
    const repo = new Git(join(tempDir(t), "checkout"), { env: GIT_ENV });
    await repo.clone(url);
    return repo;
}

test("an empty remote clones onto an unborn main", async (t) => {
    const repo = await cloned(t, bareRepo(t));
    assert.equal(await repo.head(), null);
    assert.equal(await repo.remoteHead(), null);
    assert.equal(await repo.unpushed(), 0);
    assert.equal(git(["symbolic-ref", "HEAD"], repo.dir).trim(), "refs/heads/main");
});

test("the first push to an empty remote creates main", async (t) => {
    const url = bareRepo(t);
    const repo = await cloned(t, url);
    writeFiles(repo.dir, { "memories/MEMORY.md": "m" });
    await repo.addAll();
    assert.deepEqual(await repo.stagedPaths(), ["memories/MEMORY.md"]);
    await repo.commit("chore(sync): Snapshot from test\n\nChanged: memories.");
    assert.equal(await repo.unpushed(), 1);
    assert.equal(await repo.push(), "pushed");
    assert.equal(remoteMain(url), await repo.head());
    assert.equal(git(["log", "-1", "--format=%an <%ae>"], repo.dir).trim(), "Dorothy <noreply@dorothy.invalid>");
});

test("a non-fast-forward push is rejected, never forced", async (t) => {
    const url = bareRepo(t);
    pushFiles(t, url, { "a.txt": "1" });
    const repo = await cloned(t, url);
    const human = pushFiles(t, url, { "b.txt": "2" });
    writeFiles(repo.dir, { "c.txt": "3" });
    await repo.addAll();
    await repo.commit("local");
    assert.equal(await repo.push(), "rejected");
    assert.equal(remoteMain(url), human);
});

test("an unreachable remote fails the push and the fetch", async (t) => {
    const url = bareRepo(t);
    const repo = await cloned(t, url);
    renameSync(url.slice("file://".length), `${url.slice("file://".length)}.gone`);
    writeFiles(repo.dir, { "a.txt": "1" });
    await repo.addAll();
    await repo.commit("local");
    assert.equal(await repo.push(), "failed");
    await assert.rejects(repo.fetch());
});

test("isAncestor and resetHard fast-forward", async (t) => {
    const url = bareRepo(t);
    const first = pushFiles(t, url, { "a.txt": "1" });
    const repo = await cloned(t, url);
    const second = pushFiles(t, url, { "b.txt": "2" });
    await repo.fetch();
    assert.equal(await repo.isAncestor(first, second), true);
    assert.equal(await repo.isAncestor(second, first), false);
    await repo.resetHard(second);
    assert.equal(await repo.head(), second);
});

test("an unborn branch fast-forwards with resetHard", async (t) => {
    const url = bareRepo(t);
    const repo = await cloned(t, url);
    const sha = pushFiles(t, url, { "a.txt": "1" });
    await repo.fetch();
    await repo.resetHard("refs/remotes/origin/main");
    assert.equal(await repo.head(), sha);
});

test("the ssh command matches the spec", () => {
    assert.equal(
        sshCommand("/tmp/dorothy/memory.key", "/opt/dorothy/known_hosts"),
        "/usr/bin/ssh -F none -i /tmp/dorothy/memory.key -o IdentitiesOnly=yes " +
            "-o UserKnownHostsFile=/opt/dorothy/known_hosts -o StrictHostKeyChecking=yes " +
            "-o ConnectTimeout=30 -o ServerAliveInterval=15 -o ServerAliveCountMax=4",
    );
});
```

- [ ] **Step 3: Run to verify it fails**

Run: `mise exec -- node --test hermes/src/git.test.ts`
Expected: FAIL, module not found.

- [ ] **Step 4: Implement `git.ts`**

```ts
import { execFile } from "node:child_process";
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";

export const GIT = "/usr/bin/git";

export class GitError extends Error {
    readonly output: string;
    readonly exitCode: number | null;

    constructor(message: string, output: string, exitCode: number | null) {
        super(message);
        this.output = output;
        this.exitCode = exitCode;
    }
}

export interface GitOptions {
    keyPath?: string;
    knownHostsPath?: string;
    /** Base environment; defaults to process.env. */
    env?: NodeJS.ProcessEnv;
    /**
     * None by default: a clone of a long history may take as long as it
     * takes, and a stalled connection is cut by ssh's keepalives instead.
     */
    timeoutMs?: number;
    /** Aborting sends SIGTERM to the running git, as the service stops. */
    signal?: AbortSignal;
}

export type PushResult = "pushed" | "rejected" | "failed";

const REJECTED = /\[rejected\]|\[remote rejected\]|non-fast-forward|fetch first/;
const DOROTHY = ["-c", "user.name=Dorothy", "-c", "user.email=noreply@dorothy.invalid", "-c", "commit.gpgsign=false"];

export function sshCommand(keyPath: string, knownHostsPath: string): string {
    return (
        `/usr/bin/ssh -F none -i ${keyPath} -o IdentitiesOnly=yes ` +
        `-o UserKnownHostsFile=${knownHostsPath} -o StrictHostKeyChecking=yes ` +
        "-o ConnectTimeout=30 -o ServerAliveInterval=15 -o ServerAliveCountMax=4"
    );
}

function verb(args: string[]): string {
    return args.find((arg, i) => !arg.startsWith("-") && args[i - 1] !== "-c") ?? "command";
}

export class Git {
    readonly dir: string;
    readonly #options: GitOptions;

    constructor(dir: string, options: GitOptions = {}) {
        this.dir = dir;
        this.#options = options;
    }

    run(args: string[], cwd = this.dir): Promise<string> {
        const env: NodeJS.ProcessEnv = {
            ...(this.#options.env ?? process.env),
            GIT_TERMINAL_PROMPT: "0",
            LC_ALL: "C",
        };
        if (this.#options.keyPath) {
            env.GIT_SSH_COMMAND = sshCommand(
                this.#options.keyPath,
                this.#options.knownHostsPath ?? "/opt/dorothy/known_hosts",
            );
        }
        const options = {
            cwd,
            env,
            maxBuffer: 256 * 1024 * 1024,
            timeout: this.#options.timeoutMs ?? 0,
            signal: this.#options.signal,
        };
        return new Promise((resolve, reject) => {
            execFile(GIT, args, options, (error, stdout, stderr) => {
                if (!error) {
                    resolve(stdout);
                    return;
                }
                const code = typeof error.code === "number" ? error.code : null;
                const detail = stderr.trim() || error.message;
                reject(new GitError(`git ${verb(args)} failed: ${detail}`, `${stdout}${stderr}`, code));
            });
        });
    }

    async clone(url: string): Promise<void> {
        mkdirSync(dirname(this.dir), { recursive: true });
        await this.run(["clone", "--quiet", "--origin", "origin", "--", url, this.dir], dirname(this.dir));
        if ((await this.head()) === null) await this.run(["symbolic-ref", "HEAD", "refs/heads/main"]);
    }

    head(): Promise<string | null> {
        return this.#verify("HEAD");
    }

    remoteHead(): Promise<string | null> {
        return this.#verify("refs/remotes/origin/main");
    }

    async #verify(ref: string): Promise<string | null> {
        try {
            return (await this.run(["rev-parse", "--verify", "--quiet", `${ref}^{commit}`])).trim();
        } catch (error) {
            if (error instanceof GitError && error.exitCode === 1) return null;
            throw error;
        }
    }

    async fetch(): Promise<void> {
        await this.run(["fetch", "--quiet", "--prune", "origin"]);
    }

    async isAncestor(ancestor: string, descendant: string): Promise<boolean> {
        try {
            await this.run(["merge-base", "--is-ancestor", ancestor, descendant]);
            return true;
        } catch (error) {
            if (error instanceof GitError && error.exitCode === 1) return false;
            throw error;
        }
    }

    async resetHard(ref: string): Promise<void> {
        await this.run(["reset", "--hard", "--quiet", ref]);
    }

    /** Commits on HEAD that origin/main lacks. */
    async unpushed(): Promise<number> {
        if ((await this.head()) === null) return 0;
        const remote = await this.remoteHead();
        const out = await this.run(["rev-list", "--count", remote ? `${remote}..HEAD` : "HEAD"]);
        return Number(out.trim());
    }

    async addAll(): Promise<void> {
        await this.run(["add", "--all"]);
    }

    /** Removes every untracked file, ignored ones included. */
    async clean(): Promise<void> {
        await this.run(["clean", "-f", "-f", "-d", "-x", "--quiet"]);
    }

    async stagedPaths(): Promise<string[]> {
        const out = await this.run(["diff", "--cached", "--name-only", "-z"]);
        return out.split("\u0000").filter(Boolean);
    }

    async commit(message: string): Promise<void> {
        await this.run([...DOROTHY, "commit", "--quiet", "--no-verify", "-m", message]);
    }

    /** Fast-forward only: git refuses a non-fast-forward without --force. */
    async push(): Promise<PushResult> {
        try {
            await this.run(["push", "--porcelain", "origin", "HEAD:refs/heads/main"]);
            return "pushed";
        } catch (error) {
            if (!(error instanceof GitError)) throw error;
            return REJECTED.test(error.output) ? "rejected" : "failed";
        }
    }

    async setRemote(url: string): Promise<void> {
        await this.run(["remote", "set-url", "origin", url]);
    }
}
```

- [ ] **Step 5: Run the tests**

Run: `mise exec -- node --test hermes/src/git.test.ts`
Expected: 7 pass.

- [ ] **Step 6: Commit**

```bash
bunx biome check --write hermes/src && bun run typecheck
git add hermes/src/git.ts hermes/src/git.test.ts hermes/src/test-helpers.ts
git commit -m "feat: Wrap git with fast-forward-only pushes"
```

---

### Task 10: The Hermes CLI and container paths

**Files:**

- Create: `hermes/src/hermes.ts`, `hermes/src/hermes.test.ts`
- Modify: `hermes/src/test-helpers.ts` (`fakeHermes`)

**Interfaces:**

- Produces: `interface GatewayStatus { up: boolean; pid: number | null }`;
  `interface HermesCli { snapshot(label: string): Promise<string>; deleteSnapshot(dir: string): Promise<void>; restartGateway(): Promise<void>; startGateway(): Promise<void>; gatewayStatus(): Promise<GatewayStatus | null>; optimizeStorage(): Promise<string> }`
  (`optimizeStorage` returns its output)
  (`gatewayStatus` is null while the slot is unregistered);
  `interface CliPaths { home; bin; svstat; slot }`; `IMAGE_CLI_PATHS`;
  `interface ContainerPaths { home; run; restore; syncStatus; outbox; knownHosts }`;
  `IMAGE_CONTAINER_PATHS`; `parseSvstat(output: string): GatewayStatus`;
  `newSnapshot(before: Set<string>, after: Iterable<string>, label: string): string`;
  `createHermesCli(paths?: CliPaths, signal?: AbortSignal): HermesCli`.
- Produces (`test-helpers.ts`):
  `interface FakeHermesOptions { status?(): GatewayStatus | null; snapshot?(label: string): Promise<string>; restart?(): void; start?(): void }`;
  `interface FakeHermes extends HermesCli { calls: string[] }`;
  `fakeHermes(options?: FakeHermesOptions): FakeHermes`.

- [ ] **Step 1: Add `fakeHermes` to `test-helpers.ts`**

Add `import type { GatewayStatus, HermesCli } from "./hermes.ts";` and append:

```ts
export interface FakeHermesOptions {
    status?(): GatewayStatus | null;
    snapshot?(label: string): Promise<string>;
    restart?(): void;
    start?(): void;
}

export interface FakeHermes extends HermesCli {
    calls: string[];
}

export function fakeHermes(options: FakeHermesOptions = {}): FakeHermes {
    const calls: string[] = [];
    return {
        calls,
        async snapshot(label) {
            calls.push(`snapshot ${label}`);
            if (!options.snapshot) throw new Error("no fake snapshot");
            return options.snapshot(label);
        },
        async deleteSnapshot(dir) {
            calls.push("deleteSnapshot");
            rmSync(dir, { recursive: true, force: true });
        },
        async restartGateway() {
            calls.push("restart");
            options.restart?.();
        },
        async startGateway() {
            calls.push("start");
            options.start?.();
        },
        async gatewayStatus() {
            return options.status ? options.status() : { up: true, pid: 100 };
        },
        async optimizeStorage() {
            calls.push("optimize");
            return "";
        },
    };
}
```

- [ ] **Step 2: Write the failing tests**

`hermes/src/hermes.test.ts`:

```ts
import assert from "node:assert/strict";
import { chmodSync, existsSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { createHermesCli, newSnapshot, parseSvstat } from "./hermes.ts";
import { tempDir } from "./test-helpers.ts";

test("s6-svstat output parses", () => {
    assert.deepEqual(parseSvstat("true 4321\n"), { up: true, pid: 4321 });
    assert.deepEqual(parseSvstat("false -1\n"), { up: false, pid: null });
});

test("the new snapshot is found, suffix or not", () => {
    const before = new Set(["20261003-000000-dorothy-sync"]);
    assert.equal(
        newSnapshot(before, [...before, "20261003-000000-dorothy-sync-2", "20261003-000001-other"], "dorothy-sync"),
        "20261003-000000-dorothy-sync-2",
    );
    assert.equal(newSnapshot(new Set(), ["20261003-000002-dorothy-sync"], "dorothy-sync"), "20261003-000002-dorothy-sync");
    assert.throws(() => newSnapshot(before, before, "dorothy-sync"), /found 0/);
    assert.throws(
        () => newSnapshot(new Set(), ["1-dorothy-sync", "2-dorothy-sync"], "dorothy-sync"),
        /found 2/,
    );
});

test("the real CLI drives the binaries it is given", async (t) => {
    const home = tempDir(t);
    const bin = join(home, "fake-hermes");
    writeFileSync(
        bin,
        `#!/bin/sh\nif [ "$1" = backup ]; then mkdir -p "${home}/state-snapshots/20261003-000000-$4"; fi\n`,
    );
    const svstat = join(home, "fake-svstat");
    writeFileSync(svstat, "#!/bin/sh\necho 'true 77'\n");
    chmodSync(bin, 0o755);
    chmodSync(svstat, 0o755);
    mkdirSync(join(home, "state-snapshots"));
    const cli = createHermesCli({ home, bin, svstat, slot: "/run/service/gateway-default" });
    const dir = await cli.snapshot("dorothy-sync");
    assert.equal(dir, join(home, "state-snapshots/20261003-000000-dorothy-sync"));
    assert.deepEqual(await cli.gatewayStatus(), { up: true, pid: 77 });
    await cli.deleteSnapshot(dir);
    assert.equal(existsSync(dir), false);
    await assert.rejects(cli.deleteSnapshot(home), /not a snapshot/);
});
```

- [ ] **Step 3: Run to verify it fails**

Run: `mise exec -- node --test hermes/src/hermes.test.ts`
Expected: FAIL, module not found.

- [ ] **Step 4: Implement `hermes.ts`**

```ts
import { execFile } from "node:child_process";
import { readdirSync, rmSync } from "node:fs";
import { basename, dirname, join } from "node:path";

export interface GatewayStatus {
    up: boolean;
    pid: number | null;
}

export interface HermesCli {
    /** `hermes backup --quick --label <label>`; returns the snapshot directory. */
    snapshot(label: string): Promise<string>;
    deleteSnapshot(dir: string): Promise<void>;
    restartGateway(): Promise<void>;
    startGateway(): Promise<void>;
    /** Null while the gateway-default slot is not registered. */
    gatewayStatus(): Promise<GatewayStatus | null>;
    /** Returns the command's output: it exits 0 even when it skips the work. */
    optimizeStorage(): Promise<string>;
}

export interface CliPaths {
    home: string;
    bin: string;
    svstat: string;
    slot: string;
}

export const IMAGE_CLI_PATHS: CliPaths = {
    home: "/opt/data",
    bin: "/opt/hermes/bin/hermes",
    svstat: "/command/s6-svstat",
    slot: "/run/service/gateway-default",
};

/** Where things live inside the `hermes` container. */
export interface ContainerPaths {
    home: string;
    run: string;
    restore: string;
    syncStatus: string;
    outbox: string;
    knownHosts: string;
}

export const IMAGE_CONTAINER_PATHS: ContainerPaths = {
    home: "/opt/data",
    run: "/run/dorothy",
    restore: "/var/lib/dorothy/restore/restore.json",
    syncStatus: "/var/lib/dorothy/restore/status.json",
    outbox: "/var/lib/dorothy/outbox/bundle.json",
    knownHosts: "/opt/dorothy/known_hosts",
};

export function parseSvstat(output: string): GatewayStatus {
    const [up, pid] = output.trim().split(/\s+/);
    const number = Number(pid);
    return up === "true" && number > 0 ? { up: true, pid: number } : { up: false, pid: null };
}

export function newSnapshot(before: Set<string>, after: Iterable<string>, label: string): string {
    const escaped = label.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    const pattern = new RegExp(`-${escaped}(-\\d+)?$`);
    const created = [...after].filter((name) => !before.has(name) && pattern.test(name));
    if (created.length !== 1) {
        throw new Error(`expected one new snapshot labelled ${label}, found ${created.length}`);
    }
    return created[0] as string;
}

function run(file: string, args: string[], signal?: AbortSignal): Promise<string> {
    return new Promise((resolve, reject) => {
        execFile(file, args, { signal, maxBuffer: 64 * 1024 * 1024 }, (error, stdout, stderr) => {
            if (error) {
                reject(new Error(`${basename(file)} ${args.join(" ")} failed: ${stderr.trim() || error.message}`));
            } else {
                resolve(stdout);
            }
        });
    });
}

export function createHermesCli(paths: CliPaths = IMAGE_CLI_PATHS, signal?: AbortSignal): HermesCli {
    const snapshots = join(paths.home, "state-snapshots");
    const list = (): Set<string> => {
        try {
            return new Set(readdirSync(snapshots));
        } catch {
            return new Set();
        }
    };
    return {
        async snapshot(label) {
            const before = list();
            await run(paths.bin, ["backup", "--quick", "--label", label], signal);
            return join(snapshots, newSnapshot(before, list(), label));
        },
        async deleteSnapshot(dir) {
            if (dirname(dir) !== snapshots) throw new Error(`${dir} is not a snapshot`);
            rmSync(dir, { recursive: true, force: true });
        },
        async restartGateway() {
            await run(paths.bin, ["gateway", "restart"], signal);
        },
        async startGateway() {
            await run(paths.bin, ["gateway", "start"], signal);
        },
        async gatewayStatus() {
            try {
                return parseSvstat(await run(paths.svstat, ["-o", "up,pid", paths.slot]));
            } catch {
                return null;
            }
        },
        async optimizeStorage() {
            return run(paths.bin, ["sessions", "optimize-storage", "--yes"], signal);
        },
    };
}
```

- [ ] **Step 5: Run the tests**

Run: `mise exec -- node --test hermes/src/hermes.test.ts`
Expected: 3 pass.

- [ ] **Step 6: Commit**

```bash
bunx biome check --write hermes/src && bun run typecheck
git add hermes/src/hermes.ts hermes/src/hermes.test.ts hermes/src/test-helpers.ts
git commit -m "feat: Wrap the Hermes CLI and s6 status"
```

---

### Task 11: Config apply, gateway test and rollback

**Files:**

- Create: `hermes/src/config.ts`, `hermes/src/config.test.ts`

**Interfaces:**

- Consumes: `Git` (Task 9); `HermesCli`, `GatewayStatus`, `ContainerPaths`
  (Task 10); `readJson`, `writeJson`, `writeFileAtomic`, `ApplyStatus`
  (Task 3); `Clock`, `Log`, `iso`, `errorMessage`, `lstatOrNull` (Task 2).
- Produces: `CONFIG_FILES`; `SKILLS_DIR = "/opt/data/dorothy/config/skills"`;
  `interface ConfigPaths { home; checkout; lastGood; applyStatus }`;
  `configPaths(home?: string): ConfigPaths`;
  `configGit(paths: ContainerPaths, env?: NodeJS.ProcessEnv, signal?: AbortSignal): Git`;
  `copyConfig(from: string, to: string): void` (reads both files, then
  writes); `sameConfig(a: string, b: string): boolean`;
  `hasLastGood(paths: ConfigPaths): boolean`;
  `skillsWarning(configYaml: string): string | null`;
  `interface GatewayTestTiming { drainWithinMs; upWithinMs; stableForMs; pollMs }`;
  `GATEWAY_TEST`;
  `interface ApplyDeps extends Clock { git: Git; hermes: HermesCli; paths: ConfigPaths; log: Log; timing?: GatewayTestTiming }`;
  `type ApplyOutcome = "unchanged" | "applied" | "rolled-back" | "failed"`;
  `gatewayTest(deps: ApplyDeps, previousPid: number | null): Promise<boolean>`;
  `applyConfig(deps: ApplyDeps): Promise<ApplyOutcome>`;
  `bootCheck(deps: ApplyDeps, registerWithinMs?: number): Promise<ApplyOutcome>`.

- [ ] **Step 1: Write the failing tests**

`hermes/src/config.test.ts`:

```ts
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { type TestContext, test } from "node:test";
import { type ApplyDeps, applyConfig, bootCheck, configPaths, copyConfig, skillsWarning } from "./config.ts";
import { Git } from "./git.ts";
import type { GatewayStatus } from "./hermes.ts";
import { type ApplyStatus, readJson } from "./status.ts";
import { bareRepo, fakeClock, fakeHermes, GIT_ENV, pushFiles, tempDir } from "./test-helpers.ts";

const GOOD = "skills:\n    external_dirs:\n        - /opt/data/dorothy/config/skills\n";
const BROKEN = `${GOOD}# broken\n`;

/**
 * A gateway that is down while config.yaml says "broken", with a new pid per
 * restart. After a restart the old pid stays up for lingerMs (draining), then
 * the new one takes startDelayMs to come up.
 */
function fakeGateway(home: string, clock: { now(): number }, startDelayMs = 0, lingerMs = 0) {
    let pid = 100;
    let since = Number.NEGATIVE_INFINITY;
    return {
        restart() {
            pid += 1;
            since = clock.now();
        },
        status(): GatewayStatus {
            if (clock.now() - since < lingerMs) return { up: true, pid: pid - 1 };
            if (readFileSync(join(home, "config.yaml"), "utf8").includes("broken")) return { up: false, pid: null };
            if (clock.now() - since < lingerMs + startDelayMs) return { up: false, pid: null };
            return { up: true, pid };
        },
    };
}

async function setup(t: TestContext, startDelayMs = 0, lingerMs = 0) {
    const url = bareRepo(t);
    const first = pushFiles(t, url, { "SOUL.md": "soul 1", "config.yaml": GOOD });
    const paths = configPaths(join(tempDir(t), "data"));
    const git = new Git(paths.checkout, { env: GIT_ENV });
    await git.clone(url);
    copyConfig(paths.checkout, paths.home);
    const clock = fakeClock();
    const gateway = fakeGateway(paths.home, clock, startDelayMs, lingerMs);
    const hermes = fakeHermes({ status: gateway.status, restart: gateway.restart });
    const logs: string[] = [];
    const deps: ApplyDeps = { ...clock, git, hermes, paths, log: (m) => logs.push(m) };
    return { url, first, paths, deps, hermes, logs };
}

const status = (path: string) => readJson<ApplyStatus>(path) ?? {};

test("a good push is applied and becomes last-good", async (t) => {
    const { url, paths, deps, hermes } = await setup(t);
    const sha = pushFiles(t, url, { "SOUL.md": "soul 2" });
    assert.equal(await applyConfig(deps), "applied");
    assert.equal(readFileSync(join(paths.home, "SOUL.md"), "utf8"), "soul 2");
    assert.equal(readFileSync(join(paths.lastGood, "SOUL.md"), "utf8"), "soul 2");
    assert.equal(status(paths.applyStatus).appliedSha, sha);
    assert.deepEqual(hermes.calls, ["restart", "start"]);
});

test("an applied or rolled-back SHA is not applied again", async (t) => {
    const { url, deps, hermes } = await setup(t);
    pushFiles(t, url, { "SOUL.md": "soul 2" });
    await applyConfig(deps);
    assert.equal(await applyConfig(deps), "unchanged");
    pushFiles(t, url, { "config.yaml": BROKEN });
    assert.equal(await applyConfig(deps), "rolled-back");
    hermes.calls.length = 0;
    assert.equal(await applyConfig(deps), "unchanged");
    assert.deepEqual(hermes.calls, []);
});

test("a config that stops the gateway is rolled back and recorded", async (t) => {
    const { url, paths, deps } = await setup(t);
    pushFiles(t, url, { "SOUL.md": "soul 2" });
    await applyConfig(deps);
    const bad = pushFiles(t, url, { "config.yaml": BROKEN });
    assert.equal(await applyConfig(deps), "rolled-back");
    assert.equal(readFileSync(join(paths.home, "config.yaml"), "utf8"), GOOD);
    const recorded = status(paths.applyStatus);
    assert.equal(recorded.rolledBackSha, bad);
    assert.equal(recorded.configRolledBack, true);
    assert.match(recorded.lastError ?? "", /rolled back/);
});

test("without a different last-good copy the failure is recorded", async (t) => {
    const { url, paths, deps } = await setup(t);
    const bad = pushFiles(t, url, { "config.yaml": BROKEN });
    assert.equal(await applyConfig(deps), "failed");
    assert.equal(status(paths.applyStatus).rolledBackSha, bad);
});

test("a crash-looping gateway fails the test", async (t) => {
    const { url, deps } = await setup(t);
    let pid = 500;
    const looping = fakeHermes({ status: () => ({ up: true, pid: pid++ }) });
    pushFiles(t, url, { "SOUL.md": "soul 2" });
    assert.equal(await applyConfig({ ...deps, hermes: looping }), "failed");
    // No last-good copy exists yet, so there is no second bounce.
    assert.deepEqual(looping.calls, ["restart", "start"]);
});

test("a slow but healthy restart is not rolled back", async (t) => {
    const { url, deps } = await setup(t, 25_000);
    pushFiles(t, url, { "SOUL.md": "soul 2" });
    assert.equal(await applyConfig(deps), "applied");
});

test("an old gateway draining a cron job is waited out", async (t) => {
    const { url, deps } = await setup(t, 5_000, 28_000);
    pushFiles(t, url, { "SOUL.md": "soul 2" });
    assert.equal(await applyConfig(deps), "applied");
});

test("the pid that was up before the restart does not count", async (t) => {
    const { url, deps } = await setup(t);
    pushFiles(t, url, { "SOUL.md": "soul 2" });
    const stale = fakeHermes({ status: () => ({ up: true, pid: 100 }) });
    assert.equal(await applyConfig({ ...deps, hermes: stale }), "failed");
});

test("a slot that stopped itself is started again", async (t) => {
    const { url, deps, paths } = await setup(t);
    let stopped = true;
    const hermes = fakeHermes({
        status: () => (stopped ? { up: false, pid: null } : { up: true, pid: 300 }),
        restart: () => {
            throw new Error("slot is down");
        },
        start: () => {
            stopped = false;
        },
    });
    const sha = pushFiles(t, url, { "SOUL.md": "soul 2" });
    assert.equal(await applyConfig({ ...deps, hermes }), "applied");
    assert.equal(status(paths.applyStatus).appliedSha, sha);
});

test("the boot check records a working config as last-good", async (t) => {
    const { first, paths, deps } = await setup(t);
    assert.equal(await bootCheck(deps), "applied");
    assert.equal(status(paths.applyStatus).appliedSha, first);
    assert.equal(readFileSync(join(paths.lastGood, "config.yaml"), "utf8"), GOOD);
});

test("the boot check rolls back a broken config to last-good", async (t) => {
    const { url, paths, deps } = await setup(t);
    await bootCheck(deps);
    const bad = pushFiles(t, url, { "config.yaml": BROKEN });
    await deps.git.fetch();
    await deps.git.resetHard(bad);
    copyConfig(paths.checkout, paths.home);
    assert.equal(await bootCheck(deps), "rolled-back");
    assert.equal(status(paths.applyStatus).rolledBackSha, bad);
    assert.equal(readFileSync(join(paths.home, "config.yaml"), "utf8"), GOOD);
});

test("a push deleting config.yaml leaves the running config alone", async (t) => {
    const { url, paths, deps, hermes } = await setup(t);
    const bad = pushFiles(t, url, { "SOUL.md": "soul 2", "config.yaml": null });
    assert.equal(await applyConfig(deps), "failed");
    assert.equal(readFileSync(join(paths.home, "SOUL.md"), "utf8"), "soul 1");
    const recorded = status(paths.applyStatus);
    assert.equal(recorded.rolledBackSha, bad);
    assert.match(recorded.lastError ?? "", /config\.yaml is missing/);
    assert.deepEqual(hermes.calls, []);
    assert.equal(await applyConfig(deps), "unchanged");
});

test("missing config files are named", async (t) => {
    const dir = tempDir(t);
    assert.throws(() => copyConfig(dir, join(dir, "out")), /SOUL\.md is missing/);
});

test("the external_dirs warning", () => {
    assert.equal(skillsWarning(GOOD), null);
    assert.match(skillsWarning("model: x\n") ?? "", /skills\.external_dirs/);
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `mise exec -- node --test hermes/src/config.test.ts`
Expected: FAIL, module not found.

- [ ] **Step 3: Implement `config.ts`**

```ts
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { Git } from "./git.ts";
import type { ContainerPaths, HermesCli } from "./hermes.ts";
import { type ApplyStatus, readJson, writeFileAtomic, writeJson } from "./status.ts";
import { type Clock, errorMessage, iso, type Log, lstatOrNull } from "./util.ts";

export const CONFIG_FILES = ["SOUL.md", "config.yaml"] as const;
export const SKILLS_DIR = "/opt/data/dorothy/config/skills";

export interface ConfigPaths {
    home: string;
    checkout: string;
    lastGood: string;
    applyStatus: string;
}

export function configPaths(home = "/opt/data"): ConfigPaths {
    return {
        home,
        checkout: join(home, "dorothy/config"),
        lastGood: join(home, "dorothy/last-good"),
        applyStatus: join(home, "dorothy/status/apply.json"),
    };
}

export function configGit(paths: ContainerPaths, env?: NodeJS.ProcessEnv, signal?: AbortSignal): Git {
    return new Git(configPaths(paths.home).checkout, {
        keyPath: join(paths.run, "config.key"),
        knownHostsPath: paths.knownHosts,
        env,
        signal,
    });
}

function readRegular(path: string): Buffer | null {
    const stat = lstatOrNull(path);
    if (stat === null) return null;
    if (!stat.isFile()) throw new Error(`${path} is not a regular file`);
    return readFileSync(path);
}

/**
 * Copies, never links: upstream refuses symlinked config paths. Both files
 * are read before either is written, so a missing one changes nothing.
 */
export function copyConfig(from: string, to: string): void {
    const files = CONFIG_FILES.map((name) => {
        const data = readRegular(join(from, name));
        if (data === null) throw new Error(`${name} is missing from ${from}`);
        return [name, data] as const;
    });
    for (const [name, data] of files) writeFileAtomic(join(to, name), data, 0o600);
}

export function sameConfig(a: string, b: string): boolean {
    return CONFIG_FILES.every((name) => {
        const left = readRegular(join(a, name));
        const right = readRegular(join(b, name));
        return left !== null && right !== null && left.equals(right);
    });
}

export function hasLastGood(paths: ConfigPaths): boolean {
    return CONFIG_FILES.every((name) => lstatOrNull(join(paths.lastGood, name))?.isFile());
}

export function skillsWarning(configYaml: string): string | null {
    if (configYaml.includes(SKILLS_DIR)) return null;
    return `config.yaml does not list ${SKILLS_DIR} in skills.external_dirs; hand-written skills will not load`;
}

export interface GatewayTestTiming {
    /** How long the old process may take to exit (upstream drains cron jobs first). */
    drainWithinMs: number;
    upWithinMs: number;
    stableForMs: number;
    pollMs: number;
}

export const GATEWAY_TEST: GatewayTestTiming = {
    drainWithinMs: 90_000,
    upWithinMs: 30_000,
    stableForMs: 10_000,
    pollMs: 1_000,
};

export interface ApplyDeps extends Clock {
    git: Git;
    hermes: HermesCli;
    paths: ConfigPaths;
    log: Log;
    timing?: GatewayTestTiming;
}

export type ApplyOutcome = "unchanged" | "applied" | "rolled-back" | "failed";

/**
 * Once previousPid has gone (within 90 s): up within 30 s under another pid,
 * and the same pid 10 s later. The 30 s start only when the old process has
 * exited, so a restart that waits for a cron job is not judged early.
 */
export async function gatewayTest(deps: ApplyDeps, previousPid: number | null): Promise<boolean> {
    const timing = deps.timing ?? GATEWAY_TEST;
    if (previousPid !== null) {
        const drained = deps.now() + timing.drainWithinMs;
        while (deps.now() < drained) {
            const status = await deps.hermes.gatewayStatus();
            if (!status?.up || status.pid !== previousPid) break;
            await deps.sleep(timing.pollMs);
        }
    }
    const deadline = deps.now() + timing.upWithinMs;
    let pid: number | null = null;
    while (deps.now() < deadline) {
        const status = await deps.hermes.gatewayStatus();
        if (status?.up && status.pid !== null && status.pid !== previousPid) {
            pid = status.pid;
            break;
        }
        await deps.sleep(timing.pollMs);
    }
    if (pid === null) return false;
    await deps.sleep(timing.stableForMs);
    const later = await deps.hermes.gatewayStatus();
    return later?.up === true && later.pid === pid;
}

/** Restart, then start: a slot that stopped itself (exit 78 or 0) ignores restart. */
async function bounce(deps: ApplyDeps): Promise<number | null> {
    const before = (await deps.hermes.gatewayStatus())?.pid ?? null;
    try {
        await deps.hermes.restartGateway();
    } catch (error) {
        deps.log(`gateway restart: ${errorMessage(error)}`);
    }
    try {
        await deps.hermes.startGateway();
    } catch (error) {
        deps.log(`gateway start: ${errorMessage(error)}`);
    }
    return before;
}

function warnAboutSkills(deps: ApplyDeps): void {
    const warning = skillsWarning(readFileSync(join(deps.paths.home, "config.yaml"), "utf8"));
    if (warning) deps.log(warning);
}

function passed(deps: ApplyDeps, status: ApplyStatus, sha: string | null): void {
    copyConfig(deps.paths.home, deps.paths.lastGood);
    const lastApplyAt = iso(deps.now());
    // A rolled-back head that still boots keeps its record: the operator
    // must push a fix, and health stays unhealthy until then.
    const next: ApplyStatus =
        sha !== null && sha !== status.rolledBackSha
            ? { appliedSha: sha, configRolledBack: false, lastApplyAt }
            : { ...status, lastApplyAt };
    writeJson(deps.paths.applyStatus, next);
}

async function rollBack(deps: ApplyDeps, status: ApplyStatus, badSha: string): Promise<ApplyOutcome> {
    const record = (lastError: string): void =>
        writeJson(deps.paths.applyStatus, {
            ...status,
            rolledBackSha: badSha,
            configRolledBack: true,
            lastApplyAt: iso(deps.now()),
            lastError,
        });
    if (!hasLastGood(deps.paths) || sameConfig(deps.paths.lastGood, deps.paths.home)) {
        record(`gateway test failed for ${badSha} and no different last-good config exists`);
        deps.log(`config ${badSha} failed the gateway test; nothing to roll back to`);
        return "failed";
    }
    copyConfig(deps.paths.lastGood, deps.paths.home);
    const recovered = await gatewayTest(deps, await bounce(deps));
    record(recovered ? `rolled back ${badSha}` : `rolled back ${badSha}, but the gateway is still down`);
    deps.log(`config ${badSha} failed the gateway test and was rolled back`);
    return "rolled-back";
}

/** The webhook's apply; until plan 3, run only by the snapshot loop's fallback. */
export async function applyConfig(deps: ApplyDeps): Promise<ApplyOutcome> {
    const status = readJson<ApplyStatus>(deps.paths.applyStatus) ?? {};
    await deps.git.fetch();
    const target = await deps.git.remoteHead();
    if (target === null) throw new Error("dorothy-config has no main branch");
    if (target === status.appliedSha || target === status.rolledBackSha) return "unchanged";
    await deps.git.resetHard(target);
    try {
        copyConfig(deps.paths.checkout, deps.paths.home);
    } catch (error) {
        // Recorded like a rollback: the running config stays, and the head is not retried.
        const lastError = `config ${target} not applied: ${errorMessage(error)}`;
        writeJson(deps.paths.applyStatus, {
            ...status,
            rolledBackSha: target,
            configRolledBack: true,
            lastApplyAt: iso(deps.now()),
            lastError,
        });
        deps.log(lastError);
        return "failed";
    }
    warnAboutSkills(deps);
    if (await gatewayTest(deps, await bounce(deps))) {
        passed(deps, status, target);
        deps.log(`applied config ${target}`);
        return "applied";
    }
    return rollBack(deps, status, target);
}

/** Verifies the config the container booted with. */
export async function bootCheck(deps: ApplyDeps, registerWithinMs = 120_000): Promise<ApplyOutcome> {
    const deadline = deps.now() + registerWithinMs;
    while ((await deps.hermes.gatewayStatus()) === null) {
        if (deps.now() >= deadline) {
            deps.log("the gateway slot never registered");
            break;
        }
        await deps.sleep(1_000);
    }
    const status = readJson<ApplyStatus>(deps.paths.applyStatus) ?? {};
    const head = await deps.git.head();
    if (await gatewayTest(deps, null)) {
        passed(deps, status, head);
        deps.log(`boot check passed for config ${head}`);
        return "applied";
    }
    if (head === null) return "failed";
    return rollBack(deps, status, head);
}
```

- [ ] **Step 4: Run the tests**

Run: `mise exec -- node --test hermes/src/config.test.ts`
Expected: 14 pass.

- [ ] **Step 5: Commit**

```bash
bunx biome check --write hermes/src && bun run typecheck
git add hermes/src/config.ts hermes/src/config.test.ts
git commit -m "feat: Apply config with gateway test and rollback"
```

---

### Task 12: Bootstrap (hermes, cold and warm boot)

**Files:**

- Create: `hermes/src/bootstrap.ts`, `hermes/src/bootstrap.test.ts`

**Interfaces:**

- Consumes: `hermesSettings`, `allowlistNames`, `loadRegistry` (Task 4);
  `dotenvSpans` (Task 5); `restoreDatabase` (Task 6); `openBundle`,
  `readTrustedBundle`, `fileBytes` (Task 7); `emptyDirectory`, `removeUnlisted`,
  `skillDirectory`, `writeTreeFile` (Task 8); `ContainerPaths`,
  `IMAGE_CONTAINER_PATHS`, `createHermesCli` (Task 10); `configGit`,
  `configPaths`, `copyConfig`, `skillsWarning` (Task 11).
- Produces:
  `interface BootstrapDeps extends Clock { env: Env; registry: PlatformRegistry; paths: ContainerPaths; hermes: HermesCli; log: Log; gitEnv?; retryForMs?; outboxWaitMs? }`;
  `bootstrap(deps: BootstrapDeps): Promise<void>`;
  `cleanDotenv(path: string, env: Env, allowlists: string[]): string[]`;
  `writeRestoredFiles(home: string, files: BundleFile[]): void`.
  Writes `<run>/booted` (boot time for health), `<run>/config.key`, and
  `<home>/dorothy/restored` (`{memorySha, generation, restoredAt}`) last.

- [ ] **Step 1: Write the failing tests**

`hermes/src/bootstrap.test.ts`:

```ts
import assert from "node:assert/strict";
import { existsSync, mkdirSync, readFileSync, renameSync } from "node:fs";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { type TestContext, test } from "node:test";
import { type BootstrapDeps, bootstrap, writeRestoredFiles } from "./bootstrap.ts";
import { type Bundle, encodeFile, writeBundle } from "./bundle.ts";
import { dumpDatabase } from "./dump.ts";
import type { ContainerPaths } from "./hermes.ts";
import type { PlatformRegistry } from "./settings.ts";
import { type ApplyStatus, readJson, writeJson } from "./status.ts";
import { bareRepo, fakeClock, fakeHermes, GIT_ENV, pushFiles, tempDir, writeFiles } from "./test-helpers.ts";

const GOOD = "skills:\n    external_dirs:\n        - /opt/data/dorothy/config/skills\n";
const GENERATION = "0123456789abcdef0123456789abcdef";
const KEY = Buffer.from("-----BEGIN OPENSSH PRIVATE KEY-----\nAAAA\n-----END OPENSSH PRIVATE KEY-----\n").toString("base64");
const REGISTRY: PlatformRegistry = {
    platforms: {
        telegram: { enabledBy: ["TELEGRAM_BOT_TOKEN"], allowedUsers: "TELEGRAM_ALLOWED_USERS", allowAllUsers: "TELEGRAM_ALLOW_ALL_USERS" },
    },
    globalAllowlist: "GATEWAY_ALLOWED_USERS",
    globalAllowAll: "GATEWAY_ALLOW_ALL_USERS",
    extraAllowVariables: [],
};

function stateSql(t: TestContext): string {
    const path = join(tempDir(t), "source.db");
    const db = new DatabaseSync(path);
    db.exec("CREATE TABLE messages (id INTEGER PRIMARY KEY, content TEXT); INSERT INTO messages (content) VALUES ('hello from the fixture');");
    db.close();
    return dumpDatabase(path);
}

function restoreBundle(files: Record<string, string>, extra: Partial<Bundle> = {}): Bundle {
    return {
        version: 1,
        createdAt: "2026-10-03T00:00:00.000Z",
        generation: GENERATION,
        memorySha: "a".repeat(40),
        seed: false,
        files: Object.entries(files).map(([path, content]) => encodeFile(path, Buffer.from(content), 0o644)),
        ...extra,
    };
}

async function setup(t: TestContext, configFiles: Record<string, string> = { "SOUL.md": "soul", "config.yaml": GOOD }) {
    const dir = tempDir(t);
    const paths: ContainerPaths = {
        home: join(dir, "data"),
        run: join(dir, "run"),
        restore: join(dir, "restore/restore.json"),
        syncStatus: join(dir, "restore/status.json"),
        outbox: join(dir, "outbox/bundle.json"),
        knownHosts: join(dir, "known_hosts"),
    };
    mkdirSync(paths.home, { recursive: true });
    mkdirSync(paths.run, { recursive: true });
    const url = bareRepo(t);
    const configSha = pushFiles(t, url, configFiles);
    writeJson(paths.restore, restoreBundle({ "sessions/state.sql": stateSql(t), "memories/MEMORY.md": "remembered" }));
    const hermes = fakeHermes();
    const logs: string[] = [];
    const deps: BootstrapDeps = {
        ...fakeClock(),
        env: { DOROTHY_CONFIG_REPO: url, DOROTHY_CONFIG_REPO_NAME: "test/config", DOROTHY_CONFIG_DEPLOY_KEY: KEY },
        registry: REGISTRY,
        paths,
        hermes,
        log: (message) => logs.push(message),
        gitEnv: GIT_ENV,
        retryForMs: 5_000,
    };
    return { url, configSha, paths, hermes, logs, deps };
}

function messages(home: string): string[] {
    const db = new DatabaseSync(join(home, "state.db"), { readOnly: true });
    const rows = db.prepare("SELECT content FROM messages").all() as { content: string }[];
    db.close();
    return rows.map((row) => row.content);
}

test("a cold boot copies config, restores everything and marks restored", async (t) => {
    const { configSha, paths, hermes, logs, deps } = await setup(t);
    writeJson(
        paths.restore,
        restoreBundle({
            "sessions/state.sql": stateSql(t),
            "memories/MEMORY.md": "remembered",
            "skills/cat/mine/SKILL.md": "mine",
            "cron/jobs.json": "{}",
        }),
    );
    writeFiles(paths.home, {
        "state.db-wal": "stale",
        "skills/cat/mine/old.md": "old",
        "skills/cat/bundled/SKILL.md": "bundled",
        "memories/STALE.md": "stale",
    });
    await bootstrap(deps);
    assert.equal(readFileSync(join(paths.home, "SOUL.md"), "utf8"), "soul");
    assert.deepEqual(messages(paths.home), ["hello from the fixture"]);
    assert.equal(existsSync(join(paths.home, "state.db-wal")), false);
    assert.equal(readFileSync(join(paths.home, "memories/MEMORY.md"), "utf8"), "remembered");
    assert.equal(existsSync(join(paths.home, "memories/STALE.md")), false);
    assert.equal(existsSync(join(paths.home, "skills/cat/mine/old.md")), false);
    assert.equal(existsSync(join(paths.home, "skills/cat/bundled/SKILL.md")), true);
    assert.equal(readFileSync(join(paths.home, "cron/jobs.json"), "utf8"), "{}");
    assert.deepEqual(hermes.calls, ["optimize"]);
    assert.equal(readJson<{ memorySha: string }>(join(paths.home, "dorothy/restored"))?.memorySha, "a".repeat(40));
    assert.ok(logs.includes(`config ${configSha}`));
    assert.ok(existsSync(join(paths.run, "booted")));
});

test("a warm boot keeps the volume's state", async (t) => {
    const { paths, hermes, deps } = await setup(t);
    writeFiles(paths.home, { "state.db": "keep", "dorothy/restored": "{}" });
    await bootstrap(deps);
    assert.equal(readFileSync(join(paths.home, "state.db"), "utf8"), "keep");
    assert.deepEqual(hermes.calls, []);
});

test("an interrupted restore runs again over a partial state.db", async (t) => {
    const { paths, deps } = await setup(t);
    writeFiles(paths.home, { "state.db": "half-written" });
    await bootstrap(deps);
    assert.deepEqual(messages(paths.home), ["hello from the fixture"]);
});

test("a seed restore keeps Hermes's fresh state", async (t) => {
    const { paths, hermes, deps } = await setup(t);
    writeJson(paths.restore, { ...restoreBundle({}), memorySha: undefined, seed: true });
    await bootstrap(deps);
    assert.equal(existsSync(join(paths.home, "state.db")), false);
    assert.equal(readJson<{ generation: string }>(join(paths.home, "dorothy/restored"))?.generation, GENERATION);
    assert.deepEqual(hermes.calls, []);
});

test("restore waits for the sidecar to consume the outbox", async (t) => {
    const { paths, logs, deps } = await setup(t);
    const hash = writeBundle(paths.outbox, restoreBundle({ "memories/MEMORY.md": "newer" }, { memorySha: undefined }));
    let slept = 0;
    deps.sleep = async () => {
        slept += 1;
        const restore = readJson<Bundle>(paths.restore);
        writeJson(paths.restore, { ...restore, bundleHash: hash });
    };
    await bootstrap(deps);
    assert.equal(slept, 1);
    assert.equal(logs.some((m) => m.includes("has not consumed")), false);
});

test("the outbox wait gives up after two minutes", async (t) => {
    const { paths, logs, deps } = await setup(t);
    writeBundle(paths.outbox, restoreBundle({ "memories/MEMORY.md": "newer" }, { memorySha: undefined }));
    await bootstrap(deps);
    assert.ok(logs.some((m) => m.includes("has not consumed")));
    assert.ok(existsSync(join(paths.home, "dorothy/restored")));
});

test("an outbox from another generation does not delay the restore", async (t) => {
    const { paths, deps } = await setup(t);
    writeBundle(paths.outbox, restoreBundle({}, { generation: "f".repeat(32), memorySha: undefined }));
    const before = deps.now();
    await bootstrap(deps);
    assert.equal(deps.now(), before);
});

test("a rolled-back head is not copied in", async (t) => {
    const { configSha, paths, deps } = await setup(t);
    writeFiles(paths.home, { "SOUL.md": "last good", "dorothy/restored": "{}" });
    writeJson(join(paths.home, "dorothy/status/apply.json"), { rolledBackSha: configSha });
    await bootstrap(deps);
    assert.equal(readFileSync(join(paths.home, "SOUL.md"), "utf8"), "last good");
});

test("an unreachable remote reuses the existing checkout", async (t) => {
    const { url, logs, deps } = await setup(t);
    await bootstrap(deps);
    renameSync(url.slice("file://".length), `${url.slice("file://".length)}.gone`);
    await bootstrap(deps);
    assert.ok(logs.some((m) => m.startsWith("GitHub unreachable")));
});

test("an unreachable remote without a checkout fails after retrying", async (t) => {
    const { deps } = await setup(t);
    deps.env = { ...deps.env, DOROTHY_CONFIG_REPO: "file:///nonexistent/config.git" };
    await assert.rejects(bootstrap(deps), /clone dorothy-config kept failing for 5 s/);
});

test("restoring a category file keeps the category's bundled skills", (t) => {
    const home = tempDir(t);
    writeFiles(home, { "skills/cat/bundled/SKILL.md": "bundled", "skills/cat/mine/old.md": "old" });
    writeRestoredFiles(home, [
        encodeFile("skills/cat/DESCRIPTION.md", Buffer.from("cat"), 0o644),
        encodeFile("skills/cat/mine/SKILL.md", Buffer.from("mine"), 0o644),
    ]);
    assert.equal(readFileSync(join(home, "skills/cat/bundled/SKILL.md"), "utf8"), "bundled");
    assert.equal(readFileSync(join(home, "skills/cat/DESCRIPTION.md"), "utf8"), "cat");
    assert.equal(existsSync(join(home, "skills/cat/mine/old.md")), false);
});

test(".env loses provided and allowlist variables; pairing is emptied", async (t) => {
    const { paths, deps } = await setup(t);
    writeFiles(paths.home, {
        ".env": [
            "# upstream comment",
            "TELEGRAM_ALLOWED_USERS=999",
            'export GATEWAY_ALLOW_ALL_USERS="true"',
            "'GATEWAY_ALLOW_ALL_USERS'=true",
            'GATEWAY_ALLOWED_USERS="1,',
            '*"',
            "DOROTHY_CONFIG_REPO=somewhere-else",
            "not a line",
            "API_SERVER_KEY=keep-me-123",
        ].join("\n"),
        "pairing/approved.json": "{}",
        "platforms/pairing/telegram.json": "{}",
    });
    await bootstrap(deps);
    assert.equal(readFileSync(join(paths.home, ".env"), "utf8"), "# upstream comment\nAPI_SERVER_KEY=keep-me-123");
    assert.equal(existsSync(join(paths.home, "pairing/approved.json")), false);
    assert.equal(existsSync(join(paths.home, "platforms/pairing/telegram.json")), false);
});

test("a config repository without config.yaml is named", async (t) => {
    const { deps } = await setup(t, { "SOUL.md": "soul" });
    await assert.rejects(bootstrap(deps), /config\.yaml is missing/);
});

test("a config repository without config.yaml boots the last-good copy", async (t) => {
    const { configSha, paths, logs, deps } = await setup(t, { "SOUL.md": "soul" });
    writeFiles(join(paths.home, "dorothy/last-good"), { "SOUL.md": "old soul", "config.yaml": GOOD });
    await bootstrap(deps);
    assert.equal(readFileSync(join(paths.home, "SOUL.md"), "utf8"), "old soul");
    assert.equal(readFileSync(join(paths.home, "config.yaml"), "utf8"), GOOD);
    assert.equal(readJson<ApplyStatus>(join(paths.home, "dorothy/status/apply.json"))?.rolledBackSha, configSha);
    assert.ok(logs.some((m) => m.includes("config.yaml is missing")));
});

test("a config.yaml without the skills directory warns", async (t) => {
    const { logs, deps } = await setup(t, { "SOUL.md": "soul", "config.yaml": "model: x\n" });
    await bootstrap(deps);
    assert.ok(logs.some((m) => m.includes("skills.external_dirs")));
});

test("a platform token without its allowlist stops the boot", async (t) => {
    const { deps } = await setup(t);
    deps.env = { ...deps.env, TELEGRAM_BOT_TOKEN: "1:abc" };
    await assert.rejects(bootstrap(deps), /TELEGRAM_ALLOWED_USERS is empty/);
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `mise exec -- node --test hermes/src/bootstrap.test.ts`
Expected: FAIL, module not found.

- [ ] **Step 3: Implement `bootstrap.ts`**

```ts
import { existsSync, renameSync, rmSync } from "node:fs";
import { join } from "node:path";
import { type Bundle, BundleError, type BundleFile, fileBytes, openBundle, type OpenedBundle, readTrustedBundle } from "./bundle.ts";
import { configGit, configPaths, copyConfig, hasLastGood, skillsWarning } from "./config.ts";
import { restoreDatabase } from "./dump.ts";
import { emptyDirectory, removeUnlisted, skillDirectory, writeTreeFile } from "./files.ts";
import type { Git } from "./git.ts";
import { type ContainerPaths, createHermesCli, type HermesCli, IMAGE_CONTAINER_PATHS } from "./hermes.ts";
import { dotenvSpans } from "./redact.ts";
import { allowlistNames, type Env, hermesSettings, loadRegistry, type PlatformRegistry } from "./settings.ts";
import { type ApplyStatus, readJson, readText, writeFileAtomic, writeJson } from "./status.ts";
import { type Clock, errorMessage, iso, type Log, logger, realClock, retry } from "./util.ts";

export interface BootstrapDeps extends Clock {
    env: Env;
    registry: PlatformRegistry;
    paths: ContainerPaths;
    hermes: HermesCli;
    log: Log;
    gitEnv?: NodeJS.ProcessEnv;
    retryForMs?: number;
    outboxWaitMs?: number;
}

/**
 * Upstream loads .env over the process environment, so anything the
 * deployment provides, and every allowlist, must not survive there (S6).
 * Entries are read with upstream's grammar and dropped whole, multi-line
 * values included; a line upstream cannot parse is dropped too.
 */
export function cleanDotenv(path: string, env: Env, allowlists: string[]): string[] {
    const text = readText(path);
    if (text === "") return [];
    const drop = new Set(allowlists);
    const removed: string[] = [];
    const kept = dotenvSpans(text).filter((span) => {
        if (span.invalid) {
            removed.push("an unparsable line");
            return false;
        }
        const name = span.name;
        if (name === undefined || (!drop.has(name) && !(env[name] ?? "").trim())) return true;
        removed.push(name);
        return false;
    });
    if (removed.length > 0) {
        writeFileAtomic(path, kept.map((span) => span.text).join(""), 0o600);
    }
    return removed;
}

/** Memories are replaced wholesale; each restored skill directory is replaced. */
export function writeRestoredFiles(home: string, files: BundleFile[]): void {
    const listed = files.filter((file) => file.path !== "sessions/state.sql");
    removeUnlisted(home, "memories", new Set(listed.map((file) => file.path)));
    const skills = new Set<string>();
    for (const file of listed) {
        const dir = file.path.startsWith("skills/") ? skillDirectory(file.path) : null;
        if (dir) skills.add(dir);
    }
    for (const dir of skills) rmSync(join(home, dir), { recursive: true, force: true });
    for (const file of listed) writeTreeFile(home, file);
}

async function syncCheckout(git: Git, url: string, deps: BootstrapDeps): Promise<void> {
    if (existsSync(join(git.dir, ".git"))) {
        await git.setRemote(url);
        try {
            await git.fetch();
        } catch (error) {
            deps.log(`GitHub unreachable, using the existing config checkout: ${errorMessage(error)}`);
            return;
        }
    } else {
        await retry(
            "clone dorothy-config",
            async () => {
                rmSync(git.dir, { recursive: true, force: true });
                await git.clone(url);
            },
            { ...deps, forMs: deps.retryForMs ?? 300_000 },
        );
    }
    const remote = await git.remoteHead();
    if (remote === null) throw new Error("dorothy-config has no main branch");
    await git.resetHard(remote);
}

/** Waits until the sidecar has consumed the outbox, so at most nothing is lost. */
async function awaitConsumedOutbox(deps: BootstrapDeps): Promise<Bundle> {
    const deadline = deps.now() + (deps.outboxWaitMs ?? 120_000);
    for (;;) {
        const restore = readTrustedBundle(deps.paths.restore);
        let outbox: OpenedBundle | null = null;
        try {
            outbox = openBundle(deps.paths.outbox, Number.MAX_SAFE_INTEGER);
        } catch (error) {
            if (!(error instanceof BundleError)) throw error;
            deps.log(`ignoring an invalid outbox bundle: ${error.message}`);
        }
        if (outbox === null || outbox.bundle.generation !== restore.generation || outbox.hash === restore.bundleHash) {
            return restore;
        }
        if (deps.now() >= deadline) {
            deps.log("the sidecar has not consumed the outbox after two minutes; restoring without it");
            return restore;
        }
        await deps.sleep(2_000);
    }
}

async function restore(deps: BootstrapDeps): Promise<void> {
    const home = deps.paths.home;
    const marker = join(home, "dorothy/restored");
    if (existsSync(marker)) {
        deps.log("warm boot: the volume's state wins");
        return;
    }
    const snapshot = await awaitConsumedOutbox(deps);
    if (snapshot.seed) {
        deps.log("first deployment: keeping Hermes's fresh state");
    } else {
        const sql = snapshot.files.find((file) => file.path === "sessions/state.sql");
        if (!sql) throw new Error("restore.json has no sessions/state.sql");
        for (const suffix of ["-wal", "-shm", "-journal"]) rmSync(join(home, `state.db${suffix}`), { force: true });
        const temp = join(home, "state.db.dorothy-restore");
        rmSync(temp, { force: true });
        rmSync(`${temp}-journal`, { force: true });
        restoreDatabase(fileBytes(sql).toString("utf8"), temp);
        renameSync(temp, join(home, "state.db"));
        writeRestoredFiles(home, snapshot.files);
        const optimized = (await deps.hermes.optimizeStorage()).trim();
        if (optimized) deps.log(`optimize-storage: ${optimized}`);
        // Wording recorded by the Task 1 probe; a skip leaves CJK search unindexed.
        if (/not enough free disk|nothing to do/i.test(optimized)) {
            deps.log("optimize-storage skipped its work; CJK search may miss restored sessions");
        }
        deps.log(`restored dorothy-memory ${snapshot.memorySha}`);
    }
    writeJson(marker, {
        memorySha: snapshot.memorySha ?? null,
        generation: snapshot.generation,
        restoredAt: iso(deps.now()),
    });
}

export async function bootstrap(deps: BootstrapDeps): Promise<void> {
    const { home, run } = deps.paths;
    writeFileAtomic(join(run, "booted"), iso(deps.now()));
    const settings = hermesSettings(deps.env, deps.registry);
    const removed = cleanDotenv(join(home, ".env"), deps.env, allowlistNames(deps.registry));
    if (removed.length > 0) deps.log(`removed from .env: ${removed.join(", ")}`);
    emptyDirectory(join(home, "pairing"));
    emptyDirectory(join(home, "platforms/pairing"));
    writeFileAtomic(join(run, "config.key"), settings.configKey, 0o600);
    const git = configGit(deps.paths, deps.gitEnv);
    await syncCheckout(git, settings.configRepo, deps);
    const head = await git.head();
    const paths = configPaths(home);
    const status = readJson<ApplyStatus>(paths.applyStatus) ?? {};
    if (head !== null && head === status.rolledBackSha) {
        deps.log(`keeping the last-good config: ${head} was rolled back`);
    } else {
        try {
            copyConfig(paths.checkout, home);
            deps.log(`config ${head}`);
        } catch (error) {
            // A broken config never takes the agent offline when a last-good copy exists.
            if (!hasLastGood(paths)) throw error;
            copyConfig(paths.lastGood, home);
            const lastError = `config ${head} not applied: ${errorMessage(error)}`;
            writeJson(paths.applyStatus, {
                ...status,
                ...(head === null ? {} : { rolledBackSha: head }),
                configRolledBack: true,
                lastApplyAt: iso(deps.now()),
                lastError,
            });
            deps.log(`${lastError}; booting the last-good config`);
        }
    }
    const warning = skillsWarning(readText(join(home, "config.yaml")));
    if (warning) deps.log(warning);
    await restore(deps);
}

if (import.meta.main) {
    const log = logger("dorothy-bootstrap");
    bootstrap({
        ...realClock,
        env: process.env,
        registry: loadRegistry(),
        paths: IMAGE_CONTAINER_PATHS,
        hermes: createHermesCli(),
        log,
    })
        .then(() => log("done"))
        .catch((error: unknown) => {
            log(`failed: ${errorMessage(error)}`);
            process.exitCode = 1;
        });
}
```

- [ ] **Step 4: Run the tests**

Run: `mise exec -- node --test hermes/src/bootstrap.test.ts`
Expected: 16 pass.

- [ ] **Step 5: Commit**

```bash
bunx biome check --write hermes/src && bun run typecheck
git add hermes/src/bootstrap.ts hermes/src/bootstrap.test.ts
git commit -m "feat: Bootstrap config and restore memory at boot"
```

---

### Task 13: The snapshot loop

**Files:**

- Create: `hermes/src/snapshot.ts`, `hermes/src/snapshot.test.ts`

**Interfaces:**

- Consumes: everything in Tasks 2 to 11.
- Produces: `SNAPSHOT_LABEL = "dorothy-sync"`;
  `interface SnapshotDeps extends Clock { env: Env; paths: ContainerPaths; hermes: HermesCli; log: Log; gitEnv?; timing?: GatewayTestTiming; signal?: AbortSignal }`;
  `bundledSkillNames(home: string): Set<string>`;
  `snapshotOnce(deps, options?: { final?: boolean }): Promise<boolean>`
  (false when not yet restored);
  `serve(deps, signal: AbortSignal): Promise<void>` (boot check, then a
  snapshot every interval). CLI: no flag serves; `--once`; `--final`.

- [ ] **Step 1: Write the failing tests**

`hermes/src/snapshot.test.ts`:

```ts
import assert from "node:assert/strict";
import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { type TestContext, test } from "node:test";
import { type Bundle, fileBytes, openBundle } from "./bundle.ts";
import { configPaths, copyConfig } from "./config.ts";
import { Git } from "./git.ts";
import type { ContainerPaths } from "./hermes.ts";
import { type SnapshotDeps, snapshotOnce } from "./snapshot.ts";
import { readJson, writeJson } from "./status.ts";
import { bareRepo, type FakeHermes, fakeClock, fakeHermes, GIT_ENV, pushFiles, tempDir, writeFiles } from "./test-helpers.ts";

const GENERATION = "0123456789abcdef0123456789abcdef";
const GOOD = "skills:\n    external_dirs:\n        - /opt/data/dorothy/config/skills\n";

function snapshotter(home: string, options: { failedDbs?: string[]; corrupt?: boolean; failures?: number } = {}) {
    let n = 0;
    let failures = options.failures ?? 0;
    return async (label: string): Promise<string> => {
        if (failures > 0) {
            failures -= 1;
            throw new Error("backup lock held");
        }
        const dir = join(home, "state-snapshots", `20261003-00000${n++}-${label}`);
        mkdirSync(join(dir, "cron"), { recursive: true });
        if (options.corrupt) {
            writeFileSync(join(dir, "state.db"), "not a database at all, just text");
        } else {
            const db = new DatabaseSync(join(dir, "state.db"));
            db.exec("CREATE TABLE messages (id INTEGER PRIMARY KEY, content TEXT, data BLOB)");
            db.prepare("INSERT INTO messages (content, data) VALUES (?, ?)").run(
                "my token is telegram-secret-123",
                Buffer.from("telegram-secret-123"),
            );
            db.close();
        }
        writeFileSync(join(dir, "manifest.json"), JSON.stringify({ failed_dbs: options.failedDbs ?? [] }));
        writeFileSync(join(dir, "cron/jobs.json"), '{"jobs": []}');
        return dir;
    };
}

async function setup(t: TestContext, hermesFor: (home: string) => FakeHermes) {
    const dir = tempDir(t);
    const paths: ContainerPaths = {
        home: join(dir, "data"),
        run: join(dir, "run"),
        restore: join(dir, "restore/restore.json"),
        syncStatus: join(dir, "restore/status.json"),
        outbox: join(dir, "outbox/bundle.json"),
        knownHosts: join(dir, "known_hosts"),
    };
    mkdirSync(paths.run, { recursive: true });
    writeFiles(paths.home, {
        "dorothy/restored": "{}",
        ".env": "API_SERVER_KEY=generated-api-key-1\n",
        "memories/MEMORY.md": "the api key is generated-api-key-1",
        "memories/notes.txt": "not markdown",
        "memories/sub/deep.md": "nested",
        "skills/.bundled_manifest": "bundled:abc123\n",
        "skills/cat/bundled/SKILL.md": "upstream",
        "skills/cat/mine/SKILL.md": "mine",
        "outside.txt": "secret",
    });
    symlinkSync(join(paths.home, "outside.txt"), join(paths.home, "skills/cat/mine/link.md"));
    writeJson(paths.restore, { version: 1, createdAt: "2026-10-03T00:00:00.000Z", generation: GENERATION, seed: true, files: [] });
    const url = bareRepo(t);
    const applied = pushFiles(t, url, { "SOUL.md": "soul 1", "config.yaml": GOOD });
    const config = configPaths(paths.home);
    await new Git(config.checkout, { env: GIT_ENV }).clone(url);
    copyConfig(config.checkout, paths.home);
    writeJson(config.applyStatus, { appliedSha: applied });
    const hermes = hermesFor(paths.home);
    const logs: string[] = [];
    const deps: SnapshotDeps = {
        ...fakeClock(),
        env: { TELEGRAM_BOT_TOKEN: "telegram-secret-123", DOROTHY_SYNC_INTERVAL: "900" },
        paths,
        hermes,
        log: (message) => logs.push(message),
        gitEnv: GIT_ENV,
    };
    return { url, paths, hermes, logs, deps };
}

function outbox(paths: ContainerPaths): Bundle {
    const opened = openBundle(paths.outbox, 1 << 24);
    assert.ok(opened);
    return opened.bundle;
}

const status = (paths: ContainerPaths) => readJson<{ lastSuccessAt?: string; lastError?: string }>(join(paths.home, "dorothy/status/snapshot.json")) ?? {};

test("nothing happens before the first restore", async (t) => {
    const { paths, hermes, deps } = await setup(t, (home) => fakeHermes({ snapshot: snapshotter(home) }));
    rmSync(join(paths.home, "dorothy/restored"));
    assert.equal(await snapshotOnce(deps), false);
    assert.equal(existsSync(paths.outbox), false);
    assert.deepEqual(hermes.calls, []);
});

test("the bundle holds the right files, redacted, with the restore generation", async (t) => {
    const { paths, deps } = await setup(t, (home) => fakeHermes({ snapshot: snapshotter(home) }));
    assert.equal(await snapshotOnce(deps), true);
    const bundle = outbox(paths);
    assert.equal(bundle.generation, GENERATION);
    assert.deepEqual(
        bundle.files.map((f) => f.path),
        ["sessions/state.sql", "cron/jobs.json", "memories/MEMORY.md", "skills/cat/mine/SKILL.md"],
    );
    const sql = bundle.files[0]?.content ?? "";
    assert.equal(sql.includes("telegram-secret-123"), false);
    assert.ok(sql.includes("'my token is [REDACTED:TELEGRAM_BOT_TOKEN]'"));
    assert.ok(sql.includes(`X'${Buffer.from("[REDACTED:TELEGRAM_BOT_TOKEN]").toString("hex").toUpperCase()}'`));
    const memory = bundle.files.find((f) => f.path === "memories/MEMORY.md");
    assert.equal(memory && fileBytes(memory).toString(), "the api key is [REDACTED:API_SERVER_KEY]");
    assert.deepEqual(readdirSync(join(paths.home, "state-snapshots")), []);
    assert.ok(status(paths).lastSuccessAt);
});

test("a failed state.db copy fails the snapshot and still cleans up", async (t) => {
    const { paths, deps } = await setup(t, (home) => fakeHermes({ snapshot: snapshotter(home, { failedDbs: ["state.db"] }) }));
    await assert.rejects(snapshotOnce(deps), /could not copy state\.db/);
    assert.deepEqual(readdirSync(join(paths.home, "state-snapshots")), []);
    assert.equal(existsSync(paths.outbox), false);
    assert.match(status(paths).lastError ?? "", /state\.db/);
});

test("a database that fails its table check fails the snapshot", async (t) => {
    const { paths, deps } = await setup(t, (home) => fakeHermes({ snapshot: snapshotter(home, { corrupt: true }) }));
    await assert.rejects(snapshotOnce(deps));
    assert.equal(existsSync(paths.outbox), false);
});

test("the fallback apply skips a held apply.lock", async (t) => {
    const { paths, logs, deps } = await setup(t, (home) => fakeHermes({ snapshot: snapshotter(home) }));
    mkdirSync(join(paths.run, "apply.lock"));
    writeFileSync(join(paths.run, "apply.lock/pid"), String(process.pid));
    assert.equal(await snapshotOnce(deps), true);
    assert.ok(logs.includes("an apply is running; skipping the config check"));
});

test("the fallback apply delivers a missed config push", async (t) => {
    let pid = 100;
    const { url, paths, deps } = await setup(t, (home) =>
        fakeHermes({
            snapshot: snapshotter(home),
            status: () => ({ up: true, pid }),
            restart: () => {
                pid += 1;
            },
        }),
    );
    pushFiles(t, url, { "SOUL.md": "soul 2" });
    await snapshotOnce(deps);
    assert.equal(readFileSync(join(paths.home, "SOUL.md"), "utf8"), "soul 2");
});

test("--final retries the backup within its budget", async (t) => {
    const { hermes, deps } = await setup(t, (home) => fakeHermes({ snapshot: snapshotter(home, { failures: 2 }) }));
    assert.equal(await snapshotOnce(deps, { final: true }), true);
    assert.equal(hermes.calls.filter((c) => c.startsWith("snapshot")).length, 3);
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `mise exec -- node --test hermes/src/snapshot.test.ts`
Expected: FAIL, module not found.

- [ ] **Step 3: Implement `snapshot.ts`**

```ts
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { type BundleFile, encodeFile, fileBytes, readTrustedBundle, writeBundle } from "./bundle.ts";
import { type ApplyDeps, applyConfig, bootCheck, configGit, configPaths, type GatewayTestTiming } from "./config.ts";
import { checkTables, dumpDatabase } from "./dump.ts";
import { collectFile, collectTree } from "./files.ts";
import { type ContainerPaths, createHermesCli, type HermesCli, IMAGE_CONTAINER_PATHS } from "./hermes.ts";
import { tryWithLock, withLock } from "./lock.ts";
import { collectSecrets, parseDotenv, Redactor } from "./redact.ts";
import { type Env, syncInterval } from "./settings.ts";
import { readJson, readText, type SnapshotStatus, writeJson } from "./status.ts";
import { type Clock, errorMessage, iso, type Log, logger, realClock, retry } from "./util.ts";

export const SNAPSHOT_LABEL = "dorothy-sync";

export interface SnapshotDeps extends Clock {
    env: Env;
    paths: ContainerPaths;
    hermes: HermesCli;
    log: Log;
    gitEnv?: NodeJS.ProcessEnv;
    timing?: GatewayTestTiming;
    /** Stops a running fetch when the service stops. */
    signal?: AbortSignal;
}

function applyDeps(deps: SnapshotDeps): ApplyDeps {
    return {
        now: deps.now,
        sleep: deps.sleep,
        git: configGit(deps.paths, deps.gitEnv, deps.signal),
        hermes: deps.hermes,
        paths: configPaths(deps.paths.home),
        log: deps.log,
        timing: deps.timing,
    };
}

/** Names from `skills/.bundled_manifest` (`name:hash` lines). */
export function bundledSkillNames(home: string): Set<string> {
    const names = new Set<string>();
    for (const line of readText(join(home, "skills/.bundled_manifest")).split("\n")) {
        const name = line.split(":")[0]?.trim();
        if (name) names.add(name);
    }
    return names;
}

function userFiles(home: string): BundleFile[] {
    const bundled = bundledSkillNames(home);
    return [
        ...collectTree(home, "memories", {
            skipDirectory: () => true,
            includeFile: (path) => path.endsWith(".md"),
        }),
        ...collectTree(home, "skills", {
            skipDirectory: (path) => {
                const parts = path.split("/");
                return parts.length === 3 && bundled.has(parts[2] ?? "");
            },
        }),
    ];
}

function redactFile(file: BundleFile, redactor: Redactor): BundleFile {
    if (file.encoding === "utf8") return { ...file, content: redactor.text(file.content) };
    return encodeFile(file.path, redactor.bytes(fileBytes(file)), file.mode);
}

function recordStatus(deps: SnapshotDeps, update: SnapshotStatus): void {
    const path = join(deps.paths.home, "dorothy/status/snapshot.json");
    writeJson(path, { ...(readJson<SnapshotStatus>(path) ?? {}), ...update });
}

/** The webhook's apply, for pushes whose delivery was lost. */
async function fallbackApply(deps: SnapshotDeps): Promise<void> {
    const result = await tryWithLock(join(deps.paths.run, "apply.lock"), async () => {
        try {
            await applyConfig(applyDeps(deps));
        } catch (error) {
            deps.log(`config check failed: ${errorMessage(error)}`);
        }
    });
    if (!result.ran) deps.log("an apply is running; skipping the config check");
}

/**
 * The final snapshot shares one budget for the lock wait and backup retries,
 * leaving the rest of S6_KILL_FINISH_MAXTIME (60 s) for the dump and bundle.
 */
export const FINAL_BUDGET_MS = 40_000;

async function takeBackup(deps: SnapshotDeps, finalDeadline: number | null): Promise<string> {
    if (finalDeadline === null) return deps.hermes.snapshot(SNAPSHOT_LABEL);
    // An interrupted snapshot's child may still hold the backup lock.
    const forMs = Math.max(1_000, finalDeadline - deps.now());
    return retry("hermes backup", () => deps.hermes.snapshot(SNAPSHOT_LABEL), { ...deps, forMs });
}

export async function snapshotOnce(deps: SnapshotDeps, options: { final?: boolean } = {}): Promise<boolean> {
    const { home, run } = deps.paths;
    if (!existsSync(join(home, "dorothy/restored"))) {
        deps.log("not restored yet; nothing to snapshot");
        return false;
    }
    const final = options.final === true;
    const finalDeadline = final ? deps.now() + FINAL_BUDGET_MS : null;
    return withLock(
        join(run, "snapshot.lock"),
        async () => {
            recordStatus(deps, { lastAttemptAt: iso(deps.now()) });
            try {
                if (!final) await fallbackApply(deps);
                const dir = await takeBackup(deps, finalDeadline);
                const redactor = new Redactor(
                    collectSecrets([...Object.entries(deps.env), ...parseDotenv(readText(join(home, ".env")))]),
                );
                let sql: string;
                let jobs: BundleFile | null;
                try {
                    const manifest = JSON.parse(readFileSync(join(dir, "manifest.json"), "utf8")) as {
                        failed_dbs?: string[];
                    };
                    if (manifest.failed_dbs?.includes("state.db")) {
                        throw new Error("hermes backup could not copy state.db");
                    }
                    checkTables(join(dir, "state.db"));
                    sql = dumpDatabase(join(dir, "state.db"), {
                        mapText: (value) => redactor.text(value),
                        mapBlob: (value) => redactor.bytes(value),
                    });
                    jobs = collectFile(dir, "cron/jobs.json");
                } finally {
                    await deps.hermes.deleteSnapshot(dir);
                }
                const files: BundleFile[] = [
                    { path: "sessions/state.sql", mode: 0o644, encoding: "utf8", content: sql },
                    ...[...(jobs ? [jobs] : []), ...userFiles(home)].map((file) => redactFile(file, redactor)),
                ];
                const { generation } = readTrustedBundle(deps.paths.restore);
                writeBundle(deps.paths.outbox, {
                    version: 1,
                    createdAt: iso(deps.now()),
                    generation,
                    seed: false,
                    files,
                });
                recordStatus(deps, { lastSuccessAt: iso(deps.now()), lastError: undefined });
                deps.log(`wrote a bundle of ${files.length} files`);
                return true;
            } catch (error) {
                recordStatus(deps, { lastError: errorMessage(error) });
                throw error;
            }
        },
        { waitMs: final ? FINAL_BUDGET_MS / 2 : 600_000 },
    );
}

/**
 * The dorothy-snapshot service. Until plan 3 adds dorothy-webhook, the boot
 * check runs here.
 */
export async function serve(deps: SnapshotDeps, signal: AbortSignal): Promise<void> {
    await withLock(join(deps.paths.run, "apply.lock"), async () => {
        try {
            await bootCheck(applyDeps(deps));
        } catch (error) {
            deps.log(`boot check failed: ${errorMessage(error)}`);
        }
    });
    const intervalMs = syncInterval(deps.env) * 1000;
    while (!signal.aborted) {
        try {
            await delay(intervalMs, undefined, { signal });
        } catch {
            return;
        }
        try {
            await snapshotOnce(deps);
        } catch (error) {
            deps.log(`snapshot failed: ${errorMessage(error)}`);
        }
    }
}

if (import.meta.main) {
    const log = logger("dorothy-snapshot");
    const controller = new AbortController();
    process.once("SIGTERM", () => controller.abort());
    const deps: SnapshotDeps = {
        ...realClock,
        env: process.env,
        paths: IMAGE_CONTAINER_PATHS,
        hermes: createHermesCli(undefined, controller.signal),
        log,
        signal: controller.signal,
    };
    const args = process.argv.slice(2);
    const work =
        args.includes("--once") || args.includes("--final")
            ? snapshotOnce(deps, { final: args.includes("--final") }).then(() => undefined)
            : serve(deps, controller.signal);
    work.catch((error: unknown) => {
        log(`failed: ${errorMessage(error)}`);
        process.exitCode = 1;
    });
}
```

- [ ] **Step 4: Run the tests**

Run: `mise exec -- node --test hermes/src/snapshot.test.ts`
Expected: 7 pass.

- [ ] **Step 5: Commit**

```bash
bunx biome check --write hermes/src && bun run typecheck
git add hermes/src/snapshot.ts hermes/src/snapshot.test.ts
git commit -m "feat: Snapshot state into the outbox bundle"
```

---

### Task 14: The sidecar (dorothy-sync)

**Files:**

- Create: `hermes/src/sidecar.ts`, `hermes/src/sidecar.test.ts`

**Interfaces:**

- Consumes: `sidecarSettings`, `SidecarSettings` (Task 4); `Bundle`,
  `BundleError`, `fileBytes`, `openBundle`, `validPath`, `validateBundle`
  (Task 7); `collectFile`, `collectTree`, `removeUnlisted`, `writeTreeFile`
  (Task 8); `Git` (Task 9); `writeFileAtomic`, `writeJson`, `SyncStatus`
  (Task 3); `retry`, `Clock` (Task 2).
- Produces:
  `interface SidecarPaths { checkout; generation; consumed; restore; status; outbox; key; knownHosts }`;
  `sidecarPaths(root?: string, keyDir?: string): SidecarPaths`;
  `SIZE_LIMITS = { warnBytes: 80 MiB, failBytes: 95 MiB }`;
  `PUBLISH_EVERY_MS = 30_000`;
  `interface SidecarDeps extends Clock { settings: SidecarSettings; paths: SidecarPaths; log: Log; gitEnv?; retryForMs?; limits? }`;
  `commitMessage(host: string, changed: string[]): string`;
  `mirror(root: string, files: BundleFile[]): void`;
  `class Sidecar { readonly status: SyncStatus; get generation(): string; start(): Promise<void>; cycle(): Promise<void> }`;
  `runSidecar(deps, signal: AbortSignal): Promise<void>`.

- [ ] **Step 1: Write the failing tests**

`hermes/src/sidecar.test.ts`:

```ts
import assert from "node:assert/strict";
import { existsSync, mkdirSync, readFileSync, renameSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { type TestContext, test } from "node:test";
import { type Bundle, encodeFile, writeBundle } from "./bundle.ts";
import type { SidecarSettings } from "./settings.ts";
import { commitMessage, Sidecar, type SidecarDeps, type SidecarPaths, sidecarPaths } from "./sidecar.ts";
import { readJson } from "./status.ts";
import { bareRepo, fakeClock, GIT_ENV, git, pushFiles, remoteMain, remoteShow, tempDir, writeFiles } from "./test-helpers.ts";

const KEY = "-----BEGIN OPENSSH PRIVATE KEY-----\nAAAA\n-----END OPENSSH PRIVATE KEY-----\n";
const FULL = { "sessions/state.sql": "SQL 1", "memories/MEMORY.md": "m1" };

function sidecarDeps(dir: string, url: string, settings: Partial<SidecarSettings> = {}) {
    const logs: string[] = [];
    const deps: SidecarDeps = {
        ...fakeClock(),
        settings: {
            memoryRepo: url,
            memoryKey: KEY,
            interval: 900,
            bundleMaxBytes: 1 << 24,
            allowEmpty: false,
            host: "test-host",
            ...settings,
        },
        paths: sidecarPaths(join(dir, "lib"), join(dir, "keys")),
        log: (message) => logs.push(message),
        gitEnv: GIT_ENV,
        retryForMs: 3_000,
    };
    return { deps, logs };
}

async function started(t: TestContext, url: string, settings: Partial<SidecarSettings> = {}, dir = tempDir(t)) {
    const { deps, logs } = sidecarDeps(dir, url, settings);
    const sidecar = new Sidecar(deps);
    await sidecar.start();
    return { dir, deps, logs, sidecar, paths: deps.paths };
}

function outbox(paths: SidecarPaths, generation: string, files: Record<string, string>): string {
    return writeBundle(paths.outbox, {
        version: 1,
        createdAt: new Date().toISOString(),
        generation,
        seed: false,
        files: Object.entries(files).map(([path, content]) => encodeFile(path, Buffer.from(content), 0o644)),
    });
}

const restoreOf = (paths: SidecarPaths) => readJson<Bundle>(paths.restore);
const statusOf = (paths: SidecarPaths) => readJson<{ lastError?: string; pushRejected: boolean; pendingCommits: number; sizeWarning: boolean; lastSuccessAt?: string }>(paths.status);
const remoteLog = (url: string, format: string) =>
    git(["--git-dir", url.slice("file://".length), "log", "-1", `--format=${format}`, "main"], tmpdir()).trim();

test("a first deployment seeds, and the first publish creates main", async (t) => {
    const url = bareRepo(t);
    const { sidecar, paths } = await started(t, url);
    assert.equal(restoreOf(paths)?.seed, true);
    assert.match(sidecar.generation, /^[0-9a-f]{32}$/);
    const hash = outbox(paths, sidecar.generation, FULL);
    await sidecar.cycle();
    assert.equal(remoteShow(url, "memories/MEMORY.md"), "m1");
    assert.equal(remoteLog(url, "%B"), "chore(sync): Snapshot from test-host\n\nChanged: sessions, memories.");
    const restore = restoreOf(paths);
    assert.equal(restore?.memorySha, remoteMain(url));
    assert.equal(restore?.bundleHash, hash);
    assert.equal(statusOf(paths)?.pendingCommits, 0);
    assert.ok(statusOf(paths)?.lastSuccessAt);
});

test("a head without state.sql fails startup", async (t) => {
    const url = bareRepo(t);
    pushFiles(t, url, { "README.md": "created with a readme" });
    await assert.rejects(started(t, url), /has no sessions\/state\.sql/);
});

test("restore.json follows an existing head and skips foreign files", async (t) => {
    const url = bareRepo(t);
    const head = pushFiles(t, url, { ...FULL, "README.md": "x", "skills/a/b/SKILL.md": "s" });
    const { paths } = await started(t, url);
    const restore = restoreOf(paths);
    assert.equal(restore?.memorySha, head);
    assert.deepEqual(restore?.files.map((f) => f.path), ["sessions/state.sql", "memories/MEMORY.md", "skills/a/b/SKILL.md"]);
});

test("no commit without changes", async (t) => {
    const url = bareRepo(t);
    const { sidecar, paths } = await started(t, url);
    outbox(paths, sidecar.generation, FULL);
    await sidecar.cycle();
    const head = remoteMain(url);
    outbox(paths, sidecar.generation, FULL);
    await sidecar.cycle();
    assert.equal(remoteMain(url), head);
});

test("deletions are mirrored", async (t) => {
    const url = bareRepo(t);
    const { sidecar, paths } = await started(t, url);
    outbox(paths, sidecar.generation, { ...FULL, "memories/OLD.md": "old", "cron/jobs.json": "{}" });
    await sidecar.cycle();
    outbox(paths, sidecar.generation, FULL);
    await sidecar.cycle();
    assert.equal(remoteShow(url, "memories/OLD.md"), null);
    assert.equal(remoteShow(url, "cron/jobs.json"), null);
    assert.match(remoteLog(url, "%b"), /memories, scheduled jobs/);
});

test("a bundle from another generation is ignored", async (t) => {
    const url = bareRepo(t);
    const { sidecar, paths, logs } = await started(t, url);
    outbox(paths, "f".repeat(32), FULL);
    await sidecar.cycle();
    assert.equal(remoteMain(url), null);
    assert.ok(logs.some((m) => m.includes("ignoring a bundle from generation")));
});

test("the empty-state guard refuses, and its override allows", async (t) => {
    const url = bareRepo(t);
    const { sidecar, paths, dir } = await started(t, url);
    outbox(paths, sidecar.generation, FULL);
    await sidecar.cycle();
    outbox(paths, sidecar.generation, { "sessions/state.sql": "SQL 2" });
    await sidecar.cycle();
    assert.match(statusOf(paths)?.lastError ?? "", /refusing a bundle without memories\/MEMORY\.md/);
    assert.equal(remoteShow(url, "memories/MEMORY.md"), "m1");
    const allowed = await started(t, url, { allowEmpty: true }, dir);
    await allowed.sidecar.cycle();
    assert.equal(remoteShow(url, "memories/MEMORY.md"), null);
});

test("a human edit is fast-forwarded and built on", async (t) => {
    const url = bareRepo(t);
    const { sidecar, paths } = await started(t, url);
    outbox(paths, sidecar.generation, FULL);
    await sidecar.cycle();
    const human = pushFiles(t, url, { "README.md": "hello" });
    outbox(paths, sidecar.generation, { ...FULL, "memories/MEMORY.md": "m2" });
    await sidecar.cycle();
    assert.equal(remoteLog(url, "%P"), human);
    assert.equal(remoteShow(url, "README.md"), "hello");
    assert.equal(remoteShow(url, "memories/MEMORY.md"), "m2");
});

test("unpushed commits survive an outage; a moved remote is never forced", async (t) => {
    const url = bareRepo(t);
    const bare = url.slice("file://".length);
    const { sidecar, paths, deps, dir } = await started(t, url);
    outbox(paths, sidecar.generation, FULL);
    await sidecar.cycle();
    renameSync(bare, `${bare}.away`);
    outbox(paths, sidecar.generation, { ...FULL, "memories/MEMORY.md": "m2" });
    await sidecar.cycle();
    assert.match(statusOf(paths)?.lastError ?? "", /push failed/);
    assert.equal(statusOf(paths)?.pendingCommits, 1);

    const restarted = await started(t, url, {}, dir);
    assert.equal(restoreOf(paths)?.files.find((f) => f.path === "memories/MEMORY.md")?.content, "m2");

    renameSync(`${bare}.away`, bare);
    const human = pushFiles(t, url, { "README.md": "moved" });
    await deps.sleep(3_600_000);
    await restarted.sidecar.cycle();
    assert.equal(statusOf(paths)?.pushRejected, true);
    assert.equal(remoteMain(url), human);
});

test("a refused bundle does not hold back an earlier commit's push", async (t) => {
    const url = bareRepo(t);
    const bare = url.slice("file://".length);
    const { sidecar, paths, deps } = await started(t, url);
    outbox(paths, sidecar.generation, FULL);
    await sidecar.cycle();
    renameSync(bare, `${bare}.away`);
    outbox(paths, sidecar.generation, { ...FULL, "memories/MEMORY.md": "m2" });
    await sidecar.cycle();
    assert.equal(statusOf(paths)?.pendingCommits, 1);
    // Without MEMORY.md, the empty-state guard refuses the next bundle.
    outbox(paths, sidecar.generation, { "sessions/state.sql": "SQL 2" });
    renameSync(`${bare}.away`, bare);
    await deps.sleep(3_600_000);
    await sidecar.cycle();
    assert.equal(statusOf(paths)?.pendingCommits, 0);
    assert.equal(remoteShow(url, "memories/MEMORY.md"), "m2");
    assert.match(statusOf(paths)?.lastError ?? "", /refusing a bundle without memories\/MEMORY\.md/);
});

test("a crash mid-mirror is undone at startup", async (t) => {
    const url = bareRepo(t);
    const { sidecar, paths, dir } = await started(t, url);
    outbox(paths, sidecar.generation, FULL);
    await sidecar.cycle();
    writeFileSync(join(paths.checkout, "memories/MEMORY.md"), "half");
    writeFileSync(join(paths.checkout, "memories/STRAY.md"), "stray");
    await started(t, url, {}, dir);
    const files = restoreOf(paths)?.files ?? [];
    assert.equal(files.find((f) => f.path === "memories/MEMORY.md")?.content, "m1");
    assert.equal(files.some((f) => f.path === "memories/STRAY.md"), false);
});

test("a stale index.lock is removed at startup", async (t) => {
    const url = bareRepo(t);
    const { paths, dir } = await started(t, url);
    writeFileSync(join(paths.checkout, ".git/index.lock"), "");
    const again = await started(t, url, {}, dir);
    outbox(paths, again.sidecar.generation, FULL);
    await again.sidecar.cycle();
    assert.equal(remoteShow(url, "memories/MEMORY.md"), "m1");
});

test("a fresh clone mints a new generation and refuses the old one's bundles", async (t) => {
    const url = bareRepo(t);
    const first = await started(t, url);
    rmSync(join(first.dir, "lib/state"), { recursive: true });
    const second = await started(t, url, {}, first.dir);
    assert.notEqual(second.sidecar.generation, first.sidecar.generation);
    outbox(second.paths, first.sidecar.generation, FULL);
    await second.sidecar.cycle();
    assert.equal(remoteMain(url), null);
});

test("a symlink committed to the memory repository is replaced, not followed", async (t) => {
    const url = bareRepo(t);
    const outside = tempDir(t);
    const work = join(tempDir(t), "work");
    git(["clone", "--quiet", url, work], tmpdir());
    git(["symbolic-ref", "HEAD", "refs/heads/main"], work);
    writeFiles(work, { "sessions/state.sql": "SQL 0" });
    symlinkSync(outside, join(work, "memories"));
    git(["add", "--all"], work);
    git(["commit", "--quiet", "-m", "symlink"], work);
    git(["push", "--quiet", "origin", "HEAD:refs/heads/main"], work);
    const { sidecar, paths } = await started(t, url);
    outbox(paths, sidecar.generation, FULL);
    await sidecar.cycle();
    assert.equal(existsSync(join(outside, "MEMORY.md")), false);
    assert.equal(remoteShow(url, "memories/MEMORY.md"), "m1");
});

test("large files warn and oversized files fail", async (t) => {
    const url = bareRepo(t);
    const dir = tempDir(t);
    const { deps } = sidecarDeps(dir, url);
    deps.limits = { warnBytes: 10, failBytes: 20 };
    const sidecar = new Sidecar(deps);
    await sidecar.start();
    outbox(deps.paths, sidecar.generation, { ...FULL, "sessions/state.sql": "x".repeat(15) });
    await sidecar.cycle();
    assert.equal(statusOf(deps.paths)?.sizeWarning, true);
    outbox(deps.paths, sidecar.generation, { ...FULL, "sessions/state.sql": "x".repeat(25) });
    await sidecar.cycle();
    assert.match(statusOf(deps.paths)?.lastError ?? "", /exceeds/);
});

test("a symlinked outbox is refused and nothing is published", async (t) => {
    const url = bareRepo(t);
    const { sidecar, paths } = await started(t, url);
    mkdirSync(join(paths.outbox, ".."), { recursive: true });
    symlinkSync(paths.key, paths.outbox);
    await sidecar.cycle();
    assert.match(statusOf(paths)?.lastError ?? "", /symbolic link/);
    assert.equal(remoteMain(url), null);
    assert.equal(readFileSync(paths.key, "utf8"), KEY);
});

test("commit messages name what changed", () => {
    assert.equal(
        commitMessage("srv", ["sessions/state.sql", "skills/a/b/SKILL.md", "cron/jobs.json"]),
        "chore(sync): Snapshot from srv\n\nChanged: sessions, skills, scheduled jobs.",
    );
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `mise exec -- node --test hermes/src/sidecar.test.ts`
Expected: FAIL, module not found.

- [ ] **Step 3: Implement `sidecar.ts`**

```ts
import { randomBytes } from "node:crypto";
import { existsSync, readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { type Bundle, type BundleFile, fileBytes, openBundle, validateBundle, validPath } from "./bundle.ts";
import { collectFile, collectTree, removeUnlisted, writeTreeFile } from "./files.ts";
import { Git } from "./git.ts";
import { type SidecarSettings, sidecarSettings } from "./settings.ts";
import { type SyncStatus, writeFileAtomic, writeJson } from "./status.ts";
import { type Clock, errorMessage, iso, type Log, logger, realClock, retry } from "./util.ts";

export interface SidecarPaths {
    checkout: string;
    generation: string;
    consumed: string;
    restore: string;
    status: string;
    outbox: string;
    key: string;
    knownHosts: string;
}

export function sidecarPaths(root = "/var/lib/dorothy", keyDir = "/tmp/dorothy"): SidecarPaths {
    return {
        checkout: join(root, "state/memory"),
        generation: join(root, "state/generation"),
        consumed: join(root, "state/consumed"),
        restore: join(root, "restore/restore.json"),
        status: join(root, "restore/status.json"),
        outbox: join(root, "outbox/bundle.json"),
        key: join(keyDir, "memory.key"),
        knownHosts: "/opt/dorothy/known_hosts",
    };
}

export const SIZE_LIMITS = { warnBytes: 80 * 1024 * 1024, failBytes: 95 * 1024 * 1024 };
export const PUBLISH_EVERY_MS = 30_000;

export interface SidecarDeps extends Clock {
    settings: SidecarSettings;
    paths: SidecarPaths;
    log: Log;
    gitEnv?: NodeJS.ProcessEnv;
    retryForMs?: number;
    limits?: typeof SIZE_LIMITS;
}

const AREAS: [string, string][] = [
    ["sessions/", "sessions"],
    ["memories/", "memories"],
    ["skills/", "skills"],
    ["cron/", "scheduled jobs"],
];

export function commitMessage(host: string, changed: string[]): string {
    const areas = AREAS.filter(([prefix]) => changed.some((path) => path.startsWith(prefix))).map(([, name]) => name);
    return `chore(sync): Snapshot from ${host}\n\nChanged: ${areas.join(", ")}.`;
}

/** Makes the checkout's synced trees match the bundle exactly. */
export function mirror(root: string, files: BundleFile[]): void {
    const listed = new Set(files.map((file) => file.path));
    for (const top of ["memories", "skills", "cron"]) removeUnlisted(root, top, listed);
    for (const file of files) writeTreeFile(root, file);
}

function readTrimmed(path: string): string | null {
    try {
        return readFileSync(path, "utf8").trim() || null;
    } catch {
        return null;
    }
}

export class Sidecar {
    readonly status: SyncStatus;
    readonly #deps: SidecarDeps;
    readonly #git: Git;
    #generation = "";
    #consumed: string | null = null;
    #ignoredHash: string | null = null;
    #pushRejected = false;
    #nextPushAt = 0;
    #pushDelayMs = PUBLISH_EVERY_MS;

    constructor(deps: SidecarDeps) {
        this.#deps = deps;
        this.#git = new Git(deps.paths.checkout, {
            keyPath: deps.paths.key,
            knownHostsPath: deps.paths.knownHosts,
            env: deps.gitEnv,
        });
        this.status = {
            startedAt: iso(deps.now()),
            pendingCommits: 0,
            pushRejected: false,
            largestFileBytes: 0,
            sizeWarning: false,
        };
        this.#save();
    }

    get generation(): string {
        return this.#generation;
    }

    async start(): Promise<void> {
        const { paths, settings, log } = this.#deps;
        writeFileAtomic(paths.key, settings.memoryKey, 0o600);
        rmSync(join(paths.checkout, ".git/index.lock"), { force: true });
        if (existsSync(join(paths.checkout, ".git"))) {
            // A crash mid-mirror leaves a half-written tree that restore.json
            // must not serve. Nothing is lost: consumed is recorded only after
            // the commit, so the outbox bundle is mirrored again.
            if ((await this.#git.head()) !== null) await this.#git.resetHard("HEAD");
            await this.#git.clean();
            await this.#git.setRemote(settings.memoryRepo);
            this.#generation = readTrimmed(paths.generation) ?? this.#mint();
            this.#consumed = readTrimmed(paths.consumed);
            try {
                await this.#git.fetch();
                await this.#fastForward();
            } catch (error) {
                log(`GitHub unreachable, continuing from the local head: ${errorMessage(error)}`);
            }
        } else {
            await retry(
                "clone dorothy-memory",
                async () => {
                    rmSync(paths.checkout, { recursive: true, force: true });
                    await this.#git.clone(settings.memoryRepo);
                },
                { ...this.#deps, forMs: this.#deps.retryForMs ?? 300_000 },
            );
            this.#mint();
            this.#consumed = null;
            rmSync(paths.consumed, { force: true });
        }
        await this.#writeRestore();
        this.status.restoreWrittenAt = iso(this.#deps.now());
        this.#save();
        log(`ready with generation ${this.#generation}`);
    }

    /** One publish attempt and one push attempt; never throws. */
    async cycle(): Promise<void> {
        this.status.loopAt = iso(this.#deps.now());
        this.#save();
        // Separate attempts: a refused bundle must not hold back earlier commits.
        const errors: string[] = [];
        for (const [step, attempt] of [
            ["publish", () => this.#publish()],
            ["push", () => this.#pushIfDue()],
        ] as const) {
            try {
                await attempt();
            } catch (error) {
                errors.push(`${step} failed: ${errorMessage(error)}`);
            }
        }
        const failed = errors.length > 0;
        if (failed) {
            const lastError = errors.join("; ");
            // A refused bundle is read again every cycle; log it once.
            if (lastError !== this.status.lastError) this.#deps.log(lastError);
            this.status.lastError = lastError;
        }
        try {
            this.status.pendingCommits = await this.#git.unpushed();
        } catch {}
        this.status.pushRejected = this.#pushRejected;
        if (!failed && this.status.pendingCommits === 0) {
            this.status.lastSuccessAt = iso(this.#deps.now());
            delete this.status.lastError;
        }
        this.#save();
    }

    #mint(): string {
        this.#generation = randomBytes(16).toString("hex");
        writeFileAtomic(this.#deps.paths.generation, this.#generation);
        return this.#generation;
    }

    #save(): void {
        writeJson(this.#deps.paths.status, this.status);
    }

    async #fastForward(): Promise<void> {
        const head = await this.#git.head();
        const remote = await this.#git.remoteHead();
        if (remote === null || head === remote) return;
        if (head === null || (await this.#git.isAncestor(head, remote))) {
            await this.#git.resetHard(remote);
            this.#deps.log(`fast-forwarded to ${remote}`);
            return;
        }
        if (await this.#git.isAncestor(remote, head)) return;
        this.#pushRejected = true;
        this.#deps.log("local and remote histories have diverged; pushing stops until a person resolves it");
    }

    async #writeRestore(): Promise<void> {
        const { paths } = this.#deps;
        const head = await this.#git.head();
        const base = { version: 1 as const, createdAt: iso(this.#deps.now()), generation: this.#generation };
        if (head === null) {
            writeJson(paths.restore, { ...base, seed: true, files: [] });
            return;
        }
        const state = collectFile(paths.checkout, "sessions/state.sql");
        if (!state) throw new Error(`dorothy-memory ${head} has no sessions/state.sql`);
        const jobs = collectFile(paths.checkout, "cron/jobs.json");
        const files = [
            state,
            ...(jobs ? [jobs] : []),
            ...collectTree(paths.checkout, "memories"),
            ...collectTree(paths.checkout, "skills"),
        ].filter((file) => validPath(file.path));
        const bundle: Bundle = {
            ...base,
            memorySha: head,
            ...(this.#consumed ? { bundleHash: this.#consumed } : {}),
            seed: false,
            files,
        };
        writeJson(paths.restore, validateBundle(bundle));
    }

    #guardEmpty(bundle: Bundle): void {
        if (this.#deps.settings.allowEmpty) return;
        for (const required of ["sessions/state.sql", "memories/MEMORY.md"]) {
            const present = existsSync(join(this.#deps.paths.checkout, required));
            if (present && !bundle.files.some((file) => file.path === required)) {
                throw new Error(`refusing a bundle without ${required} (DOROTHY_ALLOW_EMPTY=1 allows it)`);
            }
        }
    }

    async #publish(): Promise<void> {
        const { paths, settings, log } = this.#deps;
        const opened = openBundle(paths.outbox, settings.bundleMaxBytes);
        if (opened === null || opened.hash === this.#consumed) return;
        const { bundle, hash } = opened;
        if (bundle.generation !== this.#generation) {
            if (this.#ignoredHash !== hash) log(`ignoring a bundle from generation ${bundle.generation}`);
            this.#ignoredHash = hash;
            return;
        }
        if (bundle.seed) throw new Error("the outbox holds a seed bundle");
        const limits = this.#deps.limits ?? SIZE_LIMITS;
        const largest = Math.max(0, ...bundle.files.map((file) => fileBytes(file).length));
        if (largest > limits.failBytes) {
            throw new Error(`a ${largest}-byte file exceeds the ${limits.failBytes}-byte limit`);
        }
        this.status.largestFileBytes = largest;
        this.status.sizeWarning = largest > limits.warnBytes;
        this.#guardEmpty(bundle);
        try {
            await this.#git.fetch();
            if ((await this.#git.unpushed()) === 0) await this.#fastForward();
        } catch (error) {
            log(`fetch failed; committing locally: ${errorMessage(error)}`);
        }
        mirror(paths.checkout, bundle.files);
        await this.#git.addAll();
        const changed = await this.#git.stagedPaths();
        if (changed.length > 0) {
            await this.#git.commit(commitMessage(settings.host, changed));
            log(`committed ${changed.length} changed file(s)`);
        }
        this.#consumed = hash;
        writeFileAtomic(paths.consumed, hash);
        this.status.lastBundleAt = bundle.createdAt;
        await this.#writeRestore();
        this.#nextPushAt = 0;
    }

    async #pushIfDue(): Promise<void> {
        if (this.#pushRejected) return;
        if ((await this.#git.unpushed()) === 0) {
            this.#pushDelayMs = PUBLISH_EVERY_MS;
            return;
        }
        if (this.#deps.now() < this.#nextPushAt) return;
        const result = await this.#git.push();
        if (result === "pushed") {
            this.#pushDelayMs = PUBLISH_EVERY_MS;
            this.#nextPushAt = 0;
            this.#deps.log("pushed");
            return;
        }
        if (result === "rejected") {
            this.#pushRejected = true;
            this.#deps.log("push rejected: the remote moved while commits were unpushed; pushing stops until a person resolves it");
            return;
        }
        this.#nextPushAt = this.#deps.now() + this.#pushDelayMs;
        this.#pushDelayMs = Math.min(this.#pushDelayMs * 2, this.#deps.settings.interval * 1000);
        throw new Error("push failed; the commit stays local and is retried");
    }
}

export async function runSidecar(deps: SidecarDeps, signal: AbortSignal): Promise<void> {
    const sidecar = new Sidecar(deps);
    await sidecar.start();
    while (!signal.aborted) {
        await sidecar.cycle();
        await delay(PUBLISH_EVERY_MS, undefined, { signal }).catch(() => undefined);
    }
    deps.log("stopping: publishing once more");
    await sidecar.cycle();
}

if (import.meta.main) {
    const log = logger("dorothy-sync");
    const controller = new AbortController();
    process.once("SIGTERM", () => controller.abort());
    process.once("SIGINT", () => controller.abort());
    try {
        const deps: SidecarDeps = { ...realClock, settings: sidecarSettings(process.env), paths: sidecarPaths(), log };
        runSidecar(deps, controller.signal)
            .then(() => process.exit(0))
            .catch((error: unknown) => {
                log(`failed: ${errorMessage(error)}`);
                process.exit(1);
            });
    } catch (error) {
        log(`failed: ${errorMessage(error)}`);
        process.exit(1);
    }
}
```

`delete this.status.lastError` is the one `delete` in the codebase; if Biome
flags it (`noDelete`), assign `undefined` instead, which `JSON.stringify`
drops.

- [ ] **Step 4: Run the tests**

Run: `mise exec -- node --test hermes/src/sidecar.test.ts`
Expected: 17 pass.

- [ ] **Step 5: Commit**

```bash
bunx biome check --write hermes/src && bun run typecheck
git add hermes/src/sidecar.ts hermes/src/sidecar.test.ts
git commit -m "feat: Publish bundles from the sync sidecar"
```

---

### Task 15: Health checks, s6 stubs and the compose stack

**Files:**

- Create: `hermes/src/health.ts`, `hermes/src/sidecar-health.ts`,
  `hermes/src/health.test.ts`, `hermes/known_hosts`,
  `hermes/cont-init.d/005-dorothy-bootstrap`,
  `hermes/cont-finish.d/dorothy-final-snapshot`,
  `hermes/s6-rc.d/dorothy-snapshot/{run,type,dependencies.d/base}`,
  `hermes/s6-rc.d/user/contents.d/dorothy-snapshot`, `compose.yaml`

**Interfaces:**

- Consumes: `ContainerPaths`, `HermesCli` (Task 10); `sidecarPaths`
  (Task 14); `syncInterval` (Task 4); status types (Task 3).
- Produces: `hermesHealth(deps: { env: Env; paths: ContainerPaths; hermes: HermesCli; now(): number }): Promise<string[]>`;
  `sidecarHealth(status: SyncStatus | null, intervalSeconds: number, now: number): string[]`.
  Each entry exits 1 and prints the problems when the list is non-empty.

- [ ] **Step 1: Write the failing health tests**

`hermes/src/health.test.ts`:

```ts
import assert from "node:assert/strict";
import { rmSync } from "node:fs";
import { join } from "node:path";
import { type TestContext, test } from "node:test";
import { hermesHealth } from "./health.ts";
import type { ContainerPaths } from "./hermes.ts";
import { sidecarHealth } from "./sidecar-health.ts";
import { writeJson } from "./status.ts";
import { fakeHermes, tempDir, writeFiles } from "./test-helpers.ts";

const NOW = Date.parse("2026-10-03T12:00:00.000Z");
const ago = (minutes: number) => new Date(NOW - minutes * 60_000).toISOString();

function healthy(t: TestContext): ContainerPaths {
    const dir = tempDir(t);
    const paths: ContainerPaths = {
        home: join(dir, "data"),
        run: join(dir, "run"),
        restore: join(dir, "restore/restore.json"),
        syncStatus: join(dir, "restore/status.json"),
        outbox: join(dir, "outbox/bundle.json"),
        knownHosts: join(dir, "known_hosts"),
    };
    writeFiles(paths.home, { "dorothy/restored": "{}" });
    writeFiles(paths.run, { booted: ago(120) });
    writeJson(join(paths.home, "dorothy/status/snapshot.json"), { lastSuccessAt: ago(10) });
    writeJson(paths.syncStatus, {
        startedAt: ago(120),
        lastSuccessAt: ago(1),
        pendingCommits: 0,
        pushRejected: false,
        largestFileBytes: 1,
        sizeWarning: false,
    });
    return paths;
}

const check = (paths: ContainerPaths, up = true) =>
    hermesHealth({
        env: {},
        paths,
        hermes: fakeHermes({ status: () => (up ? { up: true, pid: 1 } : { up: false, pid: null }) }),
        now: () => NOW,
    });

test("a healthy container reports nothing", async (t) => {
    assert.deepEqual(await check(healthy(t)), []);
});

test("each failure is reported", async (t) => {
    const paths = healthy(t);
    writeJson(join(paths.home, "dorothy/status/apply.json"), { configRolledBack: true });
    writeJson(join(paths.home, "dorothy/status/snapshot.json"), { lastSuccessAt: ago(60) });
    writeJson(paths.syncStatus, {
        startedAt: ago(120),
        lastSuccessAt: ago(60),
        pendingCommits: 2,
        pushRejected: true,
        largestFileBytes: 90_000_000,
        sizeWarning: true,
    });
    assert.deepEqual(await check(paths, false), [
        "no successful snapshot in three intervals",
        "a config push was rolled back",
        "the gateway is down",
        "the sidecar's push was rejected",
        "a synced file is over 80 MB",
        "no successful publish in three intervals",
    ]);
});

test("a fresh boot is not blamed for missing snapshots", async (t) => {
    const paths = healthy(t);
    writeFiles(paths.run, { booted: ago(5) });
    writeJson(join(paths.home, "dorothy/status/snapshot.json"), { lastSuccessAt: ago(600) });
    assert.deepEqual(await check(paths), []);
});

test("a missing restore marker is unhealthy", async (t) => {
    const paths = healthy(t);
    rmSync(join(paths.home, "dorothy/restored"));
    assert.deepEqual(await check(paths), ["not restored yet"]);
});

test("the sidecar is healthy only after this run's restore.json", () => {
    const base = { startedAt: ago(2), pendingCommits: 0, pushRejected: false, largestFileBytes: 0, sizeWarning: false };
    assert.deepEqual(sidecarHealth(null, 900, NOW), ["no status"]);
    assert.deepEqual(sidecarHealth(base, 900, NOW), ["restore.json not written by this run"]);
    assert.deepEqual(sidecarHealth({ ...base, restoreWrittenAt: ago(1), loopAt: ago(1) }, 900, NOW), []);
    assert.deepEqual(sidecarHealth({ ...base, restoreWrittenAt: ago(1), loopAt: ago(30) }, 900, NOW), [
        "the publish loop has stalled",
    ]);
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `mise exec -- node --test hermes/src/health.test.ts`
Expected: FAIL, modules not found.

- [ ] **Step 3: Implement `health.ts` and `sidecar-health.ts`**

`hermes/src/health.ts`:

```ts
import { existsSync } from "node:fs";
import { join } from "node:path";
import { type ContainerPaths, createHermesCli, type HermesCli, IMAGE_CONTAINER_PATHS } from "./hermes.ts";
import { type Env, syncInterval } from "./settings.ts";
import { type ApplyStatus, readJson, readText, type SnapshotStatus, type SyncStatus } from "./status.ts";

export interface HealthDeps {
    env: Env;
    paths: ContainerPaths;
    hermes: HermesCli;
    now(): number;
}

/** Status files here are agent-writable: an operational signal, not a control (S13). */
function readSafe<T>(path: string): T | null {
    try {
        return readJson<T>(path);
    } catch {
        return null;
    }
}

export async function hermesHealth(deps: HealthDeps): Promise<string[]> {
    const { home, run } = deps.paths;
    const age = (time: string | undefined): number =>
        time ? deps.now() - Date.parse(time) : Number.POSITIVE_INFINITY;
    const limit = 3 * syncInterval(deps.env) * 1000;
    const uptime = age(readText(join(run, "booted")).trim() || undefined);
    const problems: string[] = [];
    if (!existsSync(join(home, "dorothy/restored"))) problems.push("not restored yet");
    const snapshot = readSafe<SnapshotStatus>(join(home, "dorothy/status/snapshot.json"));
    if (age(snapshot?.lastSuccessAt) > limit && uptime > limit) {
        problems.push("no successful snapshot in three intervals");
    }
    if (readSafe<ApplyStatus>(join(home, "dorothy/status/apply.json"))?.configRolledBack) {
        problems.push("a config push was rolled back");
    }
    if (!(await deps.hermes.gatewayStatus())?.up) problems.push("the gateway is down");
    const sync = readSafe<SyncStatus>(deps.paths.syncStatus);
    if (sync === null) {
        problems.push("no sidecar status");
    } else {
        if (sync.pushRejected) problems.push("the sidecar's push was rejected");
        if (sync.sizeWarning) problems.push("a synced file is over 80 MB");
        if (age(sync.lastSuccessAt) > limit && age(sync.startedAt) > limit) {
            problems.push("no successful publish in three intervals");
        }
    }
    return problems;
}

if (import.meta.main) {
    hermesHealth({ env: process.env, paths: IMAGE_CONTAINER_PATHS, hermes: createHermesCli(), now: Date.now }).then(
        (problems) => {
            if (problems.length > 0) {
                console.error(problems.join("; "));
                process.exitCode = 1;
            }
        },
        (error: unknown) => {
            console.error(String(error));
            process.exitCode = 1;
        },
    );
}
```

`hermes/src/sidecar-health.ts`:

```ts
import { syncInterval } from "./settings.ts";
import { sidecarPaths } from "./sidecar.ts";
import { readJson, type SyncStatus } from "./status.ts";

/** Healthy once this run has written restore.json and while its loop turns. */
export function sidecarHealth(status: SyncStatus | null, intervalSeconds: number, now: number): string[] {
    if (status === null) return ["no status"];
    const started = Date.parse(status.startedAt);
    if (!status.restoreWrittenAt || Date.parse(status.restoreWrittenAt) < started) {
        return ["restore.json not written by this run"];
    }
    if (!status.loopAt || now - Date.parse(status.loopAt) > intervalSeconds * 1000 + 120_000) {
        return ["the publish loop has stalled"];
    }
    return [];
}

if (import.meta.main) {
    let problems: string[];
    try {
        problems = sidecarHealth(readJson<SyncStatus>(sidecarPaths().status), syncInterval(process.env), Date.now());
    } catch (error) {
        problems = [String(error)];
    }
    if (problems.length > 0) {
        console.error(problems.join("; "));
        process.exitCode = 1;
    }
}
```

Importing `sidecar.ts` from the health entry is safe: its `import.meta.main`
block does not run on import.

- [ ] **Step 4: Run the tests**

Run: `mise exec -- node --test hermes/src/health.test.ts`
Expected: 5 pass. Then `mise run test`: every suite passes.

- [ ] **Step 5: Commit the health checks**

```bash
bunx biome check --write hermes/src && bun run typecheck
git add hermes/src/health.ts hermes/src/sidecar-health.ts hermes/src/health.test.ts
git commit -m "feat: Add health checks for hermes and the sidecar"
```

- [ ] **Step 6: Pin GitHub's SSH host keys**

```bash
gh api meta --jq '.ssh_keys[]' | sed 's/^/github.com /' > hermes/known_hosts
ssh-keygen -lf hermes/known_hosts
```

Expected: three fingerprints matching
<https://docs.github.com/en/authentication/keeping-your-account-and-data-secure/githubs-ssh-key-fingerprints>
(SHA256 `uNiVztksCsDhcc0u9e8BujQXVUpKZIDTMczCvj3tD2s` for Ed25519). Stop if
they differ.

- [ ] **Step 7: Write the s6 stubs**

`hermes/cont-init.d/005-dorothy-bootstrap`:

```sh
#!/command/with-contenv sh
# shellcheck shell=sh
# SPDX-License-Identifier: GPL-3.0-only
# Sorts before upstream's 01-hermes-setup, so it finds our SOUL.md and
# config.yaml in place. A failure stops the container
# (S6_BEHAVIOUR_IF_STAGE2_FAILS=2). Absolute paths: upstream puts the
# agent-writable /opt/data/.local/bin on PATH.
set -eu
export HOME=/opt/data
/bin/mkdir -p /run/dorothy
/bin/chown hermes:hermes /run/dorothy
/bin/chmod 0700 /run/dorothy
exec /command/s6-setuidgid hermes /usr/local/bin/node /opt/dorothy/src/bootstrap.ts
```

`hermes/cont-finish.d/dorothy-final-snapshot`:

```sh
#!/command/with-contenv sh
# shellcheck shell=sh
# SPDX-License-Identifier: GPL-3.0-only
# One last bundle at shutdown; dorothy-sync publishes it on its way out.
export HOME=/opt/data
exec /command/s6-setuidgid hermes /usr/local/bin/node /opt/dorothy/src/snapshot.ts --final
```

`hermes/s6-rc.d/dorothy-snapshot/run`:

```sh
#!/command/with-contenv sh
# shellcheck shell=sh
# SPDX-License-Identifier: GPL-3.0-only
# Boot check, then a snapshot every DOROTHY_SYNC_INTERVAL seconds.
export HOME=/opt/data
exec /command/s6-setuidgid hermes /usr/local/bin/node /opt/dorothy/src/snapshot.ts
```

`hermes/s6-rc.d/dorothy-snapshot/type` contains the single line `longrun`.
`hermes/s6-rc.d/dorothy-snapshot/dependencies.d/base` and
`hermes/s6-rc.d/user/contents.d/dorothy-snapshot` are empty files.

```bash
chmod 0755 hermes/cont-init.d/005-dorothy-bootstrap hermes/cont-finish.d/dorothy-final-snapshot hermes/s6-rc.d/dorothy-snapshot/run
```

- [ ] **Step 8: Write `compose.yaml`**

Replace the `cap_add` list on `hermes` with Task 1's minimal list, and the
image reference with Task 1's confirmed one (all three occurrences).

```yaml
# vim:set expandtab shiftwidth=4 filetype=yaml foldlevel=3:
# SPDX-License-Identifier: GPL-3.0-only

#
#
# ~chewygumxx/dorothy-hermes.git
# ::: :/compose.yaml
#
#

# Dorothy: the unmodified upstream image, run three ways. See
# docs/specs/2026-10-03-hermes-deployment-design.md (Compose stack) and
# docs/specs/2026-10-03-hermes-security-design.md (S1, S3, S9, S10).
# cloudflared and the webhook arrive with plan 3.

name: dorothy

x-hardening: &hardening
    security_opt:
        - no-new-privileges:true
    cap_drop:
        - ALL

services:
    # Hands the three dorothy-* volume roots to UID 10000; not recursive.
    dorothy-init:
        <<: *hardening
        image: nousresearch/hermes-agent:v2026.9.24@sha256:fca358f12efd65bfaaca05884166f15c0e2788375ca30d77061ac1ebc96452b7
        user: "0:0"
        entrypoint: ["/bin/chown", "10000:10000", "/v/outbox", "/v/restore", "/v/state"]
        cap_add:
            - CHOWN
        read_only: true
        network_mode: none
        restart: "no"
        tmpfs:
            - /opt/data
        volumes:
            - dorothy-outbox:/v/outbox
            - dorothy-restore:/v/restore
            - dorothy-state:/v/state

    # Trusted: the only holder of the memory deploy key (S1).
    dorothy-sync:
        <<: *hardening
        image: nousresearch/hermes-agent:v2026.9.24@sha256:fca358f12efd65bfaaca05884166f15c0e2788375ca30d77061ac1ebc96452b7
        entrypoint: ["/usr/local/bin/node", "/opt/dorothy/src/sidecar.ts"]
        init: true
        user: "10000:10000"
        read_only: true
        hostname: dorothy-sync
        tmpfs:
            - /tmp
            - /opt/data:uid=10000,gid=10000,mode=0700
        environment:
            DOROTHY_MEMORY_DEPLOY_KEY: ${DOROTHY_MEMORY_DEPLOY_KEY:?set it in .env}
            DOROTHY_MEMORY_REPO: ${DOROTHY_MEMORY_REPO:-git@github.com:chewygumxx/dorothy-memory.git}
            DOROTHY_SYNC_INTERVAL: ${DOROTHY_SYNC_INTERVAL:-900}
            DOROTHY_BUNDLE_MAX_BYTES: ${DOROTHY_BUNDLE_MAX_BYTES:-268435456}
            DOROTHY_ALLOW_EMPTY: ${DOROTHY_ALLOW_EMPTY:-}
            DOROTHY_HOST: ${DOROTHY_HOST:-unknown}
            PATH: /usr/local/bin:/usr/bin:/bin
            HOME: /opt/data
            GIT_CONFIG_GLOBAL: /dev/null
            GIT_CONFIG_NOSYSTEM: "1"
        volumes:
            - ./hermes/src:/opt/dorothy/src:ro
            - ./hermes/known_hosts:/opt/dorothy/known_hosts:ro
            - dorothy-outbox:/var/lib/dorothy/outbox:ro
            - dorothy-restore:/var/lib/dorothy/restore
            - dorothy-state:/var/lib/dorothy/state
        networks:
            - sync
        depends_on:
            dorothy-init:
                condition: service_completed_successfully
        pids_limit: 128
        mem_limit: 1g
        stop_grace_period: 60s
        restart: unless-stopped
        healthcheck:
            test: ["CMD", "/usr/local/bin/node", "/opt/dorothy/src/sidecar-health.ts"]
            interval: 30s
            timeout: 10s
            retries: 3
            start_period: 6m
            start_interval: 5s

    # Untrusted: the agent can become root in here (S4).
    hermes:
        <<: *hardening
        image: nousresearch/hermes-agent:v2026.9.24@sha256:fca358f12efd65bfaaca05884166f15c0e2788375ca30d77061ac1ebc96452b7
        command: ["gateway", "run"]
        hostname: dorothy
        cap_add:
            - CHOWN
            - DAC_OVERRIDE
            - FOWNER
            - SETUID
            - SETGID
            - KILL
        tmpfs:
            - /run:exec
        pids_limit: 512
        mem_limit: 4g
        environment:
            S6_BEHAVIOUR_IF_STAGE2_FAILS: "2"
            S6_KILL_FINISH_MAXTIME: "60000"
            DOROTHY_CONFIG_REPO: ${DOROTHY_CONFIG_REPO:-git@github.com:chewygumxx/dorothy-config.git}
            DOROTHY_CONFIG_REPO_NAME: ${DOROTHY_CONFIG_REPO_NAME:-}
            DOROTHY_CONFIG_DEPLOY_KEY: ${DOROTHY_CONFIG_DEPLOY_KEY:?set it in .env}
            DOROTHY_SYNC_INTERVAL: ${DOROTHY_SYNC_INTERVAL:-900}
            ANTHROPIC_API_KEY: ${ANTHROPIC_API_KEY:-}
            CLAUDE_CODE_OAUTH_TOKEN: ${CLAUDE_CODE_OAUTH_TOKEN:-}
            TELEGRAM_BOT_TOKEN: ${TELEGRAM_BOT_TOKEN:-}
            TELEGRAM_ALLOWED_USERS: ${TELEGRAM_ALLOWED_USERS:-}
        volumes:
            - hermes-data:/opt/data
            - dorothy-outbox:/var/lib/dorothy/outbox
            - dorothy-restore:/var/lib/dorothy/restore:ro
            - ./hermes/src:/opt/dorothy/src:ro
            - ./hermes/known_hosts:/opt/dorothy/known_hosts:ro
            - ./hermes/cont-init.d/005-dorothy-bootstrap:/etc/cont-init.d/005-dorothy-bootstrap:ro
            - ./hermes/cont-finish.d/dorothy-final-snapshot:/etc/cont-finish.d/dorothy-final-snapshot:ro
            - ./hermes/s6-rc.d/dorothy-snapshot:/etc/s6-overlay/s6-rc.d/dorothy-snapshot:ro
            - ./hermes/s6-rc.d/user/contents.d/dorothy-snapshot:/etc/s6-overlay/s6-rc.d/user/contents.d/dorothy-snapshot:ro
        networks:
            - edge
        depends_on:
            dorothy-sync:
                condition: service_healthy
        stop_grace_period: 90s
        restart: unless-stopped
        healthcheck:
            test: ["CMD", "/command/s6-setuidgid", "hermes", "/usr/local/bin/node", "/opt/dorothy/src/health.ts"]
            interval: 60s
            timeout: 20s
            retries: 3
            start_period: 6m
            start_interval: 10s

volumes:
    hermes-data: {}
    dorothy-outbox: {}
    dorothy-restore: {}
    dorothy-state: {}

networks:
    edge: {}
    sync: {}
```

The platform variables are the Telegram pair; for another platform, list its
token and allowlist variables from `hermes/src/platforms.json` instead.

- [ ] **Step 9: Validate and commit**

```bash
DOROTHY_MEMORY_DEPLOY_KEY=x DOROTHY_CONFIG_DEPLOY_KEY=x docker compose config --quiet
bun run lint:yaml
git add hermes/known_hosts hermes/cont-init.d hermes/cont-finish.d hermes/s6-rc.d compose.yaml
git commit -m "feat: Add the compose stack and s6 stubs"
```

Expected: `compose config` prints nothing and exits 0; lint passes.

---

### Task 16: Smoke test

**Files:**

- Create: `smoke/run.sh`, `smoke/compose.smoke.yaml`,
  `smoke/make-fixture.sh`, `smoke/fixture-session.jsonl`,
  `smoke/dump-fixture.mts`, `smoke/restore-check.mts`, `smoke/search.py`,
  `smoke/fixtures/memory/memories/MEMORY.md`,
  `smoke/fixtures/memory/memories/USER.md`,
  `smoke/fixtures/memory/skills/smoke/hello/SKILL.md`,
  `smoke/fixtures/memory/sessions/state.sql` (generated)
- Modify: `.github/workflows/ci.yaml` (`smoke` job)

**Interfaces:**

- Consumes: the whole stack; `restoreDatabase`, `dumpDatabase`,
  `checkTables` (Task 6); `smoke/fixtures/config*` (Task 1).
- Produces: `mise run smoke`, exiting 0 only when deployment smoke steps 1, 2,
  4 and 5, step 3 through the fallback apply, and security additions 1 to 7
  all pass.

- [ ] **Step 1: Write the memory fixture sources**

`smoke/fixtures/memory/memories/MEMORY.md`:

```markdown
# Memory

The smoke fixture remembers the zebracorn.
```

`smoke/fixtures/memory/memories/USER.md`:

```markdown
# User

A smoke test, not a person.
```

`smoke/fixtures/memory/skills/smoke/hello/SKILL.md`:

```markdown
---
name: hello
description: Says hello. A smoke-test fixture skill.
---

Say hello.
```

`smoke/fixture-session.jsonl` (one Claude Code session; the token is fake and
deliberately not shaped like any provider's key):

```json
{"type":"user","sessionId":"dorothy-fixture-1","cwd":"/opt/data","message":{"role":"user","content":"Remember the zebracorn hint and the token dorothy-fake-token-0123456789abcdef"}}
{"type":"assistant","sessionId":"dorothy-fixture-1","message":{"role":"assistant","content":[{"type":"text","text":"Noted the zebracorn hint."}]}}
{"type":"user","sessionId":"dorothy-fixture-1","message":{"role":"user","content":"東京の天気はどうですか"}}
{"type":"assistant","sessionId":"dorothy-fixture-1","message":{"role":"assistant","content":"東京は晴れです"}}
```

- [ ] **Step 2: Write the fixture generator**

`smoke/dump-fixture.mts`:

```ts
// Runs inside an older image: dumps the newest *-fixture snapshot's state.db.
import { readdirSync } from "node:fs";
import { join } from "node:path";
import { checkTables, dumpDatabase } from "/opt/dorothy/src/dump.ts";

const home = process.argv[2] ?? "/work/home";
const snapshots = join(home, "state-snapshots");
const latest = readdirSync(snapshots).filter((name) => name.endsWith("-fixture")).sort().at(-1);
if (!latest) throw new Error(`no fixture snapshot in ${snapshots}`);
const db = join(snapshots, latest, "state.db");
checkTables(db);
process.stdout.write(dumpDatabase(db));
```

`smoke/make-fixture.sh`:

```sh
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
chmod 0777 "$work"
trap 'docker run --rm -v "$work:/work" --entrypoint /bin/rm "$image" -rf /work/home; rm -rf "$work"' EXIT

run() {
    docker run --rm -u 10000:10000 -e HERMES_HOME=/work/home -e HOME=/work \
        -v "$work:/work" -v "$root/smoke:/smoke:ro" -v "$root/hermes/src:/opt/dorothy/src:ro" "$@"
}

run --entrypoint /opt/hermes/bin/hermes "$image" sessions import --from claude /smoke/fixture-session.jsonl
run --entrypoint /opt/hermes/bin/hermes "$image" backup --quick --label fixture
run --entrypoint /usr/local/bin/node "$image" /smoke/dump-fixture.mts /work/home \
    > "$root/smoke/fixtures/memory/sessions/state.sql"
echo "wrote smoke/fixtures/memory/sessions/state.sql from $image"
```

Run it:

```bash
mkdir -p smoke/fixtures/memory/sessions
chmod 0755 smoke/make-fixture.sh && sh smoke/make-fixture.sh
grep -c 'zebracorn' smoke/fixtures/memory/sessions/state.sql
grep -c 'dorothy-fake-token-0123456789abcdef' smoke/fixtures/memory/sessions/state.sql
```

Expected: both counts at least 1. If the older image lacks Node 26 type
stripping or `sessions import`, use the oldest calver tag that has both and
record it in the script's default.

- [ ] **Step 3: Write the in-container and host check helpers**

`smoke/search.py`:

```python
# SPDX-License-Identifier: GPL-3.0-only
"""Exit 1 unless Hermes's session search finds every argument."""

import sys

sys.path.insert(0, "/opt/hermes")

from hermes_state import SessionDB  # noqa: E402

db = SessionDB()
missing = [query for query in sys.argv[1:] if not db.search_messages(query)]
if missing:
    print("missing:", ", ".join(missing))
    sys.exit(1)
print("found:", ", ".join(sys.argv[1:]))
```

`smoke/restore-check.mts`:

```ts
// Restores a published state.sql and checks that each needle survived.
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { restoreDatabase } from "../hermes/src/dump.ts";

const [sqlPath, ...needles] = process.argv.slice(2);
if (!sqlPath) throw new Error("usage: restore-check.mts <state.sql> <needle>...");
const path = join(mkdtempSync(join(tmpdir(), "dorothy-smoke-")), "state.db");
restoreDatabase(readFileSync(sqlPath, "utf8"), path);
const db = new DatabaseSync(path, { readOnly: true });
for (const needle of needles) {
    const row = db.prepare("SELECT count(*) AS n FROM messages WHERE content LIKE ?").get(`%${needle}%`) as {
        n: number;
    };
    if (row.n === 0) {
        console.error(`missing: ${needle}`);
        process.exit(1);
    }
}
console.log(`state.sql restores and holds: ${needles.join(", ")}`);
```

- [ ] **Step 4: Write the compose override**

`smoke/compose.smoke.yaml` adds mounts and one environment variable; it must
not touch any hardening key (S10):

```yaml
# vim:set expandtab shiftwidth=4 filetype=yaml foldlevel=3:
# SPDX-License-Identifier: GPL-3.0-only

#
#
# ~chewygumxx/dorothy-hermes.git
# ::: :/smoke/compose.smoke.yaml
#
#

# Fixture repositories for smoke/run.sh. Mounts and test data only: the
# hardening in compose.yaml runs unmodified.

services:
    dorothy-sync:
        volumes:
            - ${SMOKE_REPOS:?}:/fixtures

    hermes:
        environment:
            DOROTHY_SMOKE_TOKEN: ${DOROTHY_SMOKE_TOKEN:?}
        volumes:
            - ${SMOKE_REPOS:?}:/fixtures:ro
            - ./smoke:/smoke:ro
```

- [ ] **Step 5: Write `smoke/run.sh`**

```sh
#!/usr/bin/env sh
# vim:set expandtab shiftwidth=4 filetype=sh:
# SPDX-License-Identifier: GPL-3.0-only

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
DOROTHY_CONFIG_DEPLOY_KEY=$(base64 -w0 < "$work/config_key")
DOROTHY_MEMORY_DEPLOY_KEY=$(base64 -w0 < "$work/memory_key")
export DOROTHY_CONFIG_DEPLOY_KEY DOROTHY_MEMORY_DEPLOY_KEY

image=$(compose config --images | grep hermes-agent | head -n 1)
GIT='git -c user.name=smoke -c user.email=smoke@example.invalid -c commit.gpgsign=false -c init.defaultBranch=main'

cleanup() {
    code=$?
    compose logs --no-color --timestamps > "$work/compose.log" 2>&1 || true
    compose down --volumes --remove-orphans > /dev/null 2>&1 || true
    if [ "$code" -ne 0 ]; then tail -n 300 "$work/compose.log" >&2 || true; fi
    if [ -n "${KEEP:-}" ]; then
        say "kept $work"
        return
    fi
    docker run --rm -v "$work:/work" --entrypoint /bin/rm "$image" -rf /work/repos /work/edit > /dev/null 2>&1 || true
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
compose config --format json | jq -e '[.services[] | select(.ports)] | length == 0' > /dev/null ||
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
key_line=$(sed -n 2p "$work/memory_key")
if in_hermes sh -c "grep -rlsF -e '$key_line' /proc/[0-9]*/environ /opt/data /run /tmp /var/lib/dorothy"; then
    fail "the memory key is readable inside hermes"
fi

say "S3: root in hermes cannot write the restore volume or reach the sidecar"
if in_hermes touch /var/lib/dorothy/restore/probe 2> /dev/null; then fail "the restore volume is writable from hermes"; fi
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
memory_show sessions/state.sql > "$work/state.sql"
grep -qF "$DOROTHY_SMOKE_TOKEN" "$work/state.sql" && fail "the fake token reached dorothy-memory"
grep -qF "[REDACTED:DOROTHY_SMOKE_TOKEN]" "$work/state.sql" || fail "the fake token was not redacted"
node "$root/smoke/restore-check.mts" "$work/state.sql" zebracorn 東京 || fail "state.sql does not restore"

say "step 3: a config push is applied by the fallback apply"
mkdir -p "$work/next"
printf '# Smoke Dorothy\n\nYou are a smoke-test fixture. Version 2.\n' > "$work/next/SOUL.md"
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
config_commit "fixed config" > /dev/null
snapshot_once || fail "snapshot --once failed"

say "S2: symlinked and FIFO bundles are rejected"
head=$(memory_head)
in_hermes sh -c 'ln -sfn /tmp/dorothy/memory.key /var/lib/dorothy/outbox/bundle.json'
sleep 40
in_hermes cat /var/lib/dorothy/restore/status.json | jq -r .lastError | grep -q 'symbolic link' ||
    fail "the symlinked bundle was not rejected"
in_hermes sh -c 'rm -f /var/lib/dorothy/outbox/bundle.json && mkfifo /var/lib/dorothy/outbox/bundle.json'
sleep 40
in_hermes cat /var/lib/dorothy/restore/status.json | jq -r .lastError | grep -q 'not a regular file' ||
    fail "the FIFO bundle was not rejected"
[ "$(memory_head)" = "$head" ] || fail "something was pushed from a hostile bundle"
in_hermes rm -f /var/lib/dorothy/outbox/bundle.json
snapshot_once || fail "snapshot --once failed"

say "step 5: a first boot against an empty memory repository seeds main"
compose down --volumes
fixture "$GIT init --bare -q /work/repos/memory-empty.git"
export DOROTHY_MEMORY_REPO=file:///fixtures/memory-empty.git
compose up -d --wait --wait-timeout 600 || fail "the seed stack did not become healthy"
snapshot_once || fail "snapshot --once failed"
seeded() { fixture "$GIT --git-dir /work/repos/memory-empty.git cat-file -e main:sessions/state.sql" 2> /dev/null; }
wait_for 120 seeded || fail "the seed deployment did not push main"

say "S6: a platform token without an allowlist stops the container"
compose down --volumes
if timeout 300 docker compose -f "$root/compose.yaml" -f "$root/smoke/compose.smoke.yaml" \
    run --rm --no-deps -e TELEGRAM_BOT_TOKEN=1:smoke hermes > "$work/s6.log" 2>&1; then
    fail "hermes started without an allowlist"
fi
grep -q TELEGRAM_ALLOWED_USERS "$work/s6.log" || fail "the refusal does not name TELEGRAM_ALLOWED_USERS"

say "passed"
```

- [ ] **Step 6: Run the smoke test**

Run: `chmod 0755 smoke/run.sh && mise run smoke`
Expected: every `smoke:` line, ending `smoke: passed`. This is the first time
the containers run, so expect failures here; each one is a finding to fix in
the module it names, with a unit test added when the cause is ours. Record
each finding and its fix for Task 18. Use `KEEP=1 mise run smoke` to inspect
`compose.log`.

- [ ] **Step 7: Add the CI job and commit**

Append to `.github/workflows/ci.yaml`:

```yaml
    smoke:
        needs: check
        runs-on: ubuntu-latest
        permissions:
            contents: read
        steps:
            - name: Checkout
              uses: actions/checkout@3d3c42e5aac5ba805825da76410c181273ba90b1 # v7.0.1
              with:
                  persist-credentials: false

            - name: Setup Toolchain
              uses: jdx/mise-action@7a4e45a543138629540c9a1616d08632b893e492 # v5.0.1

            - name: Smoke Test
              run: mise run smoke
```

```bash
bunx biome check --write smoke && bun run check
git add smoke .github/workflows/ci.yaml
git commit -m "test: Smoke-test the stack against fixtures"
```

---

### Task 17: Deploy live and capture data

Human-in-the-loop: every step that creates or changes something outside this
repository (GitHub repositories, keys, rulesets, bots, the server) is
confirmed with the user first, and secrets are typed by the user, never
echoed into the transcript or committed in plaintext.

**Files:**

- Create: `.env` (dotenvx-encrypted), `docs/notes/<date>-live-run.md`

**Interfaces:**

- Consumes: the green stack from Task 16.
- Produces: a running deployment and a dated run record for review.

- [ ] **Step 1: Prepare the server (S11)**

Any Linux VM with at least 2 vCPU, 4 GB RAM and 20 GB disk. On it:

1. Docker Engine 27 or later with the compose plugin, and mise.
2. `/etc/docker/daemon.json` containing `{"userns-remap": "default"}`, then
   `sudo systemctl restart docker`; confirm with
   `docker info --format '{{.SecurityOptions}}'` (expect `name=userns`).
3. Host firewall denies all inbound; SSH key-only, no root login, reached
   through Cloudflare Access or Tailscale; automatic security updates on.
4. Only the administrator's account in the `docker` group.

- [ ] **Step 2: Create the repositories, keys and rulesets (S1, S7)**

With the user's go-ahead:

```bash
gh repo create chewygumxx/dorothy-config --private
gh repo create chewygumxx/dorothy-memory --private   # empty: no README
for repo in dorothy-config dorothy-memory; do
  gh api -X POST "repos/chewygumxx/$repo/rulesets" --input - <<'JSON'
{"name": "protect main", "target": "branch", "enforcement": "active",
 "conditions": {"ref_name": {"include": ["refs/heads/main"], "exclude": []}},
 "rules": [{"type": "deletion"}, {"type": "non_fast_forward"}]}
JSON
done
cd "$(mktemp -d)"
ssh-keygen -q -t ed25519 -N '' -C dorothy-config -f config_key
ssh-keygen -q -t ed25519 -N '' -C dorothy-memory -f memory_key
gh repo deploy-key add config_key.pub --repo chewygumxx/dorothy-config --title dorothy-server
gh repo deploy-key add memory_key.pub --repo chewygumxx/dorothy-memory --title dorothy-sync --allow-write
```

`dorothy-memory` must stay empty until the sidecar's first push: a README
commit gives it a head without `sessions/state.sql`, which fails startup.

- [ ] **Step 3: Author `dorothy-config`**

The user writes `SOUL.md` (Dorothy's personality; `../dorothy` holds the
current one). Start `config.yaml` from upstream's example,
`docker run --rm --entrypoint cat "$IMAGE" /opt/hermes/cli-config.yaml.example`,
choose the model and provider, enable the platform, and add:

```yaml
skills:
    external_dirs:
        - /opt/data/dorothy/config/skills
```

Push both to `dorothy-config` `main`.

- [ ] **Step 4: Encrypt the secrets into `.env`**

The user runs each `dotenvx set` (the values are theirs; nothing is pasted
into this session). Use a dedicated LLM key with a spend limit (S12) and a
Telegram bot made for Dorothy:

```bash
dotenvx set DOROTHY_CONFIG_DEPLOY_KEY "$(base64 -w0 config_key)"
dotenvx set DOROTHY_MEMORY_DEPLOY_KEY "$(base64 -w0 memory_key)"
dotenvx set ANTHROPIC_API_KEY ...
dotenvx set TELEGRAM_BOT_TOKEN ...
dotenvx set TELEGRAM_ALLOWED_USERS <your numeric Telegram id>
shred -u config_key memory_key
```

Store `.env.keys` in the password manager. Confirm `.env` holds only
`encrypted:` values (`grep -v '^#' .env | grep -v 'encrypted:'` prints only
`DOTENV_PUBLIC_KEY`), then commit:

```bash
git add .env && git commit -m "chore: Add the encrypted deployment secrets"
```

- [ ] **Step 5: Bring Dorothy up**

On the server:

```bash
git clone git@github.com:chewygumxx/dorothy-hermes.git && cd dorothy-hermes
install -m 0600 /dev/stdin .env.keys    # paste from the password manager, then Ctrl-D
chmod -R a+rX hermes                     # readable under userns-remap
mise trust && mise install
date -u +%FT%TZ > /tmp/up-started
mise run up
date -u +%FT%TZ > /tmp/up-healthy
docker compose ps
```

Expected: three services, `dorothy-init` exited 0, the others `healthy`. If
s6 fails under `userns-remap`, record the error, remove the remap, and note
S11's fallback (Accepted) for Task 18.

- [ ] **Step 6: Capture the run**

Create `docs/notes/<date>-live-run.md` (front matter as in the specs) and fill
one section per item. Keep raw logs on the server or locally; never commit
them, since they hold conversation text.

1. **Environment:** image reference, `docker version`, kernel, VM size,
   `userns-remap` result.
2. **Boot:** `/tmp/up-started` to `/tmp/up-healthy`; per-service health
   transitions from `docker inspect --format '{{json .State.Health}}'`.
3. **Logs, first hour:**
   `docker compose logs --timestamps --no-color > ~/dorothy-first-hour.log`,
   then counts of
   `grep -ciE 'error|warn|denied|EPERM|not permitted'` per service, with
   every distinct permission error quoted.
4. **Resources:** every 5 minutes for an hour,
   `docker stats --no-stream --format '{{.Name}},{{.CPUPerc}},{{.MemUsage}},{{.PIDs}}' >> ~/dorothy-stats.csv`;
   record peaks against the limits (4 GB and 512 pids for `hermes`; 1 GB
   and 128 for `dorothy-sync`).
5. **Conversation:** three messages to the bot; reply latency for each; one
   message from a non-allowlisted account (expect no service).
6. **Sync:** after three intervals, the commits in `dorothy-memory`
   (`gh api repos/chewygumxx/dorothy-memory/commits --jq '.[].commit.message'`),
   `state.sql` size, snapshot duration (log timestamps around
   `[dorothy-snapshot] wrote a bundle`), and bundle-to-commit latency.
7. **Memory write-back:** ask Dorothy to remember a fact; time until it
   appears in `memories/` on GitHub.
8. **Config delivery:** push a `SOUL.md` tweak; time until applied (at most
   one interval); gateway restart duration from the logs.
9. **Shutdown and warm boot:** `docker compose down` duration, the final
   snapshot's commit on GitHub, then `mise run up` time to healthy.
10. **Cold-restore drill:** `docker compose down`,
    `docker volume rm dorothy_hermes-data`, `mise run up`; time to healthy,
    `optimize-storage` duration, and whether Dorothy recalls the earlier
    conversation and the fact from item 7.
11. **Security spot checks:** S1
    (`docker inspect` of `hermes` shows no `DOROTHY_MEMORY_DEPLOY_KEY`); S9
    (`ss -tlnp` on the host shows no Docker listeners); S5, without printing
    any value:

    ```bash
    git clone git@github.com:chewygumxx/dorothy-memory.git /tmp/dm
    dotenvx get --format json | jq -r 'to_entries[] | select(.key | test("_(TOKEN|KEY|SECRET|PASSWORD)$")) | .value' |
      while IFS= read -r v; do git -C /tmp/dm grep -qF -- "$v" && echo LEAK; done; echo scanned
    ```

    Expected: `scanned` alone.
12. **Surprises:** anything that behaved differently from the specs.

- [ ] **Step 7: Commit the record**

```bash
bun run lint:md && bun run lint:emdash
git add docs/notes && git commit -m "docs: Record the first live run"
```

---

### Task 18: Fold the results into the specs

**Files:**

- Modify: `docs/specs/2026-10-03-hermes-deployment-design.md`,
  `docs/specs/2026-10-03-hermes-security-design.md`, `README.md`

- [ ] **Step 1: Close the open items**

In the deployment design's Open items, replace each item with its answer from
Task 1 and Task 17 (allowlist names: `platforms.json`; API bind address;
`userns-remap`; tmpfs at `VOLUME`; `check` versus tests; the final `cap_add`
list). Leave only Dependabot's calver handling open until its first pull
request arrives. Mirror the S9, S10 and S11 answers in the security design.

- [ ] **Step 2: Record the departures**

Add this plan's Scope list to the deployment design where each belongs:
source layout (`util.ts`, `files.ts`, `test-helpers.ts`, `platforms.json`,
co-located tests), S5 (blob redaction before hex), the gateway test's
previous-pid rule, `DOROTHY_HOST`, and the boot check's temporary home in
`dorothy-snapshot`. Add every smoke-test finding from Task 16 that changed
behaviour.

- [ ] **Step 3: Update the README**

Under Development, add: `mise run test` (unit tests on the image's Node),
`mise run smoke` (the stack against fixtures; needs Docker), `mise run up`
(deploy), and `sh smoke/make-fixture.sh` (regenerate the migration fixture
after an upgrade).

- [ ] **Step 4: Commit**

```bash
bun run check
git add docs/specs README.md
git commit -m "docs: Fold the probe and live run into the specs"
```
