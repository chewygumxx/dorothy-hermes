// vim:set expandtab shiftwidth=4 filetype=typescript:
// SPDX-License-Identifier: GPL-3.0-only

//
//
// ~chewygumxx/dorothy-hermes.git
// ::: :/hermes/src/sidecar.test.ts
//
//

import assert from "node:assert/strict";
import {
    existsSync,
    mkdirSync,
    readFileSync,
    renameSync,
    rmSync,
    symlinkSync,
    writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { type TestContext, test } from "node:test";
import { type Bundle, encodeFile, writeBundle } from "./bundle.ts";
import type { SidecarSettings } from "./settings.ts";
import {
    commitMessage,
    Sidecar,
    type SidecarDeps,
    type SidecarPaths,
    sidecarPaths,
} from "./sidecar.ts";
import { readJson } from "./status.ts";
import {
    bareRepo,
    fakeClock,
    GIT_ENV,
    git,
    pushFiles,
    remoteMain,
    remoteShow,
    tempDir,
    writeFiles,
} from "./test-helpers.ts";

const KEY =
    "-----BEGIN OPENSSH PRIVATE KEY-----\nAAAA\n-----END OPENSSH PRIVATE KEY-----\n";
const FULL = { "sessions/state.sql": "SQL 1", "memories/MEMORY.md": "m1" };

function sidecarDeps(
    dir: string,
    url: string,
    settings: Partial<SidecarSettings> = {},
) {
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

async function started(
    t: TestContext,
    url: string,
    settings: Partial<SidecarSettings> = {},
    dir = tempDir(t),
) {
    const { deps, logs } = sidecarDeps(dir, url, settings);
    const sidecar = new Sidecar(deps);
    await sidecar.start();
    return { dir, deps, logs, sidecar, paths: deps.paths };
}

function outbox(
    paths: SidecarPaths,
    generation: string,
    files: Record<string, string>,
): string {
    return writeBundle(paths.outbox, {
        version: 1,
        createdAt: new Date().toISOString(),
        generation,
        seed: false,
        files: Object.entries(files).map(([path, content]) =>
            encodeFile(path, Buffer.from(content), 0o644),
        ),
    });
}

const restoreOf = (paths: SidecarPaths) => readJson<Bundle>(paths.restore);
const statusOf = (paths: SidecarPaths) =>
    readJson<{
        lastError?: string;
        pushRejected: boolean;
        pendingCommits: number;
        sizeWarning: boolean;
        lastSuccessAt?: string;
    }>(paths.status);
const remoteLog = (url: string, format: string) =>
    git(
        [
            "--git-dir",
            url.slice("file://".length),
            "log",
            "-1",
            `--format=${format}`,
            "main",
        ],
        tmpdir(),
    ).trim();

test("a first deployment seeds, and the first publish creates main", async (t) => {
    const url = bareRepo(t);
    const { sidecar, paths } = await started(t, url);
    assert.equal(restoreOf(paths)?.seed, true);
    assert.match(sidecar.generation, /^[0-9a-f]{32}$/);
    const hash = outbox(paths, sidecar.generation, FULL);
    await sidecar.cycle();
    assert.equal(remoteShow(url, "memories/MEMORY.md"), "m1");
    assert.equal(
        remoteLog(url, "%B"),
        "chore(sync): Snapshot from test-host\n\nChanged: sessions, memories.",
    );
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
    const head = pushFiles(t, url, {
        ...FULL,
        "README.md": "x",
        "skills/a/b/SKILL.md": "s",
    });
    const { paths } = await started(t, url);
    const restore = restoreOf(paths);
    assert.equal(restore?.memorySha, head);
    assert.deepEqual(
        restore?.files.map((f) => f.path),
        ["sessions/state.sql", "memories/MEMORY.md", "skills/a/b/SKILL.md"],
    );
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
    outbox(paths, sidecar.generation, {
        ...FULL,
        "memories/OLD.md": "old",
        "cron/jobs.json": "{}",
    });
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
    assert.ok(
        logs.some((m) => m.includes("ignoring a bundle from generation")),
    );
});

test("the empty-state guard refuses, and its override allows", async (t) => {
    const url = bareRepo(t);
    const { sidecar, paths, dir } = await started(t, url);
    outbox(paths, sidecar.generation, FULL);
    await sidecar.cycle();
    outbox(paths, sidecar.generation, { "sessions/state.sql": "SQL 2" });
    await sidecar.cycle();
    assert.match(
        statusOf(paths)?.lastError ?? "",
        /refusing a bundle without memories\/MEMORY\.md/,
    );
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
    assert.equal(
        restoreOf(paths)?.files.find((f) => f.path === "memories/MEMORY.md")
            ?.content,
        "m2",
    );

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
    assert.match(
        statusOf(paths)?.lastError ?? "",
        /refusing a bundle without memories\/MEMORY\.md/,
    );
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
    assert.equal(
        files.find((f) => f.path === "memories/MEMORY.md")?.content,
        "m1",
    );
    assert.equal(
        files.some((f) => f.path === "memories/STRAY.md"),
        false,
    );
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

test("an interrupted first clone is cloned again, never served as a seed", async (t) => {
    const url = bareRepo(t);
    pushFiles(t, url, FULL);
    const dir = tempDir(t);
    const { deps } = sidecarDeps(dir, url);
    // A clone killed part-way: .git and origin exist, no refs, no generation.
    mkdirSync(deps.paths.checkout, { recursive: true });
    git(["init", "--quiet"], deps.paths.checkout);
    git(["remote", "add", "origin", url], deps.paths.checkout);
    const bare = url.slice("file://".length);
    renameSync(bare, `${bare}.away`);
    await assert.rejects(
        new Sidecar(deps).start(),
        /clone dorothy-memory kept failing/,
    );
    assert.equal(restoreOf(deps.paths), null);
    renameSync(`${bare}.away`, bare);
    const { paths } = await started(t, url, {}, dir);
    const restore = restoreOf(paths);
    assert.equal(restore?.seed, false);
    assert.equal(
        restore?.files.find((f) => f.path === "memories/MEMORY.md")?.content,
        "m1",
    );
});

test("the empty-state guard sees files the fast-forward brings in", async (t) => {
    const url = bareRepo(t);
    const { sidecar, paths } = await started(t, url);
    outbox(paths, sidecar.generation, { "sessions/state.sql": "SQL 1" });
    await sidecar.cycle();
    pushFiles(t, url, { "memories/MEMORY.md": "human" });
    outbox(paths, sidecar.generation, { "sessions/state.sql": "SQL 2" });
    await sidecar.cycle();
    assert.match(
        statusOf(paths)?.lastError ?? "",
        /refusing a bundle without memories\/MEMORY\.md/,
    );
    assert.equal(remoteShow(url, "memories/MEMORY.md"), "human");
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
    outbox(deps.paths, sidecar.generation, {
        ...FULL,
        "sessions/state.sql": "x".repeat(15),
    });
    await sidecar.cycle();
    assert.equal(statusOf(deps.paths)?.sizeWarning, true);
    outbox(deps.paths, sidecar.generation, {
        ...FULL,
        "sessions/state.sql": "x".repeat(25),
    });
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
        commitMessage("srv", [
            "sessions/state.sql",
            "skills/a/b/SKILL.md",
            "cron/jobs.json",
        ]),
        "chore(sync): Snapshot from srv\n\nChanged: sessions, skills, scheduled jobs.",
    );
});
