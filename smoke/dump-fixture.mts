// vim:set expandtab shiftwidth=4 filetype=typescript:
// SPDX-License-Identifier: GPL-3.0-only

//
//
// ~chewygumxx/dorothy-hermes.git
// ::: :/smoke/dump-fixture.mts
//
//

// Runs inside an older image: dumps the newest *-fixture snapshot's state.db.
import { readdirSync } from "node:fs";
import { join } from "node:path";
import { checkTables, dumpDatabase } from "/opt/dorothy/src/dump.ts";

const home = process.argv[2] ?? "/opt/data";
const snapshots = join(home, "state-snapshots");
const latest = readdirSync(snapshots)
    .filter((name) => name.endsWith("-fixture"))
    .sort()
    .at(-1);
if (!latest) throw new Error(`no fixture snapshot in ${snapshots}`);
const db = join(snapshots, latest, "state.db");
checkTables(db);
process.stdout.write(dumpDatabase(db));
