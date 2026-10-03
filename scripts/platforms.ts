// vim:set expandtab shiftwidth=4 filetype=typescript:
// SPDX-License-Identifier: GPL-3.0-only

//
//
// ~chewygumxx/dorothy-hermes.git
// ::: :/scripts/platforms.ts
//
//

/**
 * Prints the pinned image's platform allowlist registry as JSON (S6), read
 * from upstream's Python source as text. Every table must parse completely:
 * a line in a shape this script does not know stops the run, so an upstream
 * change can never silently drop an allowlist.
 *
 * Run inside the image, then let Biome lay the file out:
 *   docker run --rm --entrypoint /usr/local/bin/node \
 *     -v "$PWD/scripts:/s:ro" IMAGE /s/platforms.ts > hermes/src/platforms.json
 *   biome format --write hermes/src/platforms.json
 */

import { readdirSync, readFileSync } from "node:fs";
import { join, relative } from "node:path";
import type {
    PlatformEntry,
    PlatformRegistry,
} from "../hermes/src/settings.ts";

export class UpstreamShapeError extends Error {}

const NAME = `"([A-Z][A-Z0-9_]*)"`;
const GLOBAL_ALLOWLIST = "GATEWAY_ALLOWED_USERS";
const GLOBAL_ALLOW_ALL = "GATEWAY_ALLOW_ALL_USERS";

const NARROWS = "narrows where the bot answers; empty means no restriction";

/** Judged against the pinned image; see Judgments. */
export const JUDGMENTS: Judgments = {
    grants: [
        // Members of a listed group or room, or a trusted peer, get in.
        "A2A_TRUSTED_PEERS",
        "DISCORD_ALLOWED_ROLES",
        "LINE_ALLOWED_GROUPS",
        "LINE_ALLOWED_ROOMS",
        "SIGNAL_GROUP_ALLOWED_USERS",
        "SIMPLEX_GROUP_ALLOWED",
        "WEIXIN_GROUP_ALLOWED_USERS",
        "WHATSAPP_ALLOW_FROM",
        "WHATSAPP_CLOUD_ALLOW_FROM",
        "WHATSAPP_CLOUD_GROUP_ALLOW_FROM",
        "WHATSAPP_GROUP_ALLOWED_USERS",
        "WHATSAPP_GROUP_ALLOW_FROM",
        "YUANBAO_DM_ALLOW_FROM",
        "YUANBAO_GROUP_ALLOW_FROM",
        // open | allowlist | pairing | disabled: "open" lets anyone in.
        "FEISHU_GROUP_POLICY",
        "WECOM_DM_POLICY",
        "WECOM_GROUP_POLICY",
        "WEIXIN_DM_POLICY",
        "WEIXIN_GROUP_POLICY",
        "WHATSAPP_CLOUD_DM_POLICY",
        "WHATSAPP_CLOUD_GROUP_POLICY",
        "WHATSAPP_DM_POLICY",
        "WHATSAPP_GROUP_POLICY",
        "YUANBAO_DM_POLICY",
        "YUANBAO_GROUP_POLICY",
    ],
    notAccess: {
        DEMO_ALLOWED_SENDER: "an example in a comment (local_env_policy.py)",
        DINGTALK_ALLOWED_CHATS: NARROWS,
        DISCORD_ALLOWED_CHANNELS: NARROWS,
        LOGIN_NOT_ALLOWED: "an error message",
        MATRIX_ALLOWED_ROOMS: NARROWS,
        MATTERMOST_ALLOWED_CHANNELS: NARROWS,
        MSTEAMS_ALLOWED_USERS:
            "named only by the OpenClaw migration skill; Teams reads TEAMS_ALLOWED_USERS",
        NOT_ALLOWED: "an error code",
        PLATFORM_ALLOWED_USERS: "a placeholder in an authz_mixin.py docstring",
        PLATFORM_GROUP_ALLOWED_CHATS:
            "a placeholder in an authz_mixin.py docstring",
        PLATFORM_GROUP_ALLOWED_USERS:
            "a placeholder in an authz_mixin.py docstring",
        RELAY_ALLOWED_USERS:
            "upstream documents that the relay has no local allowlist",
        SANDBOX_ALLOWED_TOOLS: "the code sandbox's tools, not people",
        SLACK_ALLOWED_CHANNELS: NARROWS,
        TELEGRAM_ALLOWED_CHATS: NARROWS,
        TELEGRAM_ALLOWED_TOPICS: NARROWS,
        TOOL_NOT_ALLOWED: "an error code",
    },
};
const MEMBER = String.raw`Platform\.([A-Z][A-Z0-9_]*)`;

