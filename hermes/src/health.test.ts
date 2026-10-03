// vim:set expandtab shiftwidth=4 filetype=typescript:
// SPDX-License-Identifier: GPL-3.0-only

//
//
// ~chewygumxx/dorothy-hermes.git
// ::: :/hermes/src/health.test.ts
//
//

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
    writeJson(join(paths.home, "dorothy/status/snapshot.json"), {
        lastSuccessAt: ago(10),
    });
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
        hermes: fakeHermes({
            status: () =>
                up ? { up: true, pid: 1 } : { up: false, pid: null },
        }),
        now: () => NOW,
    });

test("a healthy container reports nothing", async (t) => {
    assert.deepEqual(await check(healthy(t)), []);
});

test("each failure is reported", async (t) => {
    const paths = healthy(t);
    writeJson(join(paths.home, "dorothy/status/apply.json"), {
        configRolledBack: true,
    });
    writeJson(join(paths.home, "dorothy/status/snapshot.json"), {
        lastSuccessAt: ago(60),
    });
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
    writeJson(join(paths.home, "dorothy/status/snapshot.json"), {
        lastSuccessAt: ago(600),
    });
    assert.deepEqual(await check(paths), []);
});

test("a missing restore marker is unhealthy", async (t) => {
    const paths = healthy(t);
    rmSync(join(paths.home, "dorothy/restored"));
    assert.deepEqual(await check(paths), ["not restored yet"]);
});

test("the sidecar is healthy only after this run's restore.json", () => {
    const base = {
        startedAt: ago(2),
        pendingCommits: 0,
        pushRejected: false,
        largestFileBytes: 0,
        sizeWarning: false,
    };
    assert.deepEqual(sidecarHealth(null, 900, NOW), ["no status"]);
    assert.deepEqual(sidecarHealth(base, 900, NOW), [
        "restore.json not written by this run",
    ]);
    assert.deepEqual(
        sidecarHealth(
            { ...base, restoreWrittenAt: ago(1), loopAt: ago(1) },
            900,
            NOW,
        ),
        [],
    );
    assert.deepEqual(
        sidecarHealth(
            { ...base, restoreWrittenAt: ago(1), loopAt: ago(30) },
            900,
            NOW,
        ),
        ["the publish loop has stalled"],
    );
});
