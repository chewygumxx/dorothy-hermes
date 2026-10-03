---
__cgxx: |
  # vim:set expandtab shiftwidth=2 filetype=markdown foldlevel=3:
  # SPDX-License-Identifier: GPL-3.0-only

  #
  #
  # ~chewygumxx/dorothy-hermes.git
  # ::: :/docs/notes/2026-10-03-upstream-probe.md
  #
  #

ctime: 2026-10-03
title: Upstream image probe
description: "Facts about the pinned Hermes image that the plan depends on"
tags:
  - dorothy
  - hermes
  - notes
---

# Upstream image probe

Task 1 of the [live deploy plan](../plans/2026-10-03-hermes-live-deploy.md),
run on 2026-10-03 against Docker 29.8.1 on Arch Linux (kernel 7.2.7).

```sh
IMAGE='nousresearch/hermes-agent:v2026.9.24@sha256:fca358f12efd65bfaaca05884166f15c0e2788375ca30d77061ac1ebc96452b7'
```

## 1. Pull and digest

`docker pull "$IMAGE"` succeeded. `docker buildx` is not installed locally,
so the tag was pulled on its own and its `RepoDigests` read instead:

```text
["nousresearch/hermes-agent@sha256:fca358f12efd65bfaaca05884166f15c0e2788375ca30d77061ac1ebc96452b7"]
```

Conclusion: the tag `v2026.9.24` still resolves to the pinned digest.

## 2. Runtime facts

```text
$ node --version
v26.5.1
/command/s6-setuidgid -> ../package/admin/s6/command/s6-setuidgid
/command/s6-svstat -> ../package/admin/s6/command/s6-svstat
/opt/hermes/.venv/bin/python -> /usr/bin/python3
/opt/hermes/bin/hermes
/usr/bin/git
/usr/bin/ssh
uid=10000(hermes) gid=10000(hermes) groups=10000(hermes)
```

Conclusion: every path exists and `hermes` is UID 10000. The image's Node is
**26.5.1**, not the 26.7.0 the plan and spec assumed (that number came from a
newer local canary install). `mise.toml` pins 26.5.1.

## 3, 4. Platform registry

`scripts/platforms.py` imported every upstream name it uses without change.
`hermes/src/platforms.json` lists 20 platforms:

```text
bluebubbles dingtalk discord email feishu homeassistant matrix mattermost
qqbot relay signal slack sms telegram wecom wecom_callback weixin whatsapp
whatsapp_cloud yuanbao
```

Telegram reads `enabledBy: ["TELEGRAM_BOT_TOKEN"]`,
`allowedUsers: "TELEGRAM_ALLOWED_USERS"`,
`allowAllUsers: "TELEGRAM_ALLOW_ALL_USERS"`. The eight extra variables are:

```text
DISCORD_ALLOWED_ROLES DISCORD_ALLOW_BOTS FEISHU_ALLOW_BOTS
QQ_GROUP_ALLOWED_USERS SLACK_ALLOW_BOTS TELEGRAM_ALLOW_BOTS
TELEGRAM_GROUP_ALLOWED_CHATS TELEGRAM_GROUP_ALLOWED_USERS
```

Conclusion: the S6 open item is closed. No plugin platform in this image
declares an allow-all switch outside the main table.

## 5. tmpfs at the `VOLUME` path

```text
$ docker run --name probe-vol --tmpfs /opt/data --entrypoint /bin/true "$IMAGE"
$ docker inspect probe-vol --format '{{json .Mounts}}'
[]
```

Conclusion: a tmpfs at `/opt/data` stops Docker creating an anonymous
volume, so `dorothy-sync` can use one.

## 6, 7. Hardened boot without credentials

The volume was seeded with `smoke/fixtures/config/config.yaml`, then the
gateway started with `--cap-drop ALL`, the six initial capabilities,
`no-new-privileges`, `--tmpfs /run:exec`, `--pids-limit 512` and
`--memory 4g`. After 90 s:

```text
$ s6-svstat -o up,pid /run/service/gateway-default
true 149
$ grep -iE ":21C2 [0-9A-F]+:0000 0A" /proc/net/tcp /proc/net/tcp6
/proc/net/tcp:   0: 0100007F:21C2 00000000:0000 0A ... 10000 ...
$ ls -l /opt/data/state.db
-rw------- 1 hermes hermes 270336 Oct  3 12:25 /opt/data/state.db
no permission errors
```

Conclusions:

- A credential-free gateway stays up.
- The API server, enabled by the key upstream generates, listens on
  `127.0.0.1:8642` only, and is the only listening socket. This closes the
  S9 open item: it is not reachable even from the compose network.
- `state.db` exists before any conversation, so the seed deploy's first
  snapshot has a database to back up.

## 8. Minimal `cap_add`

Each capability was removed in turn, then the survivors were checked
through a gateway restart and `docker stop`:

