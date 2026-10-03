// vim:set expandtab shiftwidth=4 filetype=typescript:
// SPDX-License-Identifier: GPL-3.0-only

//
//
// ~chewygumxx/dorothy-hermes.git
// ::: :/scripts/platforms.test.ts
//
//

import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { type TestContext, test } from "node:test";
import {
    formatRegistry,
    type Judgments,
    readRegistry,
    registryDrift,
} from "./platforms.ts";

/** A small upstream tree in the shapes the pinned image uses. */
const UPSTREAM: Record<string, string> = {
    "gateway/config.py": `
class Platform(Enum):
    """Supported messaging platforms. Plugin platforms are dynamic members
    created on demand by \`\`_missing_\`\`."""
    LOCAL = "local"
    TELEGRAM = "telegram"
    DISCORD = "discord"
    RELAY = "relay"  # generic relay adapter (EXPERIMENTAL)

    @classmethod
    def _missing_(cls, value):
        return None
`,
    "gateway/config_env.py": `
_ENV_ENABLE_CREDENTIALS: dict = {
    Platform.TELEGRAM: ("TELEGRAM_BOT_TOKEN",),
    Platform.DISCORD: ("DISCORD_BOT_TOKEN", "DISCORD_APP_ID"),
    Platform.RELAY: ("GATEWAY_RELAY_URL",),
}
`,
    "gateway/pairing.py": `
_PLATFORM_ALLOWLIST_ENV = {
    "telegram": "TELEGRAM_ALLOWED_USERS", "discord": "DISCORD_ALLOWED_USERS",
}
`,
    "gateway/authz_mixin.py": `
_GROUP_USER_ENV = {Platform.TELEGRAM: "TELEGRAM_GROUP_ALLOWED_USERS"}
_GROUP_CHAT_ENV = {Platform.TELEGRAM: "TELEGRAM_GROUP_ALLOWED_CHATS"}
_ALLOW_BOTS_ENV = {
    # Bots admitted by {PLATFORM}_ALLOW_BOTS bypass the human allowlist.
    Platform.DISCORD: "DISCORD_ALLOW_BOTS",
}
`,
    "gateway/run.py": `
roles = os.getenv("DISCORD_ALLOWED_ROLES", "")
`,
    "plugins/platforms/irc/adapter.py": `
    return PlatformEntry(
        name="irc", allowed_users_env="IRC_ALLOWED_USERS",
        allow_all_env="IRC_ALLOW_ALL_USERS",
    )
`,
    "plugins/platforms/discord/adapter.py": `
    return PlatformEntry(name="discord", allowed_users_env="DISCORD_ALLOWED_USERS")
`,
};

/** Judgments for the fixture: its one name outside the parsed tables. */
const JUDGED: Judgments = { grants: ["DISCORD_ALLOWED_ROLES"], notAccess: {} };

function upstream(t: TestContext, edits: Record<string, string> = {}) {
    const root = mkdtempSync(join(tmpdir(), "platforms-"));
    t.after(() => rmSync(root, { recursive: true, force: true }));
    for (const [path, text] of Object.entries({ ...UPSTREAM, ...edits })) {
        mkdirSync(dirname(join(root, path)), { recursive: true });
        writeFileSync(join(root, path), text);
    }
    return root;
}

test("the registry is read from upstream's source", (t) => {
    assert.deepEqual(readRegistry(upstream(t), JUDGED), {
        platforms: {
            discord: {
                enabledBy: ["DISCORD_APP_ID", "DISCORD_BOT_TOKEN"],
                allowedUsers: "DISCORD_ALLOWED_USERS",
                allowAllUsers: "DISCORD_ALLOW_ALL_USERS",
            },
            relay: {
                enabledBy: ["GATEWAY_RELAY_URL"],
                allowedUsers: "",
                allowAllUsers: "",
            },
            telegram: {
                enabledBy: ["TELEGRAM_BOT_TOKEN"],
                allowedUsers: "TELEGRAM_ALLOWED_USERS",
                allowAllUsers: "TELEGRAM_ALLOW_ALL_USERS",
            },
        },
        globalAllowlist: "GATEWAY_ALLOWED_USERS",
        globalAllowAll: "GATEWAY_ALLOW_ALL_USERS",
        extraAllowVariables: [
            "DISCORD_ALLOWED_ROLES",
            "DISCORD_ALLOW_BOTS",
            "IRC_ALLOWED_USERS",
            "IRC_ALLOW_ALL_USERS",
            "TELEGRAM_GROUP_ALLOWED_CHATS",
            "TELEGRAM_GROUP_ALLOWED_USERS",
        ],
    });
});