function read(root: string, path: string): string {
    return readFileSync(join(root, path), "utf8");
}

/** Every `*.py` file under `dir`, as `rglob("*.py")` finds them. */
function pythonFiles(dir: string): string[] {
    return readdirSync(dir, { recursive: true, withFileTypes: true })
        .filter((entry) => entry.isFile() && entry.name.endsWith(".py"))
        .map((entry) => join(entry.parentPath, entry.name))
        .sort();
}

/** `class Platform(Enum)` members, by member name. */
function platformValues(source: string): Map<string, string> {
    const start = source.match(/^class Platform\(Enum\):\n/m);
    if (start?.index === undefined)
        throw new UpstreamShapeError("class Platform(Enum) is missing");
    const values = new Map<string, string>();
    const member = /^ {4}([A-Z][A-Z0-9_]*) = "([a-z0-9_]+)"(?:\s*#.*)?$/;
    const body = source
        .slice(start.index + start[0].length)
        .replace(/^ {4}"""[\s\S]*?"""\n/, "");
    for (const line of body.split("\n")) {
        if (line.trim() === "") continue;
        const found = line.match(member);
        if (!found) break;
        values.set(found[1], found[2]);
    }
    if (values.size === 0)
        throw new UpstreamShapeError("class Platform(Enum) has no members");
    return values;
}

/**
 * The entries of the dict literal assigned to `name`, as [key, value] source
 * text. Comments are dropped first (one holds `{PLATFORM}`); anything left
 * between entries stops the run.
 */
function dictEntries(
    source: string,
    name: string,
    key: string,
    value: string,
): [string, string][] {
    const start = source.match(
        new RegExp(String.raw`^${name}(?:\s*:\s*\w+)?\s*=\s*\{`, "m"),
    );
    if (start?.index === undefined)
        throw new UpstreamShapeError(`${name} is missing`);
    const rest = source
        .slice(start.index + start[0].length)
        .replace(/#[^\n]*/g, "");
    const end = rest.indexOf("}");
    if (end < 0) throw new UpstreamShapeError(`${name} is not closed`);
    const body = rest.slice(0, end);
    const entry = new RegExp(
        String.raw`\s*(?:${key})\s*:\s*(${value})\s*(?:,|(?=\s*$))`,
        "y",
    );
    const entries: [string, string][] = [];
    while (entry.lastIndex < body.length) {
        const at = entry.lastIndex;
        const found = entry.exec(body);
        if (!found) {
            if (body.slice(at).trim() === "") break;
            throw new UpstreamShapeError(
                `${name} has an entry this script cannot read: ${body.slice(at).trim().split("\n")[0]}`,
            );
        }
        entries.push([found[1], found[2]]);
    }
    if (entries.length === 0) throw new UpstreamShapeError(`${name} is empty`);
    return entries;
}

function names(text: string): string[] {
    return [...text.matchAll(new RegExp(NAME, "g"))].map((m) => m[1]);
}

/** Plugin platforms declare their own allowlist and allow-all switches. */
function pluginVariables(root: string): Set<string> {
    const found = new Set<string>();
    const kwarg =
        /(?<![.\w])(allowed_users_env|allow_all_env)\s*=(?!=)\s*(\S)/g;
    for (const file of pythonFiles(join(root, "plugins"))) {
        const source = readFileSync(file, "utf8");
        for (const match of source.matchAll(kwarg)) {
            const literal = source
                .slice((match.index ?? 0) + match[0].length - 1)
                .match(/^"([A-Z0-9_]*)"/);
            if (!literal)
                throw new UpstreamShapeError(
                    `${relative(root, file)} sets ${match[1]} from something other than a string literal`,
                );
            if (literal[1]) found.add(literal[1]);
        }
    }
    return found;
}

/**
 * Names outside the parsed tables that look like access settings, judged
 * by reading where upstream uses them. A grant joins extraAllowVariables;
 * anything else needs the reason it does not let anyone in.
 */
export interface Judgments {
    grants: string[];
    notAccess: Record<string, string>;
}

/** Anything named like an allowlist, an allow-all switch, a trust list or a DM/group policy. */
const ACCESS_SHAPED =
    /\b[A-Z][A-Z0-9_]*_(?:ALLOWED(?:_[A-Z]+)?|ALLOW_ALL_[A-Z]+|ALLOW_BOTS|ALLOW_FROM|TRUSTED_[A-Z]+|(?:DM|GROUP)_POLICY)\b/g;

/** Upstream's own source, without its virtualenv, Node packages or tests. */
function sweptFiles(root: string): string[] {
    return pythonFiles(root).filter((file) => {
        const path = relative(root, file);
        return !(
            /^(?:\.venv|node_modules)\//.test(path) ||
            /(?:^|\/)tests?\//.test(path) ||
            /(?:^|\/)test_[^/]*\.py$|_test\.py$/.test(path)
        );
    });
}

/**
 * Every access-shaped name in upstream's source must be in the parsed
 * tables or judged; a new one stops the run until someone reads it.
 */
function sweep(root: string, known: Set<string>, judged: Judgments): string[] {
    const found = new Set<string>();
    for (const file of sweptFiles(root))
        for (const match of readFileSync(file, "utf8").matchAll(ACCESS_SHAPED))
            found.add(match[0]);
    const verdicts = new Set([
        ...judged.grants,
        ...Object.keys(judged.notAccess),
    ]);
    const unjudged = [...found].filter(
        (name) => !known.has(name) && !verdicts.has(name),
    );
    if (unjudged.length > 0)
        throw new UpstreamShapeError(
            `judge these access-shaped names in scripts/platforms.ts: ${unjudged.sort().join(", ")}`,
        );
    const stale = [...verdicts].filter((name) => !found.has(name));
    if (stale.length > 0)
        throw new UpstreamShapeError(
            `upstream no longer mentions these judged names; drop them: ${stale.sort().join(", ")}`,
        );
    return judged.grants;
}

export function readRegistry(
    root = "/opt/hermes",
    judged: Judgments = JUDGMENTS,
): PlatformRegistry {
    const members = platformValues(read(root, "gateway/config.py"));
    const allowlists = new Map(
        dictEntries(
            read(root, "gateway/pairing.py"),
            "_PLATFORM_ALLOWLIST_ENV",
            `"([a-z0-9_]+)"`,
            NAME,
        ).map(([platform, value]) => [platform, names(value)[0]]),
    );

    const platforms: Record<string, PlatformEntry> = {};
    for (const [member, value] of dictEntries(
        read(root, "gateway/config_env.py"),
        "_ENV_ENABLE_CREDENTIALS",
        MEMBER,
        String.raw`\(\s*${NAME}(?:\s*,\s*${NAME})*\s*,?\s*\)`,
    )) {
        const platform = members.get(member);
        if (!platform)
            throw new UpstreamShapeError(
                `_ENV_ENABLE_CREDENTIALS names Platform.${member}, which class Platform lacks`,
            );
        const allowed = allowlists.get(platform) ?? "";
        platforms[platform] = {
            enabledBy: names(value).sort(),
            allowedUsers: allowed,
            allowAllUsers: allowed
                ? allowed.replaceAll("_ALLOWED_USERS", "_ALLOW_ALL_USERS")
                : "",
        };
    }

    const authz = read(root, "gateway/authz_mixin.py");
    const extra = new Set<string>();
    for (const table of [
        "_ALLOW_BOTS_ENV",
        "_GROUP_USER_ENV",
        "_GROUP_CHAT_ENV",
    ])
        for (const [, value] of dictEntries(authz, table, MEMBER, NAME))
            extra.add(names(value)[0]);
    for (const name of pluginVariables(root)) extra.add(name);
    const known = new Set([
        ...extra,
        GLOBAL_ALLOWLIST,
        GLOBAL_ALLOW_ALL,
        ...Object.values(platforms).flatMap((entry) => [
            entry.allowedUsers,
            entry.allowAllUsers,
        ]),
    ]);
    for (const name of sweep(root, known, judged)) extra.add(name);
    for (const entry of Object.values(platforms)) {
        extra.delete(entry.allowedUsers);
        extra.delete(entry.allowAllUsers);
    }

    return {
        platforms,
        globalAllowlist: GLOBAL_ALLOWLIST,
        globalAllowAll: GLOBAL_ALLOW_ALL,
        extraAllowVariables: [...extra].sort(),
    };
}

function sortKeys(value: unknown): unknown {
    if (Array.isArray(value)) return value.map(sortKeys);
    if (value && typeof value === "object")
        return Object.fromEntries(
            Object.entries(value)
                .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
                .map(([k, v]) => [k, sortKeys(v)]),
        );
    return value;
}

/** Sorted keys, four-space indent; Biome then folds the short arrays. */
export function formatRegistry(registry: PlatformRegistry): string {
    return `${JSON.stringify(sortKeys(registry), null, 4)}\n`;
}

/** What changed from the committed registry to a fresh one, one line each. */
export function registryDrift(
    committed: PlatformRegistry,
    fresh: PlatformRegistry,
): string[] {
    const drift: string[] = [];
    const was = new Set(committed.extraAllowVariables);
    const now = new Set(fresh.extraAllowVariables);
    for (const name of [...now].filter((n) => !was.has(n)).sort())
        drift.push(`extraAllowVariables gains ${name}`);
    for (const name of [...was].filter((n) => !now.has(n)).sort())
        drift.push(`extraAllowVariables loses ${name}`);
    for (const key of ["globalAllowlist", "globalAllowAll"] as const)
        if (committed[key] !== fresh[key])
            drift.push(`${key} is now ${fresh[key]}`);
    const platforms = new Set([
        ...Object.keys(committed.platforms),
        ...Object.keys(fresh.platforms),
    ]);
    for (const platform of [...platforms].sort()) {
        const before = committed.platforms[platform];
        const after = fresh.platforms[platform];
        if (!after) drift.push(`platforms.${platform} is gone`);
        else if (!before) drift.push(`platforms.${platform} is new`);
        else if (
            JSON.stringify(sortKeys(before)) !== JSON.stringify(sortKeys(after))
        )
            drift.push(`platforms.${platform} changed`);
    }
    return drift;
}

if (import.meta.main) {
    const [flag, file, root] = process.argv.slice(2);
    if (flag === "--check") {
        // Exit 1 when the committed file no longer matches upstream.
        const committed = JSON.parse(
            readFileSync(file, "utf8"),
        ) as PlatformRegistry;
        const drift = registryDrift(committed, readRegistry(root));
        for (const line of drift) process.stderr.write(`${line}\n`);
        process.exitCode = drift.length > 0 ? 1 : 0;
    } else {
        process.stdout.write(formatRegistry(readRegistry(flag)));
    }
}
