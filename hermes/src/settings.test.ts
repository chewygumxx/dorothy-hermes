// vim:set expandtab shiftwidth=4 filetype=typescript:
// SPDX-License-Identifier: GPL-3.0-only

//
//
// ~chewygumxx/dorothy-hermes.git
// ::: :/hermes/src/settings.test.ts
//
//

import assert from "node:assert/strict";
import { test } from "node:test";
import {
    allowlistNames,
    hermesSettings,
    loadRegistry,
    type PlatformRegistry,
    repoName,
    SettingsError,
    sidecarSettings,
} from "./settings.ts";

const KEY = Buffer.from(
    "-----BEGIN OPENSSH PRIVATE KEY-----\nAAAA\n-----END OPENSSH PRIVATE KEY-----\n",
).toString("base64");

const registry: PlatformRegistry = {
    platforms: {
        telegram: {
            enabledBy: ["TELEGRAM_BOT_TOKEN"],
            allowedUsers: "TELEGRAM_ALLOWED_USERS",
            allowAllUsers: "TELEGRAM_ALLOW_ALL_USERS",
        },
        relay: {
            enabledBy: ["GATEWAY_RELAY_URL"],
            allowedUsers: "",
            allowAllUsers: "",
        },
    },
    globalAllowlist: "GATEWAY_ALLOWED_USERS",
    globalAllowAll: "GATEWAY_ALLOW_ALL_USERS",
    extraAllowVariables: [
        "PLUGIN_ALLOW_ALL_USERS",
        "TELEGRAM_ALLOW_BOTS",
        "TELEGRAM_GROUP_ALLOWED_USERS",
    ],
};

const base = {
    DOROTHY_CONFIG_REPO: "git@github.com:me/dorothy-config.git",
    DOROTHY_CONFIG_DEPLOY_KEY: KEY,
};

test("a minimal hermes environment is accepted with defaults", () => {
    const settings = hermesSettings(base, registry);
    assert.equal(settings.configRepoName, "me/dorothy-config");
    assert.equal(settings.interval, 900);
    assert.match(settings.configKey, /^-----BEGIN OPENSSH PRIVATE KEY-----\n/);
});

test("missing or malformed variables are named", () => {
    assert.throws(
        () => hermesSettings({}, registry),
        /DOROTHY_CONFIG_REPO is required/,
    );
    assert.throws(
        () =>
            hermesSettings(
                { ...base, DOROTHY_CONFIG_DEPLOY_KEY: "bm90IGEga2V5" },
                registry,
            ),
        /DOROTHY_CONFIG_DEPLOY_KEY must be a base64-encoded private key/,
    );
    assert.throws(
        () =>
            hermesSettings(
                { ...base, DOROTHY_SYNC_INTERVAL: "fast" },
                registry,
            ),
        /DOROTHY_SYNC_INTERVAL must be a whole number of at least 60/,
    );
});

test("a non-GitHub repository needs an explicit name", () => {
    const env = { ...base, DOROTHY_CONFIG_REPO: "file:///fixtures/config.git" };
    assert.throws(
        () => hermesSettings(env, registry),
        /DOROTHY_CONFIG_REPO_NAME is required/,
    );
    const named = hermesSettings(
        { ...env, DOROTHY_CONFIG_REPO_NAME: "smoke/config" },
        registry,
    );
    assert.equal(named.configRepoName, "smoke/config");
});

test("repository names derive from GitHub URLs", () => {
    assert.equal(
        repoName("https://github.com/me/dorothy-config"),
        "me/dorothy-config",
    );
    assert.equal(
        repoName("git@github.com:me/dorothy.config.git"),
        "me/dorothy.config",
    );
    assert.equal(repoName("file:///tmp/x.git"), null);
});

