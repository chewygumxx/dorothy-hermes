import assert from "node:assert/strict";
import {
    existsSync,
    mkdirSync,
    readFileSync,
    renameSync,
    writeFileSync,
} from "node:fs";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { type TestContext, test } from "node:test";
import {
    type BootstrapDeps,
    bootstrap,
    writeRestoredFiles,
} from "./bootstrap.ts";
import { type Bundle, encodeFile, writeBundle } from "./bundle.ts";
import { dumpDatabase } from "./dump.ts";
import type { ContainerPaths } from "./hermes.ts";
import type { PlatformRegistry } from "./settings.ts";
import { type ApplyStatus, readJson, writeJson } from "./status.ts";
import {
    bareRepo,
    fakeClock,
    fakeHermes,
    GIT_ENV,
    pushFiles,
    tempDir,
    writeFiles,
} from "./test-helpers.ts";

const GOOD =
    "skills:\n    external_dirs:\n        - /opt/data/dorothy/config/skills\n";
const GENERATION = "0123456789abcdef0123456789abcdef";
const KEY = Buffer.from(
    "-----BEGIN OPENSSH PRIVATE KEY-----\nAAAA\n-----END OPENSSH PRIVATE KEY-----\n",
).toString("base64");
const REGISTRY: PlatformRegistry = {
    platforms: {
        telegram: {
            enabledBy: ["TELEGRAM_BOT_TOKEN"],
            allowedUsers: "TELEGRAM_ALLOWED_USERS",
            allowAllUsers: "TELEGRAM_ALLOW_ALL_USERS",
        },
    },
    globalAllowlist: "GATEWAY_ALLOWED_USERS",
    globalAllowAll: "GATEWAY_ALLOW_ALL_USERS",
    extraAllowVariables: [],
};

function stateSql(t: TestContext): string {
    const path = join(tempDir(t), "source.db");
    const db = new DatabaseSync(path);
    db.exec(
        "CREATE TABLE messages (id INTEGER PRIMARY KEY, content TEXT); INSERT INTO messages (content) VALUES ('hello from the fixture');",
    );
    db.close();
    return dumpDatabase(path);
}

function restoreBundle(
    files: Record<string, string>,
    extra: Partial<Bundle> = {},
): Bundle {
    return {
        version: 1,
        createdAt: "2026-10-03T00:00:00.000Z",
        generation: GENERATION,
        memorySha: "a".repeat(40),
        seed: false,
        files: Object.entries(files).map(([path, content]) =>
            encodeFile(path, Buffer.from(content), 0o644),
        ),
        ...extra,
    };
}

async function setup(
    t: TestContext,
    configFiles: Record<string, string> = {
        "SOUL.md": "soul",
        "config.yaml": GOOD,
    },
) {
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
    writeJson(
        paths.restore,
        restoreBundle({
            "sessions/state.sql": stateSql(t),
            "memories/MEMORY.md": "remembered",
        }),
    );
    const hermes = fakeHermes();
    const logs: string[] = [];
    const deps: BootstrapDeps = {
        ...fakeClock(),
        env: {
            DOROTHY_CONFIG_REPO: url,
            DOROTHY_CONFIG_REPO_NAME: "test/config",
            DOROTHY_CONFIG_DEPLOY_KEY: KEY,
        },
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
    const rows = db.prepare("SELECT content FROM messages").all() as {
        content: string;
    }[];
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
    assert.equal(
        readFileSync(join(paths.home, "memories/MEMORY.md"), "utf8"),
        "remembered",
    );
    assert.equal(existsSync(join(paths.home, "memories/STALE.md")), false);
    assert.equal(existsSync(join(paths.home, "skills/cat/mine/old.md")), false);
    assert.equal(
        existsSync(join(paths.home, "skills/cat/bundled/SKILL.md")),
        true,
    );
    assert.equal(
        readFileSync(join(paths.home, "cron/jobs.json"), "utf8"),
        "{}",
    );
    assert.deepEqual(hermes.calls, ["optimize"]);
    assert.equal(
        readJson<{ memorySha: string }>(join(paths.home, "dorothy/restored"))
            ?.memorySha,
        "a".repeat(40),
    );
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
    writeJson(paths.restore, {
        ...restoreBundle({}),
        memorySha: undefined,
        seed: true,
    });
    await bootstrap(deps);
    assert.equal(existsSync(join(paths.home, "state.db")), false);
    assert.equal(
        readJson<{ generation: string }>(join(paths.home, "dorothy/restored"))
            ?.generation,
        GENERATION,
    );
    assert.deepEqual(hermes.calls, []);
});

