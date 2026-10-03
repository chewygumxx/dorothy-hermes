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
