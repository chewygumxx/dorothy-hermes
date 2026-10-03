// vim:set expandtab shiftwidth=4 filetype=typescript:
// SPDX-License-Identifier: GPL-3.0-only

//
//
// ~chewygumxx/dorothy-hermes.git
// ::: :/hermes/src/dump.test.ts
//
//

import assert from "node:assert/strict";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { type TestContext, test } from "node:test";
import {
    checkTables,
    DumpError,
    dumpDatabase,
    literal,
    restoreDatabase,
} from "./dump.ts";
import { tempDir } from "./test-helpers.ts";

function fixture(t: TestContext): string {
    const path = join(tempDir(t), "state.db");
    const db = new DatabaseSync(path);
    db.exec(`
        PRAGMA user_version = 7;
        CREATE TABLE messages (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            body TEXT, data BLOB, score REAL, big INTEGER
        );
        CREATE TABLE kv (k TEXT PRIMARY KEY, v TEXT) WITHOUT ROWID;
        CREATE TABLE audit (n INTEGER);
        CREATE INDEX messages_body ON messages(body);
        CREATE VIEW messages_fts_src AS SELECT id, body FROM messages;
        CREATE VIRTUAL TABLE messages_fts USING fts5(
            body, content='messages_fts_src', content_rowid='id'
        );
        CREATE TRIGGER messages_fts_insert AFTER INSERT ON messages BEGIN
            INSERT INTO messages_fts(rowid, body) VALUES (new.id, new.body);
        END;
        CREATE TRIGGER messages_audit AFTER INSERT ON messages BEGIN
            INSERT INTO audit(n) VALUES (new.id);
        END;
        CREATE VIEW recent AS SELECT id FROM messages ORDER BY id DESC;
        CREATE TABLE fts_v22_trash_1 (x);
        INSERT INTO messages(body, data, score, big)
            VALUES ('it''s plain', X'0001FEFF', 3.0, 1152921504606846977);
        INSERT INTO messages(body, data, score, big)
            VALUES ('東京は晴れです', NULL, 0.1, -4611686018427387904);
        INSERT INTO messages(body, data, score, big)
            VALUES ('nul' || char(0) || 'inside', X'', 1e300, 42);
        INSERT INTO messages(body) VALUES ('deleted');
        DELETE FROM messages WHERE body = 'deleted';
        INSERT INTO kv VALUES ('b', '2'), ('a', '1');
        ANALYZE;
    `);
    db.close();
    return path;
}

test("a dump restores to identical rows and dumps identically", (t) => {
    const original = fixture(t);
    const sql = dumpDatabase(original);
    assert.equal(
        dumpDatabase(original),
        sql,
        "dumping twice is byte-identical",
    );
    const restored = join(tempDir(t), "restored.db");
    restoreDatabase(sql, restored);
    assert.equal(dumpDatabase(restored), sql);

    const db = new DatabaseSync(restored, { readOnly: true });
    const big = db.prepare(
        "SELECT big, typeof(score) AS kind FROM messages WHERE id = 1",
    );
    big.setReadBigInts(true);
    assert.deepEqual(
        { ...big.get() },
        { big: 1152921504606846977n, kind: "real" },
    );
    assert.deepEqual(
        { ...db.prepare("PRAGMA user_version").get() },
        { user_version: 7 },
    );
    assert.deepEqual(
        {
            ...db
                .prepare(
                    "SELECT seq FROM sqlite_sequence WHERE name = 'messages'",
                )
                .get(),
        },
        { seq: 4 },
    );
    const nul = db.prepare("SELECT body FROM messages WHERE id = 3").get();
    assert.equal(nul?.body, "nul\u0000inside");
    db.close();
});

test("FTS objects, statistics and trash tables are omitted", (t) => {
    const sql = dumpDatabase(fixture(t));
    for (const absent of [
        "messages_fts",
        "sqlite_stat",
        "fts_v22_trash",
        "messages_fts_src",
    ]) {
        assert.equal(sql.includes(absent), false, `${absent} is omitted`);
    }
    for (const present of [
        "CREATE TRIGGER messages_audit",
        "CREATE VIEW recent",
        "CREATE INDEX messages_body",
    ]) {
        assert.ok(sql.includes(present), `${present} is kept`);
    }
});

test("indexes, views and triggers follow all data", (t) => {
    const sql = dumpDatabase(fixture(t));
    const lastInsert = sql.lastIndexOf("\nINSERT INTO ");
    assert.ok(sql.indexOf("CREATE INDEX") > lastInsert);
    assert.ok(sql.indexOf("CREATE TRIGGER") > lastInsert);
    assert.ok(
        sql.startsWith(
            "PRAGMA foreign_keys=OFF;\nBEGIN;\nPRAGMA user_version=7;\n",
        ),
    );
    assert.ok(sql.endsWith("COMMIT;\n"));
});

test("an unsupported virtual table fails loudly", (t) => {
    const path = join(tempDir(t), "rtree.db");
    const db = new DatabaseSync(path);
    db.exec("CREATE VIRTUAL TABLE boxes USING rtree(id, x0, x1)");
    db.close();
    assert.throws(() => dumpDatabase(path), DumpError);
});

test("text and blob values pass through the redaction hooks", (t) => {
    const sql = dumpDatabase(fixture(t), {
        mapText: (value) => value.replaceAll("plain", "[REDACTED:X]"),
        mapBlob: () => Buffer.from("ab"),
    });
    assert.ok(sql.includes("'it''s [REDACTED:X]'"));
    assert.ok(sql.includes("X'6162'"));
});

test("literals cover every storage class", () => {
    assert.equal(literal(null), "NULL");
    assert.equal(literal(3), "3.0");
    assert.equal(literal(0.1), "0.1");
    assert.equal(literal(1e300), "1e+300");
    assert.equal(literal(Number.POSITIVE_INFINITY), "9e999");
    assert.equal(literal(Number.NEGATIVE_INFINITY), "-9e999");
    assert.equal(literal(2n ** 63n - 1n), "9223372036854775807");
    assert.equal(literal("o'k"), "'o''k'");
    assert.equal(literal("a\u0000b"), "CAST(X'610062' AS TEXT)");
    assert.equal(literal(new Uint8Array([0, 255])), "X'00FF'");
});

test("checkTables passes a healthy database", (t) => {
    assert.doesNotThrow(() => checkTables(fixture(t)));
});
