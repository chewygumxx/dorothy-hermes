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
stance.

No network access is needed to attack the agent. Prompt injection reaches it
through anything entering its context: messages from allowlisted users and
whatever those conversations pull in (web pages, email, files, tool and MCP
output). Closing public ports defends against the internet; it does nothing
against the agent.

Inside the upstream container, the agent can become root (S4). The boundary
this design relies on is therefore the container, the same one upstream's
policy names, and not any user or permission inside it. The `hermes`
container is treated as wholly agent-controlled.

### Assets

| Asset                               | Location                       | Impact if compromised                                |
| ----------------------------------- | ------------------------------ | ---------------------------------------------------- |
| `dorothy-memory` history            | GitHub                         | Durable memory; every cold boot restores from it     |
| Memory deploy key                   | `dorothy-sync` only            | Writes `dorothy-memory`; rewrites it without a ruleset |
| `dorothy-config` `main`             | GitHub                         | Controls prompt, tools, MCP servers: code execution  |
| LLM credential                      | `hermes` environment           | Spend; provider account access                       |
| Platform tokens                     | `hermes` environment           | Impersonating Dorothy on messaging platforms         |
| Transcripts                         | `state.db`, `state.sql`        | Everything said to and done by the agent             |
| Config deploy key, webhook secret   | `hermes` secrets               | Low: read config, trigger a redundant apply          |
| `TUNNEL_TOKEN`                      | `cloudflared` environment      | Running a connector for the tunnel                   |
| `DOTENV_PRIVATE_KEY`                | server `.env.keys`             | Decrypts every secret above                          |

### Adversaries

- **Internet:** reaches the tunnel hostname and nothing else.
- **Injected agent:** Hermes acting on attacker-supplied text, with root
  inside the `hermes` container.
- **Stranger:** messages the bot from an account not on its allowlist.
- **GitHub takeover:** can push to either repository.
- **Upstream:** a malicious or vulnerable image release.
- **Host attacker:** a shell on the server.

### Rules

Every mitigation below is an instance of one of these:

1. **The `hermes` container holds nothing that grants more than the agent
   already has.** Anything in it is assumed read by the agent.
2. **The trusted side consumes agent output only as one validated file on a
   volume mounted read-only, and shares no writable path, network or
   process namespace with the `hermes` container.**

## Threats and mitigations

Identifiers are stable; the implementation plan and tests refer to them.

### S1. The agent obtains the memory deploy key

**Threat.** With the key, the agent can push to `dorothy-memory` and, unless
GitHub prevents it, force-push: rewriting history and planting memories or
skills that every later cold boot restores.

**Mitigation.**

- The key is a compose secret listed only by `dorothy-sync`. It never enters
  the `hermes` container's environment, filesystem or volumes, so neither
  root inside that container nor `docker exec` into it can find it.
- `dorothy-sync` runs no agent code, listens on no port, and sits on its own
  network (S3).
- Where available (GitHub Pro for private personal repositories), a ruleset
  on `dorothy-memory` `main` blocks force pushes and branch deletion, with no
  bypass for deploy keys. This is defence in depth; the sidecar never forces.

**Verification.** Smoke: `docker inspect` lists no `memory_deploy_key` for
`hermes`; inside `hermes`, `/run/secrets` lacks it and no process environment
holds it.

### S2. The agent smuggles data into the sidecar

**Threat.** The sidecar consumes what the `hermes` container produced. A
symlink would lead it to read its own key and publish it; a path such as
`.git/config` would set `core.sshCommand` and run code in the sidecar.

**Mitigation.** The hand-off is one file, `bundle.json`, at the root of the
`dorothy-outbox` volume, which the sidecar mounts read-only. The volume root
is a mount point in the sidecar, so only the file name itself is
agent-controlled. The sidecar:

- Opens it with `O_NOFOLLOW` and checks, with `fstat` on the open descriptor,
  that it is a regular file no larger than `DOROTHY_BUNDLE_MAX_BYTES`
  (default 256 MiB). Hardlinks cannot cross mounts.
- Accepts only the paths, modes and encodings of the bundle format. Any other
  entry fails the whole cycle.
- Writes each file itself into its own checkout. It never copies directories
  or follows links, and runs git only in its own checkout (S15).

The bundle's content remains agent-controlled, which is inherent: the agent's
memory is the agent's to write (S13).

**Verification.** Unit: symlinked, non-regular and oversize bundles; `..`,
`.git/x`, absolute paths and bad modes; each fails without touching the
checkout. Smoke: a symlinked bundle is rejected and nothing is pushed.

### S3. The agent tampers with the sidecar's state

**Threat.** Write access to the sidecar's checkout, its restore output or its
network would let the agent plant git configuration, forge a restore, or
attack the process.

**Mitigation.**

- `dorothy-state` (the checkout and status) is not mounted in `hermes`.
- `dorothy-restore` is mounted read-only in `hermes`; remounting needs
  `CAP_SYS_ADMIN`, which no container has (S10).