test("a platform token without its allowlist is refused", () => {
    assert.throws(
        () =>
            hermesSettings({ ...base, TELEGRAM_BOT_TOKEN: "1:abc" }, registry),
        (error) =>
            error instanceof SettingsError &&
            /TELEGRAM_BOT_TOKEN enables telegram, but TELEGRAM_ALLOWED_USERS is empty/.test(
                error.message,
            ),
    );
    assert.doesNotThrow(() =>
        hermesSettings(
            {
                ...base,
                TELEGRAM_BOT_TOKEN: "1:abc",
                TELEGRAM_ALLOWED_USERS: "42",
            },
            registry,
        ),
    );
});

test("allow-all and allow-bots overrides are refused", () => {
    for (const name of [
        "GATEWAY_ALLOW_ALL_USERS",
        "TELEGRAM_ALLOW_ALL_USERS",
        "PLUGIN_ALLOW_ALL_USERS",
        "TELEGRAM_ALLOW_BOTS",
    ]) {
        assert.throws(
            () => hermesSettings({ ...base, [name]: "true" }, registry),
            new RegExp(name),
        );
    }
    assert.doesNotThrow(() =>
        hermesSettings({ ...base, GATEWAY_ALLOW_ALL_USERS: "false" }, registry),
    );
});

test("a wildcard entry in any allowlist is refused", () => {
    for (const [name, value] of [
        ["TELEGRAM_ALLOWED_USERS", "42,*"],
        ["GATEWAY_ALLOWED_USERS", " * "],
        ["TELEGRAM_GROUP_ALLOWED_USERS", '["*"]'],
    ] as const) {
        assert.throws(
            () => hermesSettings({ ...base, [name]: value }, registry),
            new RegExp(`${name} contains "\\*"`),
        );
    }
    assert.doesNotThrow(() =>
        hermesSettings({ ...base, TELEGRAM_ALLOWED_USERS: "42,43" }, registry),
    );
});

test("allowlistNames lists every allowlist and override once", () => {
    assert.deepEqual(allowlistNames(registry), [
        "GATEWAY_ALLOWED_USERS",
        "GATEWAY_ALLOW_ALL_USERS",
        "PLUGIN_ALLOW_ALL_USERS",
        "TELEGRAM_ALLOWED_USERS",
        "TELEGRAM_ALLOW_ALL_USERS",
        "TELEGRAM_ALLOW_BOTS",
        "TELEGRAM_GROUP_ALLOWED_USERS",
    ]);
});

test("the generated registry has the shape settings expect", () => {
    const real = loadRegistry();
    assert.equal(
        real.platforms.telegram?.allowedUsers,
        "TELEGRAM_ALLOWED_USERS",
    );
    assert.ok(real.extraAllowVariables.length > 0);
});

test("plugin platforms' allowlists are refused and cleaned too", () => {
    const real = loadRegistry();
    for (const name of [
        "IRC_ALLOW_ALL_USERS",
        "LINE_ALLOW_ALL_USERS",
        "TEAMS_ALLOW_ALL_USERS",
    ]) {
        assert.throws(
            () => hermesSettings({ ...base, [name]: "true" }, real),
            new RegExp(name),
        );
    }
    assert.throws(
        () => hermesSettings({ ...base, SIMPLEX_ALLOWED_USERS: "*" }, real),
        /SIMPLEX_ALLOWED_USERS contains/,
    );
    const names = allowlistNames(real);
    for (const name of ["NTFY_ALLOWED_USERS", "A2A_ALLOW_ALL_USERS"])
        assert.ok(names.includes(name), `${name} is not cleaned from .env`);
});

test("sidecar settings validate and default", () => {
    const settings = sidecarSettings({
        DOROTHY_MEMORY_REPO: "git@github.com:me/dorothy-memory.git",
        DOROTHY_MEMORY_DEPLOY_KEY: KEY,
        DOROTHY_HOST: "server-1",
    });
    assert.equal(settings.bundleMaxBytes, 256 * 1024 * 1024);
    assert.equal(settings.allowEmpty, false);
    assert.equal(settings.host, "server-1");
    assert.throws(() => sidecarSettings({}), /DOROTHY_MEMORY_REPO is required/);
});
