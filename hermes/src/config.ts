import { readFileSync } from "node:fs";
import { join } from "node:path";
import { Git } from "./git.ts";
import type { ContainerPaths, HermesCli } from "./hermes.ts";
import {
    type ApplyStatus,
    readJson,
    writeFileAtomic,
    writeJson,
} from "./status.ts";
import {
    type Clock,
    errorMessage,
    iso,
    type Log,
    lstatOrNull,
} from "./util.ts";

export const CONFIG_FILES = ["SOUL.md", "config.yaml"] as const;
export const SKILLS_DIR = "/opt/data/dorothy/config/skills";

export interface ConfigPaths {
    home: string;
    checkout: string;
    lastGood: string;
    applyStatus: string;
}

export function configPaths(home = "/opt/data"): ConfigPaths {
    return {
        home,
        checkout: join(home, "dorothy/config"),
        lastGood: join(home, "dorothy/last-good"),
        applyStatus: join(home, "dorothy/status/apply.json"),
    };
}

export function configGit(
    paths: ContainerPaths,
    env?: NodeJS.ProcessEnv,
    signal?: AbortSignal,
): Git {
    return new Git(configPaths(paths.home).checkout, {
        keyPath: join(paths.run, "config.key"),
        knownHostsPath: paths.knownHosts,
        env,
        signal,
    });
}

function readRegular(path: string): Buffer | null {
    const stat = lstatOrNull(path);
    if (stat === null) return null;
    if (!stat.isFile()) throw new Error(`${path} is not a regular file`);
    return readFileSync(path);
}

/**
 * Copies, never links: upstream refuses symlinked config paths. Both files
 * are read before either is written, so a missing one changes nothing.
 */
export function copyConfig(from: string, to: string): void {
    const files = CONFIG_FILES.map((name) => {
        const data = readRegular(join(from, name));
        if (data === null) throw new Error(`${name} is missing from ${from}`);
        return [name, data] as const;
    });
    for (const [name, data] of files)
        writeFileAtomic(join(to, name), data, 0o600);
}

export function sameConfig(a: string, b: string): boolean {
    return CONFIG_FILES.every((name) => {
        const left = readRegular(join(a, name));
        const right = readRegular(join(b, name));
        return left !== null && right !== null && left.equals(right);
    });
}

export function hasLastGood(paths: ConfigPaths): boolean {
    return CONFIG_FILES.every((name) =>
        lstatOrNull(join(paths.lastGood, name))?.isFile(),
    );
}

export function skillsWarning(configYaml: string): string | null {
    if (configYaml.includes(SKILLS_DIR)) return null;
    return `config.yaml does not list ${SKILLS_DIR} in skills.external_dirs; hand-written skills will not load`;
}

export interface GatewayTestTiming {
    /** How long the old process may take to exit (upstream drains cron jobs first). */
    drainWithinMs: number;
    upWithinMs: number;
    stableForMs: number;
    pollMs: number;
}

export const GATEWAY_TEST: GatewayTestTiming = {
    drainWithinMs: 90_000,
    upWithinMs: 30_000,
    stableForMs: 10_000,
    pollMs: 1_000,
};

export interface ApplyDeps extends Clock {
    git: Git;
    hermes: HermesCli;
    paths: ConfigPaths;
    log: Log;
    timing?: GatewayTestTiming;
}

export type ApplyOutcome = "unchanged" | "applied" | "rolled-back" | "failed";

/**
 * Once previousPid has gone (within 90 s): up within 30 s under another pid,
 * and the same pid 10 s later. The 30 s start only when the old process has
 * exited, so a restart that waits for a cron job is not judged early.
 */
export async function gatewayTest(
    deps: ApplyDeps,
    previousPid: number | null,
): Promise<boolean> {
    const timing = deps.timing ?? GATEWAY_TEST;
    if (previousPid !== null) {
        const drained = deps.now() + timing.drainWithinMs;
        while (deps.now() < drained) {
            const status = await deps.hermes.gatewayStatus();
            if (!status?.up || status.pid !== previousPid) break;
            await deps.sleep(timing.pollMs);
        }
    }
    const deadline = deps.now() + timing.upWithinMs;
    let pid: number | null = null;
    while (deps.now() < deadline) {
        const status = await deps.hermes.gatewayStatus();
        if (status?.up && status.pid !== null && status.pid !== previousPid) {
            pid = status.pid;
            break;
        }
        await deps.sleep(timing.pollMs);
    }
    if (pid === null) return false;
    await deps.sleep(timing.stableForMs);
    const later = await deps.hermes.gatewayStatus();
    return later?.up === true && later.pid === pid;
}

