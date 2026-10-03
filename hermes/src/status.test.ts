import assert from "node:assert/strict";
import { readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { readJson, readText, writeJson } from "./status.ts";
import { tempDir } from "./test-helpers.ts";

test("writeJson round-trips through readJson and leaves no temp file", (t) => {
    const dir = tempDir(t);
    const path = join(dir, "nested", "apply.json");
    writeJson(path, { appliedSha: "abc" });
    assert.deepEqual(readJson(path), { appliedSha: "abc" });
    assert.deepEqual(readdirSync(join(dir, "nested")), ["apply.json"]);
});

test("writeJson applies the mode", (t) => {
    const path = join(tempDir(t), "key.json");
    writeJson(path, {}, 0o600);
    assert.equal(statSync(path).mode & 0o777, 0o600);
});

test("missing files read as null and empty text", (t) => {
    const dir = tempDir(t);
    assert.equal(readJson(join(dir, "none.json")), null);
    assert.equal(readText(join(dir, "none")), "");
});
