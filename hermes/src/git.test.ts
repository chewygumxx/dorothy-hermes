// vim:set expandtab shiftwidth=4 filetype=typescript:
// SPDX-License-Identifier: GPL-3.0-only

//
//
// ~chewygumxx/dorothy-hermes.git
// ::: :/hermes/src/git.test.ts
//
//

import assert from "node:assert/strict";
import { renameSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { Git, sshCommand } from "./git.ts";
import {
    bareRepo,
    GIT_ENV,
    git,
    pushFiles,
    remoteMain,
    tempDir,
    writeFiles,
} from "./test-helpers.ts";

async function cloned(
    t: Parameters<typeof tempDir>[0],
    url: string,
): Promise<Git> {
    const repo = new Git(join(tempDir(t), "checkout"), { env: GIT_ENV });
    await repo.clone(url);
    return repo;
}

test("an empty remote clones onto an unborn main", async (t) => {
    const repo = await cloned(t, bareRepo(t));
    assert.equal(await repo.head(), null);
    assert.equal(await repo.remoteHead(), null);
    assert.equal(await repo.unpushed(), 0);
    assert.equal(
        git(["symbolic-ref", "HEAD"], repo.dir).trim(),
        "refs/heads/main",
    );
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
    assert.equal(
        git(["log", "-1", "--format=%an <%ae>"], repo.dir).trim(),
        "Dorothy <noreply@dorothy.invalid>",
    );
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
    renameSync(
        url.slice("file://".length),
        `${url.slice("file://".length)}.gone`,
    );
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