- The sidecar's network, `sync`, is shared with no other service, and the
  sidecar listens on nothing.
- The sidecar's root filesystem is read-only.

**Verification.** Smoke: as root in `hermes`, writing to
`/var/lib/dorothy/restore` fails and the sidecar's address is unreachable.

### S4. The agent is root in the `hermes` container (accepted)

**Threat.** Two upstream designs let UID 10000 become root inside the
container:

- `02-reconcile-profiles` hands `/run/service` and the s6-svscan control
  files to `hermes`, and s6-supervise runs each service's `run` script as
  root before it drops privileges. The agent can write a `run` script.
- The image's `PATH` includes the agent-writable `/opt/data/.local/bin`
  before `/usr/bin`, and root scripts inherit it.

Upstream needs the first for its own gateway supervision, and its policy
names the container as the boundary, so neither is fought here.

**Consequence.** Everything inside `hermes` is the agent's: the LLM
credential, platform tokens, the config key, the webhook secret, every file
in `/opt/data`, status files and pairing stores. Rule 1 keeps that set to
what the agent needs anyway; S10 and S11 make the container a real boundary.
Our stubs use absolute paths for correctness only.

### S5. Secrets leak into GitHub through transcripts

**Threat.** Transcripts include tool output. An `env` listing, an error
message or a pasted token lands in `state.sql` and, because history is never
rewritten, stays in `dorothy-memory` permanently.

**Mitigation.** Before writing the bundle, the snapshot step replaces every
occurrence of every known secret value with `[REDACTED:<NAME>]` across all
bundle content. Known values are every file in `/run/secrets`, the
deployment's secret variables, and any environment variable whose name ends
in `_TOKEN`, `_KEY`, `_SECRET` or `_PASSWORD`. Each value is matched as
written, in the hex form the dump uses for blobs, and, for keys, per decoded
line longer than 20 characters. Values shorter than eight characters are
skipped. The memory key never reaches the `hermes` container, so it cannot
appear in a transcript.

This runs on the untrusted side and catches accidents, not an adversary,
which can encode a secret and has more direct exfiltration routes (S12). A
leak found later is handled by rotation, not by rewriting history.

**Verification.** Unit: each form is redacted, short values are not. Smoke: a
session containing the fixture's fake token is pushed redacted.

### S6. Strangers drive the agent

**Threat.** Anyone who finds the bot messages it and gets a capable agent.

**Mitigation.**

- The `*_ALLOWED_USERS` variables in the encrypted `.env` are the only source
  of truth for who may talk to Dorothy. Allowlists hold only the operator:
  upstream does not model per-caller capabilities.
- Upstream policy requires adapters to refuse work until an allowlist is set.
  `settings.ts` also refuses to start when a platform token lacks its
  allowlist or an allow-all override is set, with the names taken from the
  pinned image's platform registry. A refusal stops the container.
- At each boot, bootstrap removes deployment-provided variables from
  `/opt/data/.env` (upstream loads that file over the process environment)
  and empties the pairing stores, which grant access in addition to the
  allowlist.

**Accepted.** DM pairing approval runs as `hermes`, so the agent can approve
a stranger itself. Such an approval lasts until the next boot.

**Verification.** Unit: `settings.ts` refusals; boot cleanup. Smoke: a
platform token without an allowlist stops the container.

### S7. A config push executes code

**Threat.** `config.yaml` selects tools, the terminal backend and MCP server
commands, and the webhook applies it within seconds. Push access to
`dorothy-config` `main` is code execution in `hermes`.

**Mitigation.**

- Applies use only `origin/main` fetched over SSH with pinned host keys; the
  webhook payload selects nothing.
- The config deploy key is read-only.
- Where available, a ruleset on `dorothy-config` `main` blocks force pushes
  and deletion.
- The GitHub account uses a passkey or hardware second factor, and holds no
  classic personal access tokens with repository scope.

**Accepted.** A GitHub account takeover is an agent takeover. The account is
already the trust root for memory at rest.

### S8. Webhook abuse

**Threat.** Forged or replayed deliveries, slow or oversized requests, or the
tunnel used to reach other services.

**Mitigation.**

- HMAC-SHA256 over the raw body bytes, before parsing, compared with
  `timingSafeEqual`; `application/json` only.
- Replays are harmless: a delivery only triggers a fetch, and an unchanged
  `origin/main` stops the apply.
- 1 MiB body cap; `headersTimeout` 10 s, `requestTimeout` 15 s,
  `keepAliveTimeout` 5 s. The collapsing queue bounds work to one running
  and one pending apply.
- Tunnel ingress: the webhook hostname to `http://hermes:9000`, then a
  catch-all `http_status:404`.
