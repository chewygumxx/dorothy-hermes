// vim:set expandtab shiftwidth=4 filetype=typescript:
// SPDX-License-Identifier: GPL-3.0-only

//
//
// ~chewygumxx/dorothy-hermes.git
// ::: :/smoke/restore-check.mts
//
//

// Restores a published state.sql and checks that each needle survived.
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { restoreDatabase } from "../hermes/src/dump.ts";

const [sqlPath, ...needles] = process.argv.slice(2);
if (!sqlPath)
    throw new Error("usage: restore-check.mts <state.sql> <needle>...");
const path = join(mkdtempSync(join(tmpdir(), "dorothy-smoke-")), "state.db");
restoreDatabase(readFileSync(sqlPath, "utf8"), path);
const db = new DatabaseSync(path, { readOnly: true });
for (const needle of needles) {
    const row = db
        .prepare("SELECT count(*) AS n FROM messages WHERE content LIKE ?")
        .get(`%${needle}%`) as {
        n: number;
    };
    if (row.n === 0) {
        console.error(`missing: ${needle}`);
        process.exit(1);
    }
}
console.log(`state.sql restores and holds: ${needles.join(", ")}`);
