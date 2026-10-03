// vim:set expandtab shiftwidth=4 filetype=typescript:
// SPDX-License-Identifier: GPL-3.0-only

//
//
// ~chewygumxx/dorothy-hermes.git
// ::: :/hermes/src/redact.test.ts
//
//

import assert from "node:assert/strict";
import { test } from "node:test";
import {
    collectSecrets,
    dotenvSpans,
    parseDotenv,
    Redactor,
} from "./redact.ts";

test("named secrets are redacted as written", () => {
    const redactor = new Redactor(
        collectSecrets([
            ["TELEGRAM_BOT_TOKEN", "123456:telegram-secret"],
            ["HOME", "/opt/data/not-a-secret"],
        ]),
    );
    assert.equal(
        redactor.text("token 123456:telegram-secret in /opt/data/not-a-secret"),
        "token [REDACTED:TELEGRAM_BOT_TOKEN] in /opt/data/not-a-secret",
    );
});

test("values shorter than eight characters are skipped", () => {
    const redactor = new Redactor(collectSecrets([["SHORT_KEY", "abc1234"]]));
    assert.equal(redactor.text("abc1234"), "abc1234");
});

test("deploy keys are redacted per decoded line", () => {
    const pem =
        "-----BEGIN OPENSSH PRIVATE KEY-----\n" +
        "b3BlbnNzaC1rZXktdjEAAAAABG5vbmUAAAAEbm9uZQAAAAAAAAABAAAAMwAAAAtzc2gtZW\n" +
        "-----END OPENSSH PRIVATE KEY-----\n";
    const encoded = Buffer.from(pem).toString("base64");
    const redactor = new Redactor(
        collectSecrets([["DOROTHY_CONFIG_DEPLOY_KEY", encoded]]),
    );
    const leaked =
        "cat key: b3BlbnNzaC1rZXktdjEAAAAABG5vbmUAAAAEbm9uZQAAAAAAAAABAAAAMwAAAAtzc2gtZW";
    assert.equal(
        redactor.text(leaked),
        "cat key: [REDACTED:DOROTHY_CONFIG_DEPLOY_KEY]",
    );
    assert.equal(
        redactor.text(encoded),
        "[REDACTED:DOROTHY_CONFIG_DEPLOY_KEY]",
    );
    assert.equal(
        redactor.text("-----BEGIN OPENSSH PRIVATE KEY-----"),
        "-----BEGIN OPENSSH PRIVATE KEY-----",
    );
});

test("bytes are redacted too", () => {
    const redactor = new Redactor(
        collectSecrets([["API_SERVER_KEY", "generated-api-key-1"]]),
    );
    const out = redactor.bytes(Buffer.from("\u0000generated-api-key-1\u0001"));
    assert.equal(
        Buffer.from(out).toString(),
        "\u0000[REDACTED:API_SERVER_KEY]\u0001",
    );
});

test("longer secrets are replaced before the secrets they contain", () => {
    const redactor = new Redactor(
        collectSecrets([
            ["A_TOKEN", "abcdefgh"],
            ["B_TOKEN", "abcdefgh-ijklmnop"],
        ]),
    );
    assert.equal(redactor.text("abcdefgh-ijklmnop"), "[REDACTED:B_TOKEN]");
});

test("dotenv text is read as python-dotenv reads it", () => {
    const text = [
        "# comment",
        "API_SERVER_KEY=plain-value-1 # trailing comment",
        'export QUOTED_TOKEN="say \\"hi\\" \\\\ 2"',
        "SINGLE_SECRET='single value 3'",
        "'QUOTED_KEY'=value-4",
        'MULTI_TOKEN="line one',
        'line two"',
        "",
        "not a line",
        'BROKEN_TOKEN="unterminated',
    ].join("\n");
    assert.deepEqual(
        [...parseDotenv(text)],
        [
            ["API_SERVER_KEY", "plain-value-1"],
            ["QUOTED_TOKEN", 'say "hi" \\ 2'],
            ["SINGLE_SECRET", "single value 3"],
            ["QUOTED_KEY", "value-4"],
            ["MULTI_TOKEN", "line one\nline two"],
        ],
    );
    const spans = dotenvSpans(text);
    assert.equal(spans.map((span) => span.text).join(""), text);
    assert.deepEqual(
        spans.filter((span) => span.invalid).map((span) => span.text.trim()),
        ["not a line", 'BROKEN_TOKEN="unterminated'],
    );
});