| Removed        | Result                                                       |
| -------------- | ------------------------------------------------------------ |
| `CHOWN`        | container exits 1: `Permission denied: '/opt/data/.env'`      |
| `DAC_OVERRIDE` | s6 cannot open its supervise locks; the slot never comes up  |
| `SETUID`       | container exits 1: `s6-applyuidgid: unable to setuid`        |
| `SETGID`       | container exits 1: `unable to set supplementary group list`  |
| `KILL`         | boots, but `hermes gateway restart` leaves the old pid running and `docker stop` waits 90 s for SIGKILL (exit 137) |
| `FOWNER`       | boots, restarts (pid 149 to 388 within 1 s), stops in 4 s with exit 0, no permission errors |

Conclusion: `cap_add: [CHOWN, DAC_OVERRIDE, SETUID, SETGID, KILL]`. `KILL`
is needed because s6-supervise runs as root and signals the gateway, which
runs as UID 10000; boot alone does not show it.

## 9. Restart timing and a config that stops the gateway

A restart on an idle gateway (polling every 0.5 s):

```text
restart exit 0 after 1.47s
1.469 true 149
2.012 false -1
2.557 true 411
```

The old pid left after about 2 s and the new one was up 0.5 s later. A
restart issued within seconds of an earlier restart took 16 to 18 s for the
old pid to leave (candidates B, C and E below); the new pid was up within
1 s after that. Coming up never approached the 25 s limit.

Drain budget: `agent.cron_drain_timeout` defaults to 30 s and
`agent.restart_drain_timeout` to 0 (`hermes_cli.config.DEFAULT_CONFIG`). The
plan's 90 s drain bound covers the cron drain plus shutdown.

Candidates, timed from `hermes gateway restart` (`up pid wantedup exitcode`):

| Candidate                             | Up      | Exit             | Up to exit | Qualifies |
| ------------------------------------- | ------- | ---------------- | ---------- | --------- |
| A: Telegram with a rejected token     | 2.6 s   | 27.8 s, code 78  | 25 s       | no        |
| B: API server on `203.0.113.7`        | 19.4 s  | stayed up        | none       | no        |
| C: unparseable YAML                   | 17.4 s  | stayed up        | none       | no        |
| D: WhatsApp with `dm_policy: open`    | 2.7 s   | 6.9 s, code 0    | 4 s        | yes       |
| E: QQ with `dm_policy: open`          | 17.1 s  | 21.3 s, code 0   | 4 s        | yes       |

- A waits for DNS-over-HTTPS discovery and Telegram's rejection, so it
  fails after the gateway test has passed: exactly the late failure the
  6 s rule excludes. It also needs the network.
- B logs `Could not bind 203.0.113.7:8642` and keeps running; only a port
  already in use is a fatal API server error.
- C: upstream now keeps running on its own last good settings when
  `config.yaml` does not parse ("Hermes is running on your last good
  settings until it is fixed"). A YAML error therefore never stops the
  gateway, and our rollback does not see it.
- D logs `Refusing to start: whatsapp has dm_policy/group_policy set to
  'open' but neither GATEWAY_ALLOW_ALL_USERS nor WHATSAPP_ALLOW_ALL_USERS is
  enabled.` and exits cleanly (code 0) with the slot wanted down. The check
  runs before any adapter connects, so it needs no network.

Conclusion: D becomes `smoke/fixtures/config-broken.yaml`. It exits 0, not
78; `config.ts` already treats a slot that stopped itself either way.

## 10. CJK tokenizer, search and `optimize-storage`

```text
$ find / -xdev -name "libfts5_cjk*"
(none)
$ python /tmp/probe-search.py
0
```

`SessionDB().search_messages` imports and runs. No CJK tokenizer library
ships, so CJK search relies on the trigram index and boot step 3.4 only
compacts.

`hermes sessions optimize-storage --yes` refuses while the gateway holds
`state.db`:

```text
Refusing `hermes sessions optimize-storage`: another process is using /opt/data/state.db.
  PID 3038 (python3 /opt/hermes/.venv/bin/hermes gateway run --replace): state.db, ...
exit 1
```

With the gateway stopped, on a fresh database (the em dash upstream prints is
written `\u2014` here):

```text
Search index is already on the compact layout \u2014 nothing to do.
exit 0
```

From `hermes_cli/sessions_cmd.py`, the low-disk outcome prints
`⚠ Not enough free disk to complete safely.` and also exits 0, so bootstrap
must read the text, not the exit code. Bootstrap runs from `cont-init.d`,
before the gateway starts, so the live-writer refusal does not apply to it.

## Effects on the plan

- Node: the image ships **26.5.1**. Task 2 pins `node = "26.5.1"`; the suite
  must pass under it. Task 18 corrects the spec's "Node 26.7".
- `cap_add`: `[CHOWN, DAC_OVERRIDE, SETUID, SETGID, KILL]`; `FOWNER` is
  dropped (Task 15).
- Broken config: candidate D (`dm_policy: open` on WhatsApp), exit code 0.
- Timings: up within 1 s of the old pid leaving; the old pid leaves within
  2 s when idle and within 18 s after a recent restart. The 30 s up window
  and 90 s drain bound stand.
- Digest unchanged; API server bound to loopback (S9 closed); tmpfs at
  `VOLUME` confirmed; no CJK tokenizer.
- New: upstream survives an unparseable `config.yaml` on its own last good
  settings, so the gateway test cannot catch YAML errors. A config with a
  syntax error is recorded as applied and copied to `last-good/`. Task 18
  records this in the spec.
