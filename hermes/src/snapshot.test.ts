import assert from "node:assert/strict";
import {
    existsSync,
    mkdirSync,
    readdirSync,
    readFileSync,
    rmSync,
    symlinkSync,
    writeFileSync,
} from "node:fs";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { type TestContext, test } from "node:test";
import { type Bundle, fileBytes, openBundle } from "./bundle.ts";
import { configPaths, copyConfig } from "./config.ts";
import { Git } from "./git.ts";
import type { ContainerPaths } from "./hermes.ts";
import { type SnapshotDeps, snapshotOnce } from "./snapshot.ts";
import { readJson, writeJson } from "./status.ts";
import {
    bareRepo,
    type FakeHermes,
    fakeClock,
    fakeHermes,
    GIT_ENV,
    pushFiles,
    tempDir,
    writeFiles,
} from "./test-helpers.ts";

const GENERATION = "0123456789abcdef0123456789abcdef";
const GOOD =
    "skills:\n    external_dirs:\n        - /opt/data/dorothy/config/skills\n";

function snapshotter(
    home: string,
    options: {
        failedDbs?: string[];
        corrupt?: boolean;
        failures?: number;
    } = {},
) {
    let n = 0;
    let failures = options.failures ?? 0;
    return async (label: string): Promise<string> => {
        if (failures > 0) {
            failures -= 1;
            throw new Error("backup lock held");
        }
        const dir = join(
            home,
            "state-snapshots",
            `20261003-00000${n++}-${label}`,
        );
        mkdirSync(join(dir, "cron"), { recursive: true });
        if (options.corrupt) {
            writeFileSync(
                join(dir, "state.db"),
                "not a database at all, just text",
            );
        } else {
            const db = new DatabaseSync(join(dir, "state.db"));
            db.exec(
                "CREATE TABLE messages (id INTEGER PRIMARY KEY, content TEXT, data BLOB)",
            );
            db.prepare(
                "INSERT INTO messages (content, data) VALUES (?, ?)",
            ).run(
                "my token is telegram-secret-123",
                Buffer.from("telegram-secret-123"),
            );
            db.close();
        }
        writeFileSync(
            join(dir, "manifest.json"),
            JSON.stringify({ failed_dbs: options.failedDbs ?? [] }),
        );
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
    symlinkSync(
        join(paths.home, "outside.txt"),
        join(paths.home, "skills/cat/mine/link.md"),
    );
    writeJson(paths.restore, {
        version: 1,
        createdAt: "2026-10-03T00:00:00.000Z",
        generation: GENERATION,
        seed: true,
        files: [],
    });
    const url = bareRepo(t);
    const applied = pushFiles(t, url, {
        "SOUL.md": "soul 1",
        "config.yaml": GOOD,
    });
    const config = configPaths(paths.home);
    await new Git(config.checkout, { env: GIT_ENV }).clone(url);
    copyConfig(config.checkout, paths.home);
    writeJson(config.applyStatus, { appliedSha: applied });
    const hermes = hermesFor(paths.home);
    const logs: string[] = [];
    const deps: SnapshotDeps = {
        ...fakeClock(),
        env: {
            TELEGRAM_BOT_TOKEN: "telegram-secret-123",
            DOROTHY_SYNC_INTERVAL: "900",
        },
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

const status = (paths: ContainerPaths) =>
    readJson<{ lastSuccessAt?: string; lastError?: string }>(
        join(paths.home, "dorothy/status/snapshot.json"),
    ) ?? {};

test("nothing happens before the first restore", async (t) => {
    const { paths, hermes, deps } = await setup(t, (home) =>
        fakeHermes({ snapshot: snapshotter(home) }),
    );
    rmSync(join(paths.home, "dorothy/restored"));
    assert.equal(await snapshotOnce(deps), false);
    assert.equal(existsSync(paths.outbox), false);
    assert.deepEqual(hermes.calls, []);
});

test("the bundle holds the right files, redacted, with the restore generation", async (t) => {
    const { paths, deps } = await setup(t, (home) =>
        fakeHermes({ snapshot: snapshotter(home) }),
    );
    assert.equal(await snapshotOnce(deps), true);
    const bundle = outbox(paths);
    assert.equal(bundle.generation, GENERATION);
    assert.deepEqual(
        bundle.files.map((f) => f.path),
        [
            "sessions/state.sql",
            "cron/jobs.json",
            "memories/MEMORY.md",
            "skills/cat/mine/SKILL.md",
        ],
    );
    const sql = bundle.files[0]?.content ?? "";
    assert.equal(sql.includes("telegram-secret-123"), false);
    assert.ok(sql.includes("'my token is [REDACTED:TELEGRAM_BOT_TOKEN]'"));
    assert.ok(
        sql.includes(
            `X'${Buffer.from("[REDACTED:TELEGRAM_BOT_TOKEN]").toString("hex").toUpperCase()}'`,
        ),
    );
    const memory = bundle.files.find((f) => f.path === "memories/MEMORY.md");
    assert.equal(
        memory && fileBytes(memory).toString(),
        "the api key is [REDACTED:API_SERVER_KEY]",
    );
    assert.deepEqual(readdirSync(join(paths.home, "state-snapshots")), []);
    assert.ok(status(paths).lastSuccessAt);
});

test("a failed state.db copy fails the snapshot and still cleans up", async (t) => {
    const { paths, deps } = await setup(t, (home) =>
        fakeHermes({
            snapshot: snapshotter(home, { failedDbs: ["state.db"] }),
        }),
    );
    await assert.rejects(snapshotOnce(deps), /could not copy state\.db/);
    assert.deepEqual(readdirSync(join(paths.home, "state-snapshots")), []);
    assert.equal(existsSync(paths.outbox), false);
    assert.match(status(paths).lastError ?? "", /state\.db/);
});

test("a database that fails its table check fails the snapshot", async (t) => {
    const { paths, deps } = await setup(t, (home) =>
        fakeHermes({ snapshot: snapshotter(home, { corrupt: true }) }),
    );
    await assert.rejects(snapshotOnce(deps));
    assert.equal(existsSync(paths.outbox), false);
});

test("the fallback apply skips a held apply.lock", async (t) => {
    const { paths, logs, deps } = await setup(t, (home) =>
        fakeHermes({ snapshot: snapshotter(home) }),
    );
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
    const { hermes, deps } = await setup(t, (home) =>
        fakeHermes({ snapshot: snapshotter(home, { failures: 2 }) }),
    );
    assert.equal(await snapshotOnce(deps, { final: true }), true);
    assert.equal(
        hermes.calls.filter((c) => c.startsWith("snapshot")).length,
        3,
    );
});
