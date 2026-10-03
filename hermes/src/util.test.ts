// vim:set expandtab shiftwidth=4 filetype=typescript:
// SPDX-License-Identifier: GPL-3.0-only

//
//
// ~chewygumxx/dorothy-hermes.git
// ::: :/hermes/src/util.test.ts
//
//

import assert from "node:assert/strict";
import { test } from "node:test";
import { iso, lstatOrNull, retry } from "./util.ts";

function clock() {
    let t = 0;
    return {
        now: () => t,
        sleep: async (ms: number) => {
            t += ms;
        },
    };
}

test("retry returns once the function succeeds", async () => {
    let calls = 0;
    const value = await retry(
        "thing",
        async () => {
            calls += 1;
            if (calls < 3) throw new Error("not yet");
            return "ok";
        },
        { ...clock(), forMs: 60_000, log: () => {} },
    );
    assert.equal(value, "ok");
    assert.equal(calls, 3);
});

test("retry gives up after its window and names the failure", async () => {
    await assert.rejects(
        retry(
            "clone",
            async () => {
                throw new Error("unreachable");
            },
            { ...clock(), forMs: 5_000, log: () => {} },
        ),
        /clone kept failing for 5 s: unreachable/,
    );
});

test("iso formats milliseconds", () => {
    assert.equal(iso(0), "1970-01-01T00:00:00.000Z");
});

test("lstatOrNull returns null for a missing path", () => {
    assert.equal(lstatOrNull("/nonexistent/dorothy"), null);
});
