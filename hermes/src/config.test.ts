import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { type TestContext, test } from "node:test";
import {
    type ApplyDeps,
    ApplyInterrupted,
    applyConfig,
    bootCheck,
    configPaths,
    copyConfig,
    skillsWarning,
} from "./config.ts";
import { Git } from "./git.ts";
import type { GatewayStatus } from "./hermes.ts";
import { type ApplyStatus, readJson } from "./status.ts";
import {
    bareRepo,
    fakeClock,
    fakeHermes,
    GIT_ENV,
    pushFiles,
    tempDir,
} from "./test-helpers.ts";

const GOOD =
    "skills:\n    external_dirs:\n        - /opt/data/dorothy/config/skills\n";
const BROKEN = `${GOOD}# broken\n`;

/**
 * A gateway that is down while config.yaml says "broken", with a new pid per
 * restart. After a restart the old pid stays up for lingerMs (draining), then
 * the new one takes startDelayMs to come up.
 */
function fakeGateway(
    home: string,
    clock: { now(): number },
    startDelayMs = 0,
    lingerMs = 0,
) {
    let pid = 100;
    let since = Number.NEGATIVE_INFINITY;
    return {
        restart() {
            pid += 1;
            since = clock.now();
        },
        status(): GatewayStatus {
            if (clock.now() - since < lingerMs)
                return { up: true, pid: pid - 1 };
            if (
                readFileSync(join(home, "config.yaml"), "utf8").includes(
                    "broken",
                )
            )
                return { up: false, pid: null };
            if (clock.now() - since < lingerMs + startDelayMs)
                return { up: false, pid: null };
            return { up: true, pid };
        },
    };
}

async function setup(t: TestContext, startDelayMs = 0, lingerMs = 0) {
    const url = bareRepo(t);
    const first = pushFiles(t, url, {
        "SOUL.md": "soul 1",
        "config.yaml": GOOD,
    });
    const paths = configPaths(join(tempDir(t), "data"));
    const git = new Git(paths.checkout, { env: GIT_ENV });
    await git.clone(url);
    copyConfig(paths.checkout, paths.home);
    const clock = fakeClock();
    const gateway = fakeGateway(paths.home, clock, startDelayMs, lingerMs);
    const hermes = fakeHermes({
        status: gateway.status,
        restart: gateway.restart,
    });
    const logs: string[] = [];
    const deps: ApplyDeps = {
        ...clock,
        git,
        hermes,
        paths,
        log: (m) => logs.push(m),
    };
    return { url, first, paths, deps, hermes, logs };
}

const status = (path: string) => readJson<ApplyStatus>(path) ?? {};

test("a good push is applied and becomes last-good", async (t) => {
    const { url, paths, deps, hermes } = await setup(t);
    const sha = pushFiles(t, url, { "SOUL.md": "soul 2" });
    assert.equal(await applyConfig(deps), "applied");
    assert.equal(readFileSync(join(paths.home, "SOUL.md"), "utf8"), "soul 2");
    assert.equal(
        readFileSync(join(paths.lastGood, "SOUL.md"), "utf8"),
        "soul 2",
    );
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
        status: () =>
            stopped ? { up: false, pid: null } : { up: true, pid: 300 },
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
    assert.equal(
        readFileSync(join(paths.lastGood, "config.yaml"), "utf8"),
        GOOD,
    );
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

test("a shutdown during the gateway test neither rolls back nor records", async (t) => {
    const { url, paths, deps } = await setup(t, 20_000);
    const sha = pushFiles(t, url, { "SOUL.md": "soul 2" });
    const controller = new AbortController();
    const gateway = fakeGateway(paths.home, deps, 20_000);
    // Once the container stops, every CLI call fails, so the slot reads as gone.
    const hermes = fakeHermes({
        status: () => (controller.signal.aborted ? null : gateway.status()),
        restart: gateway.restart,
    });
    const sleep = deps.sleep;
    const stopping: ApplyDeps = {
        ...deps,
        hermes,
        signal: controller.signal,
        sleep: async (ms) => {
            controller.abort();
            await sleep(ms);
        },
    };
    await assert.rejects(applyConfig(stopping), ApplyInterrupted);
    assert.equal(status(paths.applyStatus).rolledBackSha, undefined);
    assert.notEqual(status(paths.applyStatus).appliedSha, sha);
    assert.deepEqual(hermes.calls, ["restart", "start"]);
});

test("a shutdown while the boot check waits for the slot stops it", async (t) => {
    const { deps, logs } = await setup(t);
    const controller = new AbortController();
    const stopping: ApplyDeps = {
        ...deps,
        hermes: fakeHermes({ status: () => null }),
        signal: controller.signal,
        sleep: async (ms) => {
            controller.abort();
            await deps.sleep(ms);
        },
    };
    await assert.rejects(bootCheck(stopping), ApplyInterrupted);
    assert.equal(
        logs.some((m) => /never registered/.test(m)),
        false,
    );
});

test("missing config files are named", async (t) => {
    const dir = tempDir(t);
    assert.throws(
        () => copyConfig(dir, join(dir, "out")),
        /SOUL\.md is missing/,
    );
});

test("the external_dirs warning", () => {
    assert.equal(skillsWarning(GOOD), null);
    assert.match(skillsWarning("model: x\n") ?? "", /skills\.external_dirs/);
});
