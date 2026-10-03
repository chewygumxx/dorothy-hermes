---
__cgxx: |
  # vim:set expandtab shiftwidth=2 filetype=markdown foldlevel=3:
  # SPDX-License-Identifier: GPL-3.0-only

  #
  #
  # ~chewygumxx/dorothy-hermes.git
  # ::: :/docs/specs/2026-10-03-hermes-security-design.md
  #
  #

ctime: 2026-10-03
title: Hermes deployment security design
description: "Threat model and planned mitigations for the Hermes deployment"
tags:
  - dorothy
  - hermes
  - security
  - spec
---

# Hermes deployment security design

## Purpose

This is the companion to the
[deployment design](2026-10-03-hermes-deployment-design.md). It names what the
deployment protects, from whom, and how each threat is mitigated, verified or
knowingly accepted. Where the two documents disagree, this one wins and the
deployment design is corrected.

## Trust model

Upstream's
[security policy](https://github.com/NousResearch/hermes-agent/blob/main/SECURITY.md)
states that the only security boundary against an adversarial LLM is the
operating system. Approval prompts, output redaction, environment scrubbing and
tool allowlists inside the agent are heuristics. This design adopts that
stance: anything the agent's Unix user (`hermes`, UID 10000) can read or do is
treated as available to an attacker.

No network access is needed to become that attacker. Prompt injection reaches
the agent through anything entering its context: messages from allowlisted
users and whatever those conversations pull in (web pages, email, files, tool
and MCP output). Closing public ports defends against the internet; it does
nothing against the agent. Most of this document is about the agent.

### Assets

| Asset                               | Location                   | Impact if compromised                                |
| ----------------------------------- | -------------------------- | ---------------------------------------------------- |
| `dorothy-memory` history            | GitHub                     | Durable memory; every cold boot restores from it     |
| Memory deploy key                   | `/run/dorothy/private/`    | Writes `dorothy-memory`; rewrites it without S1      |
| `dorothy-config` `main`             | GitHub                     | Controls prompt, tools, MCP servers: code execution  |
| LLM credential                      | container environment      | Spend; provider account access                       |
| Platform tokens                     | container environment      | Impersonating Dorothy on messaging platforms         |
| Transcripts                         | `state.db`, `state.sql`    | Everything said to and done by the agent             |
| Config deploy key, webhook secret   | `/run/dorothy/hermes/`     | Low: read config, trigger a redundant apply          |
| `TUNNEL_TOKEN`                      | `cloudflared` environment  | Running a connector for the tunnel                   |
| `DOTENV_PRIVATE_KEY`                | server `.env.keys`         | Decrypts every secret above                          |

### Adversaries

- **Internet:** reaches the tunnel hostname and nothing else.
- **Injected agent:** Hermes acting on attacker-supplied text, with everything
  UID 10000 can do inside the container.
- **Stranger:** messages the bot from an account not on its allowlist.
- **GitHub takeover:** can push to either repository.
- **Upstream:** a malicious or vulnerable image release.
- **Host attacker:** a shell on the server.

### Principals in the container

| Principal | UID   | Runs                                                     |
| --------- | ----- | -------------------------------------------------------- |
| `root`    | 0     | s6, shell stubs, the sync cycle script                   |
| `hermes`  | 10000 | Hermes, bootstrap step, snapshot step, webhook, health   |
| `dorothy` | 10001 | Publish step only                                        |

`dorothy` exists for one reason: to hold write access to `dorothy-memory` where
the agent cannot reach it. The root bootstrap stub adds it to `/etc/passwd`
when absent (the container layer is recreated with each container, so no
derived image is needed). Its primary group is `dorothy`; its supplementary
group `hermes` lets it read group-readable files that Hermes-side steps
produce. Nothing makes `dorothy` readable or writable by `hermes`.

Two rules follow, and every mitigation below is an instance of one of them:

1. **Nothing the agent can read grants more than the agent already has.**
2. **Nothing more privileged than the agent trusts a path the agent can
   write.** Root and `dorothy` consume agent output only through one
   validated file (S2), and act only on paths the agent cannot write.

## Threats and mitigations

Identifiers are stable; the implementation plan and tests refer to them.

### S1. The agent obtains the memory deploy key

**Threat.** With the key, the agent can push to `dorothy-memory` and, unless
GitHub prevents it, force-push: rewriting history and planting memories or
skills that every later cold boot restores. In the original design our code
ran as `hermes` and the key reached the gateway's environment through
`with-contenv` (upstream's `main-wrapper.sh` launches the gateway that way).

**Mitigation.**

- The root bootstrap stub writes the key to `/run/dorothy/private/memory.key`
  (`0400`, owner `dorothy`) in a directory owned by `dorothy` with mode
  `0700`. `hermes` cannot list, read or hardlink it.
- The stub then deletes `DOROTHY_MEMORY_DEPLOY_KEY`,
  `DOROTHY_CONFIG_DEPLOY_KEY` and `DOROTHY_WEBHOOK_SECRET` from
  `/run/s6/container_environment`, which `with-contenv` reads to build the
  environment of the gateway and of our own services. The gateway, and every
  process the agent spawns, never receives them. PID 1's environment belongs
  to root and is not readable by `hermes`.
- Only the publish step, running as `dorothy`, uses the key.
- A GitHub ruleset on `dorothy-memory` `main` blocks force pushes and branch
  deletion, with no bypass for deploy keys. A stolen key can only add
  commits, which S13 makes recoverable.

**Verification.** Smoke, as `hermes`: listing `/run/dorothy/private` and
reading the key fail; `/run/s6/container_environment` lacks the three names;
the gateway's `/proc/<pid>/environ` lacks them.

### S2. The agent smuggles data into the publish step

**Threat.** The publish step runs as `dorothy` and consumes what Hermes-side
code produced. Copying an agent-writable tree would follow a planted symlink or
hardlink to the key and commit it, or a path such as `.git/config` would set
`core.sshCommand` and run code as `dorothy`.

**Mitigation.** The hand-off is a single file. The snapshot step (`hermes`)
writes `/opt/data/dorothy/outbox/bundle.json`, holding the `state.sql` text
and the mirrored memory and skill files as `{ path, content }` entries. The
publish step:

- Opens it with `O_NOFOLLOW` and checks, with `fstat` on the open descriptor,
  that it is a regular file owned by UID 10000 with one link and no larger
  than `DOROTHY_BUNDLE_MAX_BYTES` (default 256 MiB). An agent-planted link to
  a file `hermes` does not own fails the owner check.
- Accepts only relative paths under `memories/`, `skills/`, or exactly
  `sessions/state.sql`, with no empty, `.` or `..` segment and no segment
  starting with `.`. Any other entry fails the whole cycle.
- Writes each file itself into its own checkout. It never copies directories,
  never follows links, and runs git only in its own checkout (S3).

The bundle's contents remain agent-controlled, which is inherent: the agent's
memory is the agent's to write (S13).

**Verification.** Unit: symlinked bundle, two-link bundle, `..`, `.git/x`,
absolute path, oversize; each fails without touching the checkout. Smoke: a
bundle owned by root is rejected and nothing is pushed.

### S3. The agent tampers with `dorothy`'s checkout

**Threat.** In a directory `hermes` can write, the agent can rename the memory
checkout and substitute a crafted repository. Git honours that repository's
config (`core.sshCommand`, `core.fsmonitor`, hooks), running code as
`dorothy`.

**Mitigation.** A second named volume, `dorothy-state`, is mounted at
`/var/lib/dorothy`, owned by `dorothy:hermes` with mode `0750`, and holds the
memory checkout, the `bootstrapped` marker and `status/sync.json`. A mount
point cannot be renamed, and `hermes` can write nothing beneath it. `dorothy`
runs with umask `0027`, so `hermes` can read the checkout (needed for a cold
restore) but not change it.

**Verification.** Smoke, as `hermes`: creating, renaming or deleting anything
under `/var/lib/dorothy` fails.

### S4. Root follows an agent-planted link

**Threat.** Root running `chown`, `mkdir -p` or `rm` on an agent-writable path
can be redirected by a symlink to `/etc` or elsewhere.

**Mitigation.** Root creates and changes ownership only of `/run/dorothy`
(a fresh tmpfs at each boot, prepared before any `hermes` process runs) and the
`/var/lib/dorothy` mount point, never recursively, and writes only the
`bootstrapped` marker inside it, which `hermes` cannot reach. Everything under
`/opt/data/dorothy` is created by code running as `hermes`. Root's only contact
with `/opt/data` is an existence test on `state.db`. The cycle script takes
`sync.lock` in root-owned `/run/dorothy`. `cont-finish.d` only runs the cycle
script, which drops privileges for every step.

**Verification.** Shell stubs stay short enough to audit line by line in
review. Smoke: `/opt/data/dorothy` replaced by a symlink to `/etc` before boot
leaves `/etc` unchanged.

### S5. Secrets leak into GitHub through transcripts

**Threat.** Transcripts include tool output. An `env` listing, an error
message or a pasted token lands in `state.sql` and, because S1 forbids
rewriting history, stays in `dorothy-memory` permanently.

**Mitigation.** Before writing anything, the publish step replaces every exact
occurrence of every known secret value with `[REDACTED:<NAME>]` in all bundle
content. Known values are those of the variables in the deployment design's
secrets table that the container receives, plus any variable in its
environment whose name ends in `_TOKEN`, `_KEY`, `_SECRET` or `_PASSWORD`.
Values shorter than eight characters are skipped. Each deploy key is redacted
in its base64 form, its decoded form, and per decoded line longer than 20
characters.

This catches accidents, not an adversary: an injected agent can encode a
secret, and has more direct exfiltration routes (S12). A leak found later is
handled by rotation (see Secret rotation), not by history rewriting.

**Verification.** Unit: each form is redacted, short values are not. Smoke: a
session containing the fixture's fake token is pushed redacted.

### S6. Strangers drive the agent

**Threat.** Anyone who finds the bot messages it and gets a capable agent.

**Mitigation.**

- Upstream policy requires every network-exposed adapter to refuse work until
  an allowlist is set; failing open is an upstream bug.
- `settings.ts` additionally refuses to start when a platform token is set
  without that platform's `*_ALLOWED_USERS` variable, or when an allow-all
  override is set. The variable names are taken from the pinned image's
  platform registry during implementation. A refusal stops the container
  (`S6_BEHAVIOUR_IF_STAGE2_FAILS=2`) rather than running open.
- Everyone on an allowlist is fully trusted (upstream does not model
  per-caller capabilities), so allowlists hold only the operator.
- Implementation confirms that DM pairing approval is operator-only (CLI
  inside the container) and records it here.

**Verification.** Unit: `settings.ts` refusals. Smoke: a fixture with a
platform token and no allowlist exits non-zero.

### S7. A config push executes code

**Threat.** `config.yaml` selects tools, the terminal backend and MCP server
commands, and the webhook applies it within seconds. Push access to
`dorothy-config` `main` is code execution as `hermes`.

**Mitigation.**

- Applies use only `origin/main` fetched over SSH with pinned host keys; the
  webhook payload selects nothing.
- The config deploy key is read-only.
- A ruleset on `dorothy-config` `main` blocks force pushes and deletion.
- The GitHub account uses a passkey or hardware second factor, and holds no
  classic personal access tokens with repository scope.

**Accepted.** A GitHub account takeover is an agent takeover. The account is
already the trust root for memory at rest.

### S8. Webhook abuse

**Threat.** Forged or replayed deliveries, slow or oversized requests, or the
tunnel used to reach other services.

**Mitigation.**

- HMAC-SHA256 over the raw body bytes, before parsing, compared with
  `timingSafeEqual`.
- Replays are harmless: a delivery only triggers a fetch, and an unchanged
  `origin/main` stops the apply.
- 1 MiB body cap; `headersTimeout` 10 s, `requestTimeout` 15 s,
  `keepAliveTimeout` 5 s. The collapsing queue bounds work to one running
  and one pending apply.
- Tunnel ingress: the webhook hostname to `http://hermes:9000`, then a
  catch-all `http_status:404`.
- Cloudflare custom rule: block requests to the webhook hostname unless the
  method is `POST` and the path `/github`. Cloudflare rate limiting rule:
  30 requests per minute per IP.
- The webhook secret is 32 random bytes. It is readable by `hermes`
  (the webhook runs as `hermes`), which is accepted: holding it only lets the
  agent trigger redundant fetches.

**Verification.** Unit: signatures, cap, timeouts, collapsing (deployment
design). The Cloudflare rules are recorded in the ops checklist.

### S9. Local services exposed

**Threat.** The dashboard (`:9119`), API server (`:8642`) or webhook (`:9000`)
reachable from outside the compose network.

**Mitigation.** No service declares `ports`. The tunnel routes only the
webhook hostname. Upstream binds the dashboard to loopback by default and this
deployment does not override it. The API server is enabled only in the smoke
fixture; enabling it in production would require `API_SERVER_KEY` and its own
review.

**Verification.** Smoke: `docker compose config --format json` shows no
`ports` on any service.

### S10. Container escape and resource exhaustion

**Mitigation.** The `hermes` service sets:

- `security_opt: [no-new-privileges:true]`
- `cap_drop: [ALL]` and `cap_add` only what s6 and the stubs need to change
  ownership and drop privileges: initially `CHOWN`, `DAC_OVERRIDE`, `FOWNER`,
  `SETUID`, `SETGID`, `KILL`, narrowed by the smoke test
- `pids_limit: 512` and `mem_limit: 4g`
- no `privileged`, Docker socket, host namespaces or devices

`cloudflared` sets `read_only: true`, `cap_drop: [ALL]` and
`no-new-privileges`.

**Accepted.** A read-only root filesystem for `hermes`: the agent and its
skills install packages and write caches at runtime, and upstream does not
support it.

**Verification.** The smoke test runs the hardened compose file unmodified.

### S11. Host access

**Mitigation** (ops checklist):

- No inbound ports at all. SSH goes through Cloudflare Access
  (`cloudflared access ssh`) or Tailscale; the host firewall denies all
  inbound traffic. Docker-published ports bypass host firewalls, which S9
  keeps moot.
- Key-only SSH, no root login.
- The `docker` group is root-equivalent: only the administrator's account.
- `.env.keys` is `0600`, owned by the administrator, with its only other copy
  in a password manager.
- Automatic security updates for the host.

**Accepted.** Host compromise exposes every secret: dotenvx protects the
repository, not the server. See Secret rotation.

### S12. Exfiltration and credential misuse (accepted)

The agent has unrestricted egress, and its own process holds the LLM
credential and platform tokens. Upstream strips them from shell subprocesses,
which reduces accidents, not attacks. Blast radius is limited instead:

- A dedicated LLM API key with a spend limit, revocable independently.
- Platform bots dedicated to Dorothy.
- No other credentials in the container: no cloud keys, no personal GitHub
  token.

Not adopted: an egress allowlist proxy (a sidecar, or NVIDIA OpenShell as
upstream suggests). Revisit if Dorothy is given inbound email or other
unattended untrusted input.

### S13. Memory poisoning (accepted, recoverable)

Injected text can make the agent write harmful memories or skills, which sync
and survive rebuilds. Writing memory is the agent's job, so this cannot be
prevented, only reversed. S1's ruleset keeps every version, and each sync
commit body says what changed. Skills deserve the closest review: they are
instructions and scripts the agent will later follow.

Recovery: revert the bad commits in `dorothy-memory`, then
`docker compose down`, remove the `hermes-data` and `dorothy-state` volumes,
and `mise run up` for a cold boot from the reverted head.

Status files under `/opt/data/dorothy` are agent-writable, so the health check
is an operational signal, not a security control.

### S14. Supply chain

- Both images are pinned by digest and change only through a Dependabot pull
  request whose smoke test passes, after reading upstream's release notes and
  security advisories.
- Runtime code imports only `node:*`. Development tooling is pinned by mise
  and the lockfile and never ships to the server.
- GitHub Actions are pinned by commit SHA. Dependabot pull requests run
  without repository secrets, and the smoke test needs none.
- Third-party skills from the Hermes hub load into the agent process (upstream
  §2.3) and are installed only after reading them.

### S15. Git transport

Pinned `known_hosts` with `StrictHostKeyChecking=yes` and `IdentitiesOnly`;
git runs through `execFile`, never a shell; repository URLs come only from
settings.

## Secret rotation

| Secret                | Rotation                                                       |
| --------------------- | -------------------------------------------------------------- |
| LLM credential        | Revoke at the provider, `dotenvx set`, commit, `mise run up`   |
| Platform token        | Revoke on the platform, then as above                          |
| Deploy key            | New key pair; add on GitHub; remove the old key; then as above |
| Webhook secret        | Update the GitHub webhook and `.env` together                  |
| `TUNNEL_TOKEN`        | Refresh in the Cloudflare dashboard, then as above             |
| `DOTENV_PRIVATE_KEY`  | Re-encrypt `.env` under a new key pair; replace `.env.keys`    |

Suspected compromise: stop the stack, rotate every secret, review both
repositories' history since the last known-good commit, and recover as in
S13.

## Smoke test additions

Collected from the verification notes above, run as `hermes` via
`docker compose exec -u hermes` unless stated:

1. The private key directory and key are unreadable (S1).
2. The scrubbed variables are absent from `container_environment` and the
   gateway's environment (S1).
3. A root-owned bundle is rejected and nothing is pushed (S2).
4. Nothing under `/var/lib/dorothy` can be created, renamed or deleted (S3).
5. A pre-planted `/opt/data/dorothy` symlink leaves its target unchanged
   (S4).
6. A fixture session containing a fake token is pushed redacted (S5).
7. A platform token without an allowlist stops the container (S6).
8. No service publishes ports (S9).
