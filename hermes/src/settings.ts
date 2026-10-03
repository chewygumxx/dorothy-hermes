// vim:set expandtab shiftwidth=4 filetype=typescript:
// SPDX-License-Identifier: GPL-3.0-only

//
//
// ~chewygumxx/dorothy-hermes.git
// ::: :/hermes/src/settings.ts
//
//

import { readFileSync } from "node:fs";
import { hostname } from "node:os";

export type Env = Record<string, string | undefined>;

export class SettingsError extends Error {}

export interface PlatformEntry {
    enabledBy: string[];
    allowedUsers: string;
    allowAllUsers: string;
}

/** Generated from the pinned image by `scripts/platforms.ts` (S6). */
export interface PlatformRegistry {
    platforms: Record<string, PlatformEntry>;
    globalAllowlist: string;
    globalAllowAll: string;
    extraAllowVariables: string[];
}

export function loadRegistry(
    path: string | URL = new URL("./platforms.json", import.meta.url),
): PlatformRegistry {
    return JSON.parse(readFileSync(path, "utf8")) as PlatformRegistry;
}

const FALSY = new Set(["", "0", "false", "no", "off"]);

function isSet(value: string | undefined): boolean {
    return !FALSY.has((value ?? "").trim().toLowerCase());
}

/** Every variable that grants access, for the `.env` cleanup. */
export function allowlistNames(registry: PlatformRegistry): string[] {
    const names = new Set<string>([
        registry.globalAllowlist,
        registry.globalAllowAll,
        ...registry.extraAllowVariables,
    ]);
    for (const entry of Object.values(registry.platforms)) {
        names.add(entry.allowedUsers);
        names.add(entry.allowAllUsers);
    }
    names.delete("");
    return [...names].sort();
}

