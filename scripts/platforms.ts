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

/** Role allowlists (Discord) grant access before the user allowlist is read. */
function roleVariables(root: string): Set<string> {
    const roles = /\b[A-Z][A-Z0-9_]*_ALLOWED_ROLES\b/g;
    const found = new Set<string>();
    for (const dir of ["gateway", "plugins"])
        for (const file of pythonFiles(join(root, dir)))
            for (const match of readFileSync(file, "utf8").matchAll(roles))
                found.add(match[0]);
    return found;
}

export function readRegistry(root = "/opt/hermes"): PlatformRegistry {
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
    for (const name of roleVariables(root)) extra.add(name);
    for (const entry of Object.values(platforms)) {
        extra.delete(entry.allowedUsers);
        extra.delete(entry.allowAllUsers);
    }

    return {
        platforms,
        globalAllowlist: "GATEWAY_ALLOWED_USERS",
        globalAllowAll: "GATEWAY_ALLOW_ALL_USERS",
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

if (import.meta.main) {
    process.stdout.write(formatRegistry(readRegistry(process.argv[2])));
}