- Cloudflare custom rule: block requests to the webhook hostname unless the
  method is `POST` and the path `/github`. Cloudflare rate limiting rule
  (the Free plan's 10-second window): 10 requests per 10 seconds per IP.
- The webhook secret is 32 random bytes. It lives in `hermes`, so the agent
  can read it (S4); holding it only triggers redundant fetches.

**Verification.** Unit tests in the deployment design. The Cloudflare rules
are recorded in the operator checklist.

### S9. Local services exposed

**Threat.** The dashboard (`:9119`), API server (`:8642`) or webhook (`:9000`)
reachable from outside the compose network.

**Mitigation.** No service declares `ports`. The tunnel routes only the
webhook hostname. The dashboard runs only when `HERMES_DASHBOARD` is set,
which this deployment never does. The API server is enabled only in the
smoke fixture; enabling it in production would require `API_SERVER_KEY` and
its own review. The sidecar listens on nothing.

**Verification.** Smoke: `docker compose config --format json` shows no
`ports` on any service.

### S10. Container escape and resource exhaustion

Because the agent is root in `hermes` (S4), this is the boundary that
matters most.

**Mitigation.** `hermes` sets:

- `security_opt: [no-new-privileges:true]`
- `cap_drop: [ALL]` and `cap_add` only what s6 and upstream's hooks need:
  initially `CHOWN`, `DAC_OVERRIDE`, `FOWNER`, `SETUID`, `SETGID`, `KILL`,
  narrowed by the smoke test. Never `SYS_ADMIN`.
- `tmpfs: /run:exec`, `pids_limit: 512`, `mem_limit: 4g`
- no `privileged`, Docker socket, host namespaces or devices

`dorothy-sync` and `cloudflared` set `read_only: true`, `cap_drop: [ALL]` and
`no-new-privileges`, with tmpfs where they write.

**Accepted.** A read-only root filesystem for `hermes`: the agent and its
skills install packages and write caches at runtime, and upstream does not
support it.

**Verification.** The smoke test runs the hardened compose file unmodified.

### S11. Host access

**Mitigation** (operator checklist):

- Docker with `userns-remap` (or rootless Docker), so root in a container is
  an unprivileged user on the host. Implementation confirms upstream's s6
  boot works under it; if not, this item moves to Accepted.
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

The agent has unrestricted egress and holds the LLM credential and platform
tokens. Upstream strips them from shell subprocesses, which reduces
accidents, not attacks. Blast radius is limited instead:

- A dedicated LLM API key with a spend limit, revocable independently.
- Platform bots dedicated to Dorothy.
- No other credentials in `hermes`: no cloud keys, no personal GitHub token.

Not adopted: an egress allowlist proxy (a sidecar, or NVIDIA OpenShell as
upstream suggests). Revisit if Dorothy is given inbound email or other
unattended untrusted input.

### S13. Memory poisoning (accepted, recoverable)

Injected text can make the agent write harmful memories, skills or scheduled
jobs, which sync and survive rebuilds. Writing memory is the agent's job, so
this cannot be prevented, only reversed. The sidecar never rewrites history,
and each sync commit body says what changed. Skills and scheduled jobs
deserve the closest review: the agent later acts on them unprompted.

The sidecar refuses a bundle that would delete `sessions/state.sql` or
`memories/MEMORY.md` unless `DOROTHY_ALLOW_EMPTY=1`, so neither a failed
restore nor the agent can silently empty the repository.

Recovery: revert the bad commits in `dorothy-memory`, then
`docker compose down`, remove the `hermes-data` and `dorothy-state` volumes,
and `mise run up` for a cold boot from the reverted head.

Status files and health checks in `hermes` are agent-writable: they are
operational signals, not security controls.

### S14. Supply chain

- Both service images are pinned by digest and change only through a
  Dependabot pull request whose smoke test passes, after reading upstream's
  release notes and security advisories.
- Runtime code imports only `node:*`. Development tooling is pinned by mise
  and the lockfile and never ships to the server.
- GitHub Actions are pinned by commit SHA. Dependabot pull requests run
  without repository secrets, and the smoke test needs none.
- Third-party skills from the Hermes hub load into the agent process and are
  installed only after reading them.

### S15. Git transport and configuration

- Pinned `known_hosts` with `StrictHostKeyChecking=yes` and `IdentitiesOnly`.
- `/usr/bin/ssh -F none`, so no user or system ssh configuration applies.
- In the sidecar, `GIT_CONFIG_GLOBAL=/dev/null` and `GIT_CONFIG_NOSYSTEM=1`,
  an explicit `PATH`, and a working directory inside its own checkout.
- git runs through `execFile`, never a shell; repository URLs come only from
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

Collected from the verification notes above:

1. The memory key is absent from `hermes`: inspect, `/run/secrets`, process
   environments (S1).
2. A symlinked bundle is rejected and nothing is pushed (S2).
3. Root in `hermes` cannot write the restore volume or reach the sidecar
   (S3).
4. A fixture session containing a fake token is pushed redacted (S5).
5. A platform token without an allowlist stops the container (S6).
6. No service publishes ports (S9).
7. All three services run hardened, unmodified (S10).