/** Restart, then start: a slot that stopped itself (exit 78 or 0) ignores restart. */
async function bounce(deps: ApplyDeps): Promise<number | null> {
    const before = (await deps.hermes.gatewayStatus())?.pid ?? null;
    try {
        await deps.hermes.restartGateway();
    } catch (error) {
        deps.log(`gateway restart: ${errorMessage(error)}`);
    }
    try {
        await deps.hermes.startGateway();
    } catch (error) {
        deps.log(`gateway start: ${errorMessage(error)}`);
    }
    return before;
}

function warnAboutSkills(deps: ApplyDeps): void {
    const warning = skillsWarning(
        readFileSync(join(deps.paths.home, "config.yaml"), "utf8"),
    );
    if (warning) deps.log(warning);
}

function passed(
    deps: ApplyDeps,
    status: ApplyStatus,
    sha: string | null,
): void {
    copyConfig(deps.paths.home, deps.paths.lastGood);
    const lastApplyAt = iso(deps.now());
    // A rolled-back head that still boots keeps its record: the operator
    // must push a fix, and health stays unhealthy until then.
    const next: ApplyStatus =
        sha !== null && sha !== status.rolledBackSha
            ? { appliedSha: sha, configRolledBack: false, lastApplyAt }
            : { ...status, lastApplyAt };
    writeJson(deps.paths.applyStatus, next);
}

async function rollBack(
    deps: ApplyDeps,
    status: ApplyStatus,
    badSha: string,
): Promise<ApplyOutcome> {
    const record = (lastError: string): void =>
        writeJson(deps.paths.applyStatus, {
            ...status,
            rolledBackSha: badSha,
            configRolledBack: true,
            lastApplyAt: iso(deps.now()),
            lastError,
        });
    if (
        !hasLastGood(deps.paths) ||
        sameConfig(deps.paths.lastGood, deps.paths.home)
    ) {
        record(
            `gateway test failed for ${badSha} and no different last-good config exists`,
        );
        deps.log(
            `config ${badSha} failed the gateway test; nothing to roll back to`,
        );
        return "failed";
    }
    copyConfig(deps.paths.lastGood, deps.paths.home);
    const recovered = await gatewayTest(deps, await bounce(deps));
    record(
        recovered
            ? `rolled back ${badSha}`
            : `rolled back ${badSha}, but the gateway is still down`,
    );
    deps.log(`config ${badSha} failed the gateway test and was rolled back`);
    return "rolled-back";
}

/** The webhook's apply; until plan 3, run only by the snapshot loop's fallback. */
export async function applyConfig(deps: ApplyDeps): Promise<ApplyOutcome> {
    const status = readJson<ApplyStatus>(deps.paths.applyStatus) ?? {};
    await deps.git.fetch();
    const target = await deps.git.remoteHead();
    if (target === null) throw new Error("dorothy-config has no main branch");
    if (target === status.appliedSha || target === status.rolledBackSha)
        return "unchanged";
    await deps.git.resetHard(target);
    try {
        copyConfig(deps.paths.checkout, deps.paths.home);
    } catch (error) {
        // Recorded like a rollback: the running config stays, and the head is not retried.
        const lastError = `config ${target} not applied: ${errorMessage(error)}`;
        writeJson(deps.paths.applyStatus, {
            ...status,
            rolledBackSha: target,
            configRolledBack: true,
            lastApplyAt: iso(deps.now()),
            lastError,
        });
        deps.log(lastError);
        return "failed";
    }
    warnAboutSkills(deps);
    if (await gatewayTest(deps, await bounce(deps))) {
        passed(deps, status, target);
        deps.log(`applied config ${target}`);
        return "applied";
    }
    return rollBack(deps, status, target);
}

/** Verifies the config the container booted with. */
export async function bootCheck(
    deps: ApplyDeps,
    registerWithinMs = 120_000,
): Promise<ApplyOutcome> {
    const deadline = deps.now() + registerWithinMs;
    while ((await deps.hermes.gatewayStatus()) === null) {
        if (deps.now() >= deadline) {
            deps.log("the gateway slot never registered");
            break;
        }
        await deps.sleep(1_000);
    }
    const status = readJson<ApplyStatus>(deps.paths.applyStatus) ?? {};
    const head = await deps.git.head();
    if (await gatewayTest(deps, null)) {
        passed(deps, status, head);
        deps.log(`boot check passed for config ${head}`);
        return "applied";
    }
    if (head === null) return "failed";
    return rollBack(deps, status, head);
}
