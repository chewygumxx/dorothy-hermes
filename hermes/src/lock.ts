// vim:set expandtab shiftwidth=4 filetype=typescript:
// SPDX-License-Identifier: GPL-3.0-only

//
//
// ~chewygumxx/dorothy-hermes.git
// ::: :/hermes/src/lock.ts
//
//

import {
    mkdirSync,
    mkdtempSync,
    readFileSync,
    renameSync,
    rmSync,
    statSync,
    writeFileSync,
} from "node:fs";
import { basename, dirname, join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { errorCode } from "./util.ts";

export class LockTimeout extends Error {}

export interface LockOptions {
    /** Give up after this long; default ten minutes. */
    waitMs?: number;
    pollMs?: number;
    pid?: number;
    isAlive?(pid: number): boolean;
}

export function pidAlive(pid: number): boolean {
    try {
        process.kill(pid, 0);
        return true;
    } catch (error) {
        return (error as NodeJS.ErrnoException).code === "EPERM";
    }
}

function owner(path: string): number | null {
    try {
        const pid = Number.parseInt(
            readFileSync(join(path, "pid"), "utf8"),
            10,
        );
        return Number.isInteger(pid) && pid > 0 ? pid : null;
    } catch {
        return null;
    }
}

/** A takeover guard is held for a few system calls; older means its holder died. */
const GUARD_STALE_MS = 60_000;

/**
 * The lock directory is built aside with its pid file, then renamed into
 * place, so a lock never exists without its owner recorded.
 */
function place(path: string, pid: number): boolean {
    const temp = mkdtempSync(join(dirname(path), `.${basename(path)}-`));
    writeFileSync(join(temp, "pid"), String(pid));
    try {
        renameSync(temp, path);
        return true;
    } catch (error) {
        rmSync(temp, { recursive: true, force: true });
        const code = errorCode(error);
        if (code !== "ENOTEMPTY" && code !== "EEXIST") throw error;
        return false;
    }
}

/**
 * Removes a dead owner's lock. Takeovers are serialised through a guard
 * directory, and the owner is read again under it, so a waiter never removes
 * a lock another waiter has meanwhile taken. Returns whether it held the guard.
 */
function takeOver(path: string, dead: number | null): boolean {
    const guard = `${path}.takeover`;
    try {
        mkdirSync(guard);
    } catch (error) {
        if (errorCode(error) !== "EEXIST") throw error;
        try {
            if (Date.now() - statSync(guard).mtimeMs > GUARD_STALE_MS) {
                rmSync(guard, { recursive: true, force: true });
            }
        } catch {}
        return false;
    }
    try {
        if (owner(path) === dead)
            rmSync(path, { recursive: true, force: true });
    } finally {
        rmSync(guard, { recursive: true, force: true });
    }
    return true;
}

/** One attempt. */
function tryAcquire(path: string, options: LockOptions): boolean {
    const pid = options.pid ?? process.pid;
    const isAlive = options.isAlive ?? pidAlive;
    if (place(path, pid)) return true;
    const held = owner(path);
    if (held !== null && isAlive(held)) return false;
    return takeOver(path, held) && place(path, pid);
}

function release(path: string, pid: number): void {
    if (owner(path) === pid) rmSync(path, { recursive: true, force: true });
}

export async function withLock<T>(
    path: string,
    fn: () => Promise<T>,
    options: LockOptions = {},
): Promise<T> {
    const deadline = Date.now() + (options.waitMs ?? 600_000);
    while (!tryAcquire(path, options)) {
        if (Date.now() >= deadline) {
            throw new LockTimeout(`timed out waiting for ${basename(path)}`);
        }
        await delay(options.pollMs ?? 500);
    }
    try {
        return await fn();
    } finally {
        release(path, options.pid ?? process.pid);
    }
}

export async function tryWithLock<T>(
    path: string,
    fn: () => Promise<T>,
    options: LockOptions = {},
): Promise<{ ran: true; value: T } | { ran: false }> {
    if (!tryAcquire(path, options)) return { ran: false };
    try {
        return { ran: true, value: await fn() };
    } finally {
        release(path, options.pid ?? process.pid);
    }
}
