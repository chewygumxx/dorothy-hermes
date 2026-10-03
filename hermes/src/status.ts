// vim:set expandtab shiftwidth=4 filetype=typescript:
// SPDX-License-Identifier: GPL-3.0-only

//
//
// ~chewygumxx/dorothy-hermes.git
// ::: :/hermes/src/status.ts
//
//

import { randomBytes } from "node:crypto";
import {
    closeSync,
    fsyncSync,
    mkdirSync,
    openSync,
    readFileSync,
    renameSync,
    rmSync,
    writeFileSync,
} from "node:fs";
import { dirname } from "node:path";
import { errorCode } from "./util.ts";

function fsyncPath(path: string, flags: string): void {
    const fd = openSync(path, flags);
    try {
        fsyncSync(fd);
    } finally {
        closeSync(fd);
    }
}

/**
 * Writes through a temporary file in the same directory, then renames. Both
 * the file and the directory are synced, so a host crash leaves the old
 * content or the new, never an empty file.
 */
export function writeFileAtomic(
    path: string,
    data: string | Uint8Array,
    mode = 0o644,
): void {
    mkdirSync(dirname(path), { recursive: true });
    const temp = `${path}.${process.pid}.${randomBytes(4).toString("hex")}.tmp`;
    try {
        const fd = openSync(temp, "wx", mode);
        try {
            writeFileSync(fd, data);
            fsyncSync(fd);
        } finally {
            closeSync(fd);
        }
        renameSync(temp, path);
    } catch (error) {
        rmSync(temp, { force: true });
        throw error;
    }
    fsyncPath(dirname(path), "r");
}

export function writeJson(path: string, value: unknown, mode = 0o644): void {
    writeFileAtomic(path, `${JSON.stringify(value, null, 2)}\n`, mode);
}

export function readJson<T>(path: string): T | null {
    const text = readText(path);
    return text === "" ? null : (JSON.parse(text) as T);
}

export function readText(path: string): string {
    try {
        return readFileSync(path, "utf8");
    } catch (error) {
        if (errorCode(error) === "ENOENT") return "";
        throw error;
    }
}

/** `/opt/data/dorothy/status/apply.json` */
export interface ApplyStatus {
    appliedSha?: string;
    rolledBackSha?: string;
    configRolledBack?: boolean;
    lastApplyAt?: string;
    lastError?: string;
}

/** `/opt/data/dorothy/status/snapshot.json` */
export interface SnapshotStatus {
    lastSuccessAt?: string;
    lastAttemptAt?: string;
    lastError?: string;
}

/** `/var/lib/dorothy/restore/status.json`, written by the sidecar. */
export interface SyncStatus {
    startedAt: string;
    restoreWrittenAt?: string;
    loopAt?: string;
    lastSuccessAt?: string;
    lastError?: string;
    lastBundleAt?: string;
    pendingCommits: number;
    pushRejected: boolean;
    largestFileBytes: number;
    sizeWarning: boolean;
}