/** Upstream reads a `*` entry in any allowlist as "everyone". */
function hasWildcard(value: string | undefined): boolean {
    return (value ?? "").split(/[\s,[\]"']+/).includes("*");
}

/** A truthy switch that admits everyone, or every bot. */
const SWITCH = /_ALLOW_ALL_USERS$|_ALLOW_BOTS$/;
/** open | allowlist | pairing | disabled. */
const POLICY = /_POLICY$/;

/**
 * Access settings recognised by name alone, for what the registry does not
 * know yet (an upstream bump before platforms.json is regenerated). Narrower
 * than the sweep in scripts/platforms.ts: names that only narrow where the
 * bot answers (`*_ALLOWED_CHANNELS`) or are not about people stay out.
 */
const ACCESS_BY_NAME =
    /^[A-Z][A-Z0-9_]*_(?:ALLOW_ALL_USERS|ALLOW_BOTS|ALLOWED_USERS|ALLOW_FROM|DM_POLICY|GROUP_POLICY)$/;

/** Whether `name` grants access, by the registry or by its name. */
export function isAccessVariable(
    registry: PlatformRegistry,
): (name: string) => boolean {
    const names = new Set(allowlistNames(registry));
    return (name) => names.has(name) || ACCESS_BY_NAME.test(name);
}

export function checkAllowlists(env: Env, registry: PlatformRegistry): void {
    const platforms = Object.values(registry.platforms);
    const extra = [
        ...new Set([
            ...registry.extraAllowVariables,
            ...Object.keys(env).filter((name) => ACCESS_BY_NAME.test(name)),
        ]),
    ];
    const allowAll = [
        registry.globalAllowAll,
        ...platforms.map((entry) => entry.allowAllUsers),
        ...extra.filter((name) => name.endsWith("_ALLOW_ALL_USERS")),
    ];
    for (const name of allowAll) {
        if (name && isSet(env[name])) {
            throw new SettingsError(
                `${name} lets anyone talk to Dorothy; remove it`,
            );
        }
    }
    // Every other extra lists who gets in, whatever its suffix.
    const allowlists = [
        registry.globalAllowlist,
        ...platforms.map((entry) => entry.allowedUsers),
        ...extra.filter((name) => !SWITCH.test(name) && !POLICY.test(name)),
    ];
    for (const name of allowlists) {
        if (name && hasWildcard(env[name])) {
            throw new SettingsError(
                `${name} contains "*", which lets anyone in; remove it`,
            );
        }
    }
    for (const name of extra) {
        if (name.endsWith("_ALLOW_BOTS") && isSet(env[name])) {
            throw new SettingsError(
                `${name} admits bots past the allowlist; remove it`,
            );
        }
        if (
            POLICY.test(name) &&
            (env[name] ?? "").trim().toLowerCase() === "open"
        ) {
            throw new SettingsError(
                `${name}=open lets anyone talk to Dorothy; remove it`,
            );
        }
    }
    for (const [platform, entry] of Object.entries(registry.platforms)) {
        if (!entry.allowedUsers) continue;
        const enabledBy = entry.enabledBy.filter((name) => isSet(env[name]));
        if (enabledBy.length > 0 && !(env[entry.allowedUsers] ?? "").trim()) {
            throw new SettingsError(
                `${enabledBy.join(", ")} enables ${platform}, but ${entry.allowedUsers} is empty`,
            );
        }
    }
}

function required(env: Env, name: string): string {
    const value = (env[name] ?? "").trim();
    if (!value) throw new SettingsError(`${name} is required`);
    return value;
}

function privateKey(env: Env, name: string): string {
    const text = Buffer.from(required(env, name), "base64").toString("utf8");
    if (!/-----BEGIN [A-Z ]*PRIVATE KEY-----/.test(text)) {
        throw new SettingsError(`${name} must be a base64-encoded private key`);
    }
    return text.endsWith("\n") ? text : `${text}\n`;
}

function wholeNumber(
    env: Env,
    name: string,
    fallback: number,
    minimum: number,
): number {
    const raw = (env[name] ?? "").trim() || String(fallback);
    if (!/^\d+$/.test(raw) || Number(raw) < minimum) {
        throw new SettingsError(
            `${name} must be a whole number of at least ${minimum}`,
        );
    }
    return Number(raw);
}

export function repoName(url: string): string | null {
    return (
        /github\.com[:/]([\w.-]+\/[\w.-]+?)(?:\.git)?\/?$/.exec(url)?.[1] ??
        null
    );
}

export function syncInterval(env: Env): number {
    return wholeNumber(env, "DOROTHY_SYNC_INTERVAL", 900, 60);
}

export interface HermesSettings {
    configRepo: string;
    configRepoName: string;
    /** PEM text, decoded from base64. */
    configKey: string;
    interval: number;
}

export function hermesSettings(
    env: Env,
    registry: PlatformRegistry,
): HermesSettings {
    const configRepo = required(env, "DOROTHY_CONFIG_REPO");
    const configRepoName =
        (env.DOROTHY_CONFIG_REPO_NAME ?? "").trim() || repoName(configRepo);
    if (!configRepoName) {
        throw new SettingsError(
            "DOROTHY_CONFIG_REPO_NAME is required when DOROTHY_CONFIG_REPO is not a GitHub URL",
        );
    }
    const settings = {
        configRepo,
        configRepoName,
        configKey: privateKey(env, "DOROTHY_CONFIG_DEPLOY_KEY"),
        interval: syncInterval(env),
    };
    checkAllowlists(env, registry);
    return settings;
}

export interface SidecarSettings {
    memoryRepo: string;
    memoryKey: string;
    interval: number;
    bundleMaxBytes: number;
    allowEmpty: boolean;
    /** Names the server in sync commit messages. */
    host: string;
}

export function sidecarSettings(env: Env): SidecarSettings {
    return {
        memoryRepo: required(env, "DOROTHY_MEMORY_REPO"),
        memoryKey: privateKey(env, "DOROTHY_MEMORY_DEPLOY_KEY"),
        interval: syncInterval(env),
        bundleMaxBytes: wholeNumber(
            env,
            "DOROTHY_BUNDLE_MAX_BYTES",
            256 * 1024 * 1024,
            1,
        ),
        allowEmpty: (env.DOROTHY_ALLOW_EMPTY ?? "").trim() === "1",
        host: (env.DOROTHY_HOST ?? "").trim() || hostname(),
    };
}
