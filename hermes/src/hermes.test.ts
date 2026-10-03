// vim:set expandtab shiftwidth=4 filetype=typescript:
// SPDX-License-Identifier: GPL-3.0-only

//
//
// ~chewygumxx/dorothy-hermes.git
// ::: :/hermes/src/hermes.test.ts
//
//

import assert from "node:assert/strict";
import { chmodSync, existsSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { createHermesCli, newSnapshot, parseSvstat } from "./hermes.ts";
import { tempDir } from "./test-helpers.ts";

test("s6-svstat output parses", () => {
    assert.deepEqual(parseSvstat("true 4321\n"), { up: true, pid: 4321 });
    assert.deepEqual(parseSvstat("false -1\n"), { up: false, pid: null });
});

test("the new snapshot is found, suffix or not", () => {
    const before = new Set(["20261003-000000-dorothy-sync"]);
    assert.equal(
        newSnapshot(
            before,
            [
                ...before,
                "20261003-000000-dorothy-sync-2",
                "20261003-000001-other",
            ],
            "dorothy-sync",
        ),
        "20261003-000000-dorothy-sync-2",
    );
    assert.equal(
        newSnapshot(
            new Set(),
            ["20261003-000002-dorothy-sync"],
            "dorothy-sync",
        ),
        "20261003-000002-dorothy-sync",
    );
    assert.throws(() => newSnapshot(before, before, "dorothy-sync"), /found 0/);
    assert.throws(
        () =>
            newSnapshot(
                new Set(),
                ["1-dorothy-sync", "2-dorothy-sync"],
                "dorothy-sync",
            ),
        /found 2/,
    );
});

test("the real CLI drives the binaries it is given", async (t) => {
    const home = tempDir(t);
    const bin = join(home, "fake-hermes");
    writeFileSync(
        bin,
        `#!/bin/sh\nif [ "$1" = backup ]; then mkdir -p "${home}/state-snapshots/20261003-000000-$4"; fi\n`,
    );
    const svstat = join(home, "fake-svstat");
    writeFileSync(svstat, "#!/bin/sh\necho 'true 77'\n");
    chmodSync(bin, 0o755);
    chmodSync(svstat, 0o755);
    mkdirSync(join(home, "state-snapshots"));
    const cli = createHermesCli({
        home,
        bin,
        svstat,
        slot: "/run/service/gateway-default",
    });
    const dir = await cli.snapshot("dorothy-sync");
    assert.equal(
        dir,
        join(home, "state-snapshots/20261003-000000-dorothy-sync"),
    );
    assert.deepEqual(await cli.gatewayStatus(), { up: true, pid: 77 });
    await cli.deleteSnapshot(dir);
    assert.equal(existsSync(dir), false);
    await assert.rejects(cli.deleteSnapshot(home), /not a snapshot/);
});
