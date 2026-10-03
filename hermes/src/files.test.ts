// vim:set expandtab shiftwidth=4 filetype=typescript:
// SPDX-License-Identifier: GPL-3.0-only

//
//
// ~chewygumxx/dorothy-hermes.git
// ::: :/hermes/src/files.test.ts
//
//

import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import {
    chmodSync,
    existsSync,
    lstatSync,
    mkdirSync,
    readFileSync,
    statSync,
    symlinkSync,
} from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { encodeFile } from "./bundle.ts";
import {
    collectFile,
    collectTree,
    emptyDirectory,
    removeUnlisted,
    skillDirectory,
    writeTreeFile,
} from "./files.ts";
import { tempDir, writeFiles } from "./test-helpers.ts";

test("collectTree skips dotfiles, links and special files, sorted", (t) => {
    const root = tempDir(t);
    writeFiles(root, {
        "skills/b/run.sh": "#!/bin/sh\n",
        "skills/a/SKILL.md": "a",
        "skills/.hidden/x": "x",
        "skills/a/.cache": "x",
        "outside/secret": "s",
    });
    chmodSync(join(root, "skills/b/run.sh"), 0o755);
    symlinkSync(join(root, "outside/secret"), join(root, "skills/a/link"));
    symlinkSync(join(root, "outside"), join(root, "skills/linked-dir"));
    execFileSync("mkfifo", [join(root, "skills/a/fifo")]);
    const files = collectTree(root, "skills");
    assert.deepEqual(
        files.map((f) => [f.path, f.mode]),
        [
            ["skills/a/SKILL.md", 0o644],
            ["skills/b/run.sh", 0o755],
        ],
    );
});

test("collectTree honours skipDirectory and includeFile", (t) => {
    const root = tempDir(t);
    writeFiles(root, {
        "memories/MEMORY.md": "m",
        "memories/notes.txt": "n",
        "memories/sub/x.md": "x",
    });
    const files = collectTree(root, "memories", {
        skipDirectory: () => true,
        includeFile: (path) => path.endsWith(".md"),
    });
    assert.deepEqual(
        files.map((f) => f.path),
        ["memories/MEMORY.md"],
    );
});

test("a symlinked top directory is not followed", (t) => {
    const root = tempDir(t);
    writeFiles(root, { "real/MEMORY.md": "m" });
    symlinkSync(join(root, "real"), join(root, "memories"));
    assert.deepEqual(collectTree(root, "memories"), []);
    assert.equal(collectFile(root, "memories/MEMORY.md"), null);
});

test("writeTreeFile replaces a link where a directory belongs", (t) => {
    const root = tempDir(t);
    const outside = tempDir(t);
    symlinkSync(outside, join(root, "memories"));
    writeTreeFile(
        root,
        encodeFile("memories/MEMORY.md", Buffer.from("new"), 0o644),
    );
    assert.equal(lstatSync(join(root, "memories")).isDirectory(), true);
    assert.equal(readFileSync(join(root, "memories/MEMORY.md"), "utf8"), "new");
    assert.equal(existsSync(join(outside, "MEMORY.md")), false);
});

test("writeTreeFile applies the mode and replaces a final link", (t) => {
    const root = tempDir(t);
    const outside = join(tempDir(t), "target");
    writeFiles(root, { "skills/a/placeholder": "" });
    symlinkSync(outside, join(root, "skills/a/run.sh"));
    writeTreeFile(
        root,
        encodeFile("skills/a/run.sh", Buffer.from("#!/bin/sh\n"), 0o755),
    );
    assert.equal(statSync(join(root, "skills/a/run.sh")).mode & 0o777, 0o755);
    assert.equal(existsSync(outside), false);
});

test("removeUnlisted deletes the rest and empty directories", (t) => {
    const root = tempDir(t);
    writeFiles(root, {
        "skills/a/SKILL.md": "a",
        "skills/b/SKILL.md": "b",
        "skills/b/.keep": "",
    });
    mkdirSync(join(root, "skills/empty"));
    removeUnlisted(root, "skills", new Set(["skills/a/SKILL.md"]));
    assert.equal(existsSync(join(root, "skills/a/SKILL.md")), true);
    assert.equal(existsSync(join(root, "skills/b")), false);
    assert.equal(existsSync(join(root, "skills/empty")), false);
});

test("emptyDirectory keeps the directory", (t) => {
    const root = tempDir(t);
    writeFiles(root, { "pairing/a.json": "{}", "pairing/sub/b.json": "{}" });
    emptyDirectory(join(root, "pairing"));
    emptyDirectory(join(root, "missing"));
    assert.deepEqual(
        execFileSync("ls", ["-A", join(root, "pairing")], { encoding: "utf8" }),
        "",
    );
});

test("skillDirectory finds the directory a restore replaces", () => {
    assert.equal(skillDirectory("skills/cat/name/SKILL.md"), "skills/cat/name");
    assert.equal(skillDirectory("skills/name/SKILL.md"), "skills/name");
    assert.equal(
        skillDirectory("skills/cat/name/deep/file.md"),
        "skills/cat/name",
    );
    assert.equal(skillDirectory("skills/loose.md"), null);
    // A category's own file: replacing the category would delete its bundled skills.
    assert.equal(skillDirectory("skills/cat/DESCRIPTION.md"), null);
});