test("the output is sorted, indented JSON with a final newline", (t) => {
    const text = formatRegistry(readRegistry(upstream(t), JUDGED));
    assert.ok(text.endsWith("}\n"));
    assert.match(text, /^\{\n {4}"extraAllowVariables": \[\n/);
    const keys = [...text.matchAll(/^ {4}"(\w+)":/gm)].map((m) => m[1]);
    assert.deepEqual(keys, [
        "extraAllowVariables",
        "globalAllowAll",
        "globalAllowlist",
        "platforms",
    ]);
});

test("a table entry upstream reshaped stops the run", (t) => {
    const root = upstream(t, {
        "gateway/config_env.py": `
_ENV_ENABLE_CREDENTIALS: dict = {
    Platform.TELEGRAM: ("TELEGRAM_BOT_TOKEN",),
    Platform.DISCORD: _discord_credentials(),
}
`,
    });
    assert.throws(() => readRegistry(root, JUDGED), /_ENV_ENABLE_CREDENTIALS/);
});

test("a missing table stops the run", (t) => {
    const root = upstream(t, { "gateway/pairing.py": "\n" });
    assert.throws(() => readRegistry(root, JUDGED), /_PLATFORM_ALLOWLIST_ENV/);
});

test("an unknown platform member stops the run", (t) => {
    const root = upstream(t, {
        "gateway/config_env.py": `
_ENV_ENABLE_CREDENTIALS: dict = {
    Platform.SLACK: ("SLACK_BOT_TOKEN",),
}
`,
    });
    assert.throws(() => readRegistry(root, JUDGED), /Platform\.SLACK/);
});

test("a plugin allowlist named by a variable stops the run", (t) => {
    const root = upstream(t, {
        "plugins/platforms/irc/adapter.py": `
    return PlatformEntry(name="irc", allowed_users_env=IRC_ENV)
`,
    });
    assert.throws(() => readRegistry(root, JUDGED), /irc\/adapter\.py/);
});

const FOO = {
    "plugins/platforms/foo/adapter.py": `
policy = os.getenv("FOO_DM_POLICY", "pairing")
tools = os.getenv("SANDBOX_ALLOWED_TOOLS", "")
`,
};

test("an access-shaped name upstream adds must be judged", (t) => {
    assert.throws(
        () => readRegistry(upstream(t, FOO), JUDGED),
        /FOO_DM_POLICY.*SANDBOX_ALLOWED_TOOLS|SANDBOX_ALLOWED_TOOLS.*FOO_DM_POLICY/s,
    );
});

test("a judged grant joins the registry; an unrelated name stays out", (t) => {
    const registry = readRegistry(upstream(t, FOO), {
        grants: [...JUDGED.grants, "FOO_DM_POLICY"],
        notAccess: { SANDBOX_ALLOWED_TOOLS: "tools, not people" },
    });
    assert.ok(registry.extraAllowVariables.includes("FOO_DM_POLICY"));
    assert.ok(!registry.extraAllowVariables.includes("SANDBOX_ALLOWED_TOOLS"));
});

test("a judgment upstream no longer needs stops the run", (t) => {
    const judged = {
        grants: [...JUDGED.grants, "GONE_ALLOWED_USERS"],
        notAccess: { GONE_ALLOW_FROM: "removed upstream" },
    };
    assert.throws(
        () => readRegistry(upstream(t), judged),
        /GONE_ALLOWED_USERS.*GONE_ALLOW_FROM/s,
    );
});

test("the virtualenv and upstream's tests are not swept", (t) => {
    const root = upstream(t, {
        ".venv/lib/python3.13/site-packages/x.py": `BAR_ALLOWED_USERS = 1\n`,
        "tests/gateway/test_authz.py": `os.environ["BAR_ALLOW_ALL_USERS"] = "1"\n`,
        "gateway/test_helpers.py": `BAR_ALLOW_FROM = "*"\n`,
    });
    assert.doesNotThrow(() => readRegistry(root, JUDGED));
});

test("drift names each variable and platform that changed", (t) => {
    const committed = readRegistry(upstream(t), JUDGED);
    assert.deepEqual(registryDrift(committed, committed), []);
    const fresh = structuredClone(committed);
    fresh.extraAllowVariables.push("NEWCHAT_ALLOW_FROM");
    fresh.extraAllowVariables = fresh.extraAllowVariables.filter(
        (name) => name !== "IRC_ALLOWED_USERS",
    );
    fresh.platforms.telegram.enabledBy = ["TELEGRAM_BOT_TOKEN", "TELEGRAM_X"];
    delete fresh.platforms.relay;
    assert.deepEqual(registryDrift(committed, fresh), [
        "extraAllowVariables gains NEWCHAT_ALLOW_FROM",
        "extraAllowVariables loses IRC_ALLOWED_USERS",
        "platforms.relay is gone",
        "platforms.telegram changed",
    ]);
});
