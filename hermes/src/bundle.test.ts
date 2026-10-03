// vim:set expandtab shiftwidth=4 filetype=typescript:
// SPDX-License-Identifier: GPL-3.0-only

//
//
// ~chewygumxx/dorothy-hermes.git
// ::: :/hermes/src/bundle.test.ts
//
//

import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { closeSync, openSync, symlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import {
    type Bundle,
    BundleError,
    encodeFile,
    openBundle,
    readExactly,
    validateBundle,
    validPath,
    writeBundle,
} from "./bundle.ts";
import { tempDir } from "./test-helpers.ts";

const GENERATION = "0123456789abcdef0123456789abcdef";

function bundle(files: Bundle["files"] = []): Bundle {
    return {
        version: 1,
        createdAt: "2026-10-03T00:00:00.000Z",
        generation: GENERATION,
        seed: false,
        files,
    };
}

test("allowed paths", () => {
    for (const ok of [
        "sessions/state.sql",
        "cron/jobs.json",
        "memories/MEMORY.md",
        "skills/a/b/SKILL.md",
    ]) {
        assert.equal(validPath(ok), true, ok);
    }
    for (const bad of [
        "",
        "/etc/passwd",
        "memories",
        "memories/",
        "memories/../x",
        "memories/./x",
        "skills/.git/config",
        ".git/config",
        "sessions/other.sql",
        "cron/other.json",
        "memories//x",
        "memories/a\\b",
        "notes/x.md",
    ]) {
        assert.equal(validPath(bad), false, bad);
    }
});

test("a written bundle opens with the same hash", (t) => {
    const path = join(tempDir(t), "bundle.json");
    const hash = writeBundle(
        path,
        bundle([encodeFile("memories/MEMORY.md", Buffer.from("hi"), 0o644)]),
    );
    const opened = openBundle(path, 1 << 20);
    assert.equal(opened?.hash, hash);
    assert.equal(opened?.bundle.files[0]?.content, "hi");
});

test("binary content is base64", () => {
    const file = encodeFile(
        "skills/a/b/icon.png",
        Buffer.from([0xff, 0xfe]),
        0o644,
    );
    assert.equal(file.encoding, "base64");
});

test("a missing bundle is null", (t) => {
    assert.equal(openBundle(join(tempDir(t), "none.json"), 1 << 20), null);
});

test("a symlinked bundle is refused", (t) => {
    const dir = tempDir(t);
    writeFileSync(join(dir, "secret"), "{}");
    symlinkSync(join(dir, "secret"), join(dir, "bundle.json"));
    assert.throws(
        () => openBundle(join(dir, "bundle.json"), 1 << 20),
        /symbolic link/,
    );
});

test("a FIFO bundle is refused without blocking", (t) => {
    const path = join(tempDir(t), "bundle.json");
    execFileSync("mkfifo", [path]);
    assert.throws(() => openBundle(path, 1 << 20), /not a regular file/);
});

test("an oversized bundle is refused", (t) => {
    const path = join(tempDir(t), "bundle.json");
    writeBundle(path, bundle());
    assert.throws(() => openBundle(path, 10), /over the 10-byte limit/);
});

test("reads stop at the size fstat reported", (t) => {
    const path = join(tempDir(t), "grown");
    writeFileSync(path, "0123456789");
    const fd = openSync(path, "r");
    try {
        assert.equal(readExactly(fd, 4).toString(), "0123");
    } finally {
        closeSync(fd);
    }
});

test("structural violations fail the whole bundle", () => {
    const file = encodeFile("memories/MEMORY.md", Buffer.from("x"), 0o644);
    const cases: [string, unknown][] = [
        ["unknown field", { ...bundle(), extra: 1 }],
        ["bad generation", { ...bundle(), generation: "nope" }],
        ["bad mode", bundle([{ ...file, mode: 0o777 as never }])],
        ["bad encoding", bundle([{ ...file, encoding: "hex" as never }])],
        [
            "bad base64",
            bundle([{ ...file, encoding: "base64", content: "@@" }]),
        ],
        ["traversal", bundle([{ ...file, path: "memories/../../x" }])],
        ["git path", bundle([{ ...file, path: ".git/config" }])],
        ["duplicate", bundle([file, file])],
        [
            "file under a file",
            bundle([file, { ...file, path: "memories/MEMORY.md/x" }]),
        ],
        ["seed with files", { ...bundle([file]), seed: true }],
    ];
    for (const [name, value] of cases) {
        assert.throws(() => validateBundle(value), BundleError, name);
    }
});