test("restore waits for the sidecar to consume the outbox", async (t) => {
    const { paths, logs, deps } = await setup(t);
    const hash = writeBundle(
        paths.outbox,
        restoreBundle(
            { "memories/MEMORY.md": "newer" },
            { memorySha: undefined },
        ),
    );
    let slept = 0;
    deps.sleep = async () => {
        slept += 1;
        const restore = readJson<Bundle>(paths.restore);
        writeJson(paths.restore, { ...restore, bundleHash: hash });
    };
    await bootstrap(deps);
    assert.equal(slept, 1);
    assert.equal(
        logs.some((m) => m.includes("has not consumed")),
        false,
    );
});

test("the outbox wait gives up after two minutes", async (t) => {
    const { paths, logs, deps } = await setup(t);
    writeBundle(
        paths.outbox,
        restoreBundle(
            { "memories/MEMORY.md": "newer" },
            { memorySha: undefined },
        ),
    );
    await bootstrap(deps);
    assert.ok(logs.some((m) => m.includes("has not consumed")));
    assert.ok(existsSync(join(paths.home, "dorothy/restored")));
});

test("an outbox from another generation does not delay the restore", async (t) => {
    const { paths, deps } = await setup(t);
    writeBundle(
        paths.outbox,
        restoreBundle({}, { generation: "f".repeat(32), memorySha: undefined }),
    );
    const before = deps.now();
    await bootstrap(deps);
    assert.equal(deps.now(), before);
});

test("a rolled-back head is not copied in", async (t) => {
    const { configSha, paths, deps } = await setup(t);
    writeFiles(paths.home, {
        "SOUL.md": "last good",
        "dorothy/restored": "{}",
    });
    writeJson(join(paths.home, "dorothy/status/apply.json"), {
        rolledBackSha: configSha,
    });
    await bootstrap(deps);
    assert.equal(
        readFileSync(join(paths.home, "SOUL.md"), "utf8"),
        "last good",
    );
});

test("an unreachable remote reuses the existing checkout", async (t) => {
    const { url, logs, deps } = await setup(t);
    await bootstrap(deps);
    renameSync(
        url.slice("file://".length),
        `${url.slice("file://".length)}.gone`,
    );
    await bootstrap(deps);
    assert.ok(logs.some((m) => m.startsWith("GitHub unreachable")));
});

test("an unreachable remote without a checkout fails after retrying", async (t) => {
    const { deps } = await setup(t);
    deps.env = {
        ...deps.env,
        DOROTHY_CONFIG_REPO: "file:///nonexistent/config.git",
    };
    await assert.rejects(
        bootstrap(deps),
        /clone dorothy-config kept failing for 5 s/,
    );
});

test("restoring a category file keeps the category's bundled skills", (t) => {
    const home = tempDir(t);
    writeFiles(home, {
        "skills/cat/bundled/SKILL.md": "bundled",
        "skills/cat/mine/old.md": "old",
    });
    writeRestoredFiles(home, [
        encodeFile("skills/cat/DESCRIPTION.md", Buffer.from("cat"), 0o644),
        encodeFile("skills/cat/mine/SKILL.md", Buffer.from("mine"), 0o644),
    ]);
    assert.equal(
        readFileSync(join(home, "skills/cat/bundled/SKILL.md"), "utf8"),
        "bundled",
    );
    assert.equal(
        readFileSync(join(home, "skills/cat/DESCRIPTION.md"), "utf8"),
        "cat",
    );
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
    assert.equal(
        readFileSync(join(paths.home, ".env"), "utf8"),
        "# upstream comment\nAPI_SERVER_KEY=keep-me-123",
    );
    assert.equal(existsSync(join(paths.home, "pairing/approved.json")), false);
    assert.equal(
        existsSync(join(paths.home, "platforms/pairing/telegram.json")),
        false,
    );
});

