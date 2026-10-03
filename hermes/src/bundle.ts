// vim:set expandtab shiftwidth=4 filetype=typescript:
// SPDX-License-Identifier: GPL-3.0-only

//
//
// ~chewygumxx/dorothy-hermes.git
// ::: :/hermes/src/bundle.ts
//
//

import { isUtf8 } from "node:buffer";
import { createHash } from "node:crypto";
import {
    closeSync,
    constants,
    fstatSync,
    openSync,
    readFileSync,
    readSync,
} from "node:fs";
import { writeFileAtomic } from "./status.ts";
import { errorCode } from "./util.ts";

export type FileMode = 0o644 | 0o755;

export interface BundleFile {
    path: string;
    mode: FileMode;
    encoding: "utf8" | "base64";
    content: string;
}

export interface Bundle {
    version: 1;
    createdAt: string;
    generation: string;
    memorySha?: string;
    bundleHash?: string;
    seed: boolean;
    files: BundleFile[];
}

export class BundleError extends Error {}

const GENERATION = /^[0-9a-f]{32}$/;
const SHA = /^[0-9a-f]{40}(?:[0-9a-f]{24})?$/;
const HASH = /^[0-9a-f]{64}$/;
const BUNDLE_KEYS = new Set([
    "version",
    "createdAt",
    "generation",
    "memorySha",
    "bundleHash",
    "seed",
    "files",
]);
const FILE_KEYS = new Set(["path", "mode", "encoding", "content"]);

function fail(message: string): never {
    throw new BundleError(message);
}

export function validPath(path: string): boolean {
    if (path === "sessions/state.sql" || path === "cron/jobs.json") return true;
    if (path.includes("\\") || path.includes("\0")) return false;
    const parts = path.split("/");
    if (parts.length < 2 || (parts[0] !== "memories" && parts[0] !== "skills"))
        return false;
    return parts.every((part) => part !== "" && !part.startsWith("."));
}

export function encodeFile(
    path: string,
    bytes: Uint8Array,
    mode: FileMode,
): BundleFile {
    const buffer = Buffer.from(bytes);
    return isUtf8(buffer)
        ? { path, mode, encoding: "utf8", content: buffer.toString("utf8") }
        : {
              path,
              mode,
              encoding: "base64",
              content: buffer.toString("base64"),
          };
}

export function fileBytes(file: BundleFile): Buffer {
    return Buffer.from(file.content, file.encoding);
}

export function sha256(bytes: Uint8Array): string {
    return createHash("sha256").update(bytes).digest("hex");
}

export function validateBundle(value: unknown): Bundle {
    if (typeof value !== "object" || value === null || Array.isArray(value))
        fail("bundle is not an object");
    const bundle = value as Record<string, unknown>;
    for (const key of Object.keys(bundle))
        if (!BUNDLE_KEYS.has(key)) fail(`unknown bundle field ${key}`);
    if (bundle.version !== 1) fail("unsupported bundle version");
    if (
        typeof bundle.createdAt !== "string" ||
        Number.isNaN(Date.parse(bundle.createdAt))
    )
        fail("bad createdAt");
    if (
        typeof bundle.generation !== "string" ||
        !GENERATION.test(bundle.generation)
    )
        fail("bad generation");
    if (
        bundle.memorySha !== undefined &&
        (typeof bundle.memorySha !== "string" || !SHA.test(bundle.memorySha))
    ) {
        fail("bad memorySha");
    }
    if (
        bundle.bundleHash !== undefined &&
        (typeof bundle.bundleHash !== "string" || !HASH.test(bundle.bundleHash))
    ) {
        fail("bad bundleHash");
    }
    if (typeof bundle.seed !== "boolean") fail("bad seed");
    if (!Array.isArray(bundle.files)) fail("files is not an array");
    if (bundle.seed && bundle.files.length > 0)
        fail("a seed bundle carries no files");
    const paths = new Set<string>();
    for (const entry of bundle.files) {
        if (typeof entry !== "object" || entry === null)
            fail("file entry is not an object");
        const file = entry as Record<string, unknown>;
        for (const key of Object.keys(file))
            if (!FILE_KEYS.has(key)) fail(`unknown file field ${key}`);
        if (typeof file.path !== "string" || !validPath(file.path))
            fail(`path not allowed: ${String(file.path)}`);
        if (file.mode !== 0o644 && file.mode !== 0o755)
            fail(`bad mode for ${file.path}`);
        if (file.encoding !== "utf8" && file.encoding !== "base64")
            fail(`bad encoding for ${file.path}`);
        if (typeof file.content !== "string")
            fail(`bad content for ${file.path}`);
        if (
            file.encoding === "base64" &&
            Buffer.from(file.content, "base64").toString("base64") !==
                file.content
        ) {
            fail(`bad base64 for ${file.path}`);
        }
        if (paths.has(file.path)) fail(`duplicate path ${file.path}`);
        paths.add(file.path);
    }
    for (const path of paths) {
        const parts = path.split("/");
        for (let i = 1; i < parts.length; i++) {
            const parent = parts.slice(0, i).join("/");
            if (paths.has(parent))
                fail(`${path} lies under the file ${parent}`);
        }
    }
    return bundle as unknown as Bundle;
}

export function writeBundle(path: string, bundle: Bundle): string {
    const bytes = Buffer.from(JSON.stringify(bundle));
    writeFileAtomic(path, bytes, 0o644);
    return sha256(bytes);
}

/** Reads at most size bytes: the writer may append after fstat. */
export function readExactly(fd: number, size: number): Buffer {
    const buffer = Buffer.alloc(size);
    let offset = 0;
    while (offset < size) {
        const read = readSync(fd, buffer, offset, size - offset, offset);
        if (read === 0) break;
        offset += read;
    }
    return buffer.subarray(0, offset);
}

export interface OpenedBundle {
    bundle: Bundle;
    hash: string;
}

/** Opens agent-written bundle.json without trusting it (S2). */
export function openBundle(
    path: string,
    maxBytes: number,
): OpenedBundle | null {
    let fd: number;
    try {
        fd = openSync(
            path,
            constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK,
        );
    } catch (error) {
        if (errorCode(error) === "ENOENT") return null;
        if (errorCode(error) === "ELOOP") fail(`${path} is a symbolic link`);
        throw error;
    }
    try {
        const stat = fstatSync(fd);
        if (!stat.isFile()) fail(`${path} is not a regular file`);
        if (stat.size > maxBytes)
            fail(
                `${path} is ${stat.size} bytes, over the ${maxBytes}-byte limit`,
            );
        const bytes = readExactly(fd, stat.size);
        let parsed: unknown;
        try {
            parsed = JSON.parse(bytes.toString("utf8"));
        } catch {
            fail(`${path} is not valid JSON`);
        }
        return { bundle: validateBundle(parsed), hash: sha256(bytes) };
    } finally {
        closeSync(fd);
    }
}

/** Reads restore.json, which the trusted sidecar wrote. */
export function readTrustedBundle(path: string): Bundle {
    return validateBundle(JSON.parse(readFileSync(path, "utf8")));
}