test("an .env disguised with control characters or NULs still loses its allowlists", async (t) => {
    const { paths, deps } = await setup(t);
    writeFiles(paths.home, {
        ".env": [
            "API_SERVER_KEY=keep-me-123",
            // Python's \s, which python-dotenv uses, includes \x1c-\x1f and \x85.
            "GATEWAY_ALLOW_ALL_USERS\x1f=true",
            "TELEGRAM_ALLOWED_USERS\x85=*",
            // Upstream strips NULs before parsing.
            "GATEWAY_ALLOWED_USERS\x00=*\r",
            "OTHER=1\r\n",
        ].join("\n"),
    });
    await bootstrap(deps);
    assert.equal(
        readFileSync(join(paths.home, ".env"), "utf8"),
        "API_SERVER_KEY=keep-me-123\nOTHER=1\n",
    );
});

test("a UTF-16 .env is cleaned as upstream decodes it; UTF-32 is set aside", async (t) => {
    const { paths, deps } = await setup(t);
    const env = join(paths.home, ".env");
    const text = "API_SERVER_KEY=keep-me-123\nGATEWAY_ALLOW_ALL_USERS=true\n";
    writeFileSync(
        env,
        Buffer.concat([
            Buffer.from([0xff, 0xfe]),
            Buffer.from(text, "utf16le"),
        ]),
    );
    await bootstrap(deps);
    assert.equal(readFileSync(env, "utf8"), "API_SERVER_KEY=keep-me-123\n");
    writeFileSync(env, Buffer.from([0xff, 0xfe, 0, 0, 0x47, 0, 0, 0]));
    await bootstrap(deps);
    assert.equal(existsSync(env), false);
    assert.equal(existsSync(`${env}.refused`), true);
});

test("a config repository without config.yaml is named", async (t) => {
    const { deps } = await setup(t, { "SOUL.md": "soul" });
    await assert.rejects(bootstrap(deps), /config\.yaml is missing/);
});

test("a config repository without config.yaml boots the last-good copy", async (t) => {
    const { configSha, paths, logs, deps } = await setup(t, {
        "SOUL.md": "soul",
    });
    writeFiles(join(paths.home, "dorothy/last-good"), {
        "SOUL.md": "old soul",
        "config.yaml": GOOD,
    });
    await bootstrap(deps);
    assert.equal(readFileSync(join(paths.home, "SOUL.md"), "utf8"), "old soul");
    assert.equal(readFileSync(join(paths.home, "config.yaml"), "utf8"), GOOD);
    assert.equal(
        readJson<ApplyStatus>(join(paths.home, "dorothy/status/apply.json"))
            ?.rolledBackSha,
        configSha,
    );
    assert.ok(logs.some((m) => m.includes("config.yaml is missing")));
});

test("a config.yaml without the skills directory warns", async (t) => {
    const { logs, deps } = await setup(t, {
        "SOUL.md": "soul",
        "config.yaml": "model: x\n",
    });
    await bootstrap(deps);
    assert.ok(logs.some((m) => m.includes("skills.external_dirs")));
});

test("a platform token without its allowlist stops the boot", async (t) => {
    const { deps } = await setup(t);
    deps.env = { ...deps.env, TELEGRAM_BOT_TOKEN: "1:abc" };
    await assert.rejects(bootstrap(deps), /TELEGRAM_ALLOWED_USERS is empty/);
});
