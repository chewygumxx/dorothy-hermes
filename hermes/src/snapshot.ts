// vim:set expandtab shiftwidth=4 filetype=typescript:
// SPDX-License-Identifier: GPL-3.0-only

//
//
// ~chewygumxx/dorothy-hermes.git
// ::: :/hermes/src/snapshot.ts
//
//

import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import {
    type BundleFile,
    encodeFile,
    fileBytes,
    readTrustedBundle,
    writeBundle,
} from "./bundle.ts";
import {
    type ApplyDeps,
    applyConfig,
    bootCheck,
    configGit,
    configPaths,
    type GatewayTestTiming,
} from "./config.ts";
import { checkTables, dumpDatabase } from "./dump.ts";
import { collectFile, collectTree } from "./files.ts";
import {
    type ContainerPaths,
    createHermesCli,
    type HermesCli,
    IMAGE_CONTAINER_PATHS,
} from "./hermes.ts";
import { tryWithLock, withLock } from "./lock.ts";
import { collectSecrets, parseDotenv, Redactor } from "./redact.ts";
import { type Env, syncInterval } from "./settings.ts";
import {
    readJson,
    readText,
    type SnapshotStatus,
    writeJson,
} from "./status.ts";
import {
    type Clock,
    errorMessage,
    iso,
    type Log,
    logger,
    realClock,
    retry,
} from "./util.ts";

export const SNAPSHOT_LABEL = "dorothy-sync";

export interface SnapshotDeps extends Clock {
    env: Env;
    paths: ContainerPaths;
    hermes: HermesCli;
    log: Log;
    gitEnv?: NodeJS.ProcessEnv;
    timing?: GatewayTestTiming;
    /** Stops a running fetch when the service stops. */
    signal?: AbortSignal;
}

function applyDeps(deps: SnapshotDeps): ApplyDeps {
    return {
        now: deps.now,
        sleep: deps.sleep,
        git: configGit(deps.paths, deps.gitEnv, deps.signal),
        hermes: deps.hermes,
        paths: configPaths(deps.paths.home),
        log: deps.log,
        timing: deps.timing,
        signal: deps.signal,
    };
}

/** Names from `skills/.bundled_manifest` (`name:hash` lines). */
export function bundledSkillNames(home: string): Set<string> {
    const names = new Set<string>();
    for (const line of readText(join(home, "skills/.bundled_manifest")).split(
        "\n",
    )) {
        const name = line.split(":")[0]?.trim();
        if (name) names.add(name);
    }
    return names;
}

function userFiles(home: string): BundleFile[] {
    const bundled = bundledSkillNames(home);
    return [
        ...collectTree(home, "memories", {
            skipDirectory: () => true,
            includeFile: (path) => path.endsWith(".md"),
        }),
        ...collectTree(home, "skills", {
            skipDirectory: (path) => {
                const parts = path.split("/");
                return parts.length === 3 && bundled.has(parts[2] ?? "");
            },
        }),
    ];
}

function redactFile(file: BundleFile, redactor: Redactor): BundleFile {
    if (file.encoding === "utf8")
        return { ...file, content: redactor.text(file.content) };
    return encodeFile(file.path, redactor.bytes(fileBytes(file)), file.mode);
}

function recordStatus(deps: SnapshotDeps, update: SnapshotStatus): void {
    const path = join(deps.paths.home, "dorothy/status/snapshot.json");
    writeJson(path, { ...(readJson<SnapshotStatus>(path) ?? {}), ...update });
}

/** The webhook's apply, for pushes whose delivery was lost. */
async function fallbackApply(deps: SnapshotDeps): Promise<void> {
    const result = await tryWithLock(
        join(deps.paths.run, "apply.lock"),
        async () => {
            try {
                await applyConfig(applyDeps(deps));
            } catch (error) {
                deps.log(`config check failed: ${errorMessage(error)}`);
            }
        },
    );
    if (!result.ran) deps.log("an apply is running; skipping the config check");
}

/**
 * The final snapshot shares one budget for the lock wait and backup retries,
 * leaving the rest of S6_KILL_FINISH_MAXTIME (60 s) for the dump and bundle.
 */
export const FINAL_BUDGET_MS = 40_000;

async function takeBackup(
    deps: SnapshotDeps,
    finalDeadline: number | null,
): Promise<string> {
    if (finalDeadline === null) return deps.hermes.snapshot(SNAPSHOT_LABEL);
    // An interrupted snapshot's child may still hold the backup lock.
    const forMs = Math.max(1_000, finalDeadline - deps.now());
    return retry("hermes backup", () => deps.hermes.snapshot(SNAPSHOT_LABEL), {
        ...deps,
        forMs,
    });
}

export async function snapshotOnce(
    deps: SnapshotDeps,
    options: { final?: boolean } = {},
): Promise<boolean> {
    const { home, run } = deps.paths;
    if (!existsSync(join(home, "dorothy/restored"))) {
        deps.log("not restored yet; nothing to snapshot");
        return false;
    }
    const final = options.final === true;
    const finalDeadline = final ? deps.now() + FINAL_BUDGET_MS : null;
    return withLock(
        join(run, "snapshot.lock"),
        async () => {
            recordStatus(deps, { lastAttemptAt: iso(deps.now()) });
            try {
                if (!final) await fallbackApply(deps);
                const dir = await takeBackup(deps, finalDeadline);
                const redactor = new Redactor(
                    collectSecrets([
                        ...Object.entries(deps.env),
                        ...parseDotenv(readText(join(home, ".env"))),
                    ]),
                );
                let sql: string;
                let jobs: BundleFile | null;
                try {
                    const manifest = JSON.parse(
                        readFileSync(join(dir, "manifest.json"), "utf8"),
                    ) as {
                        failed_dbs?: string[];
                    };
                    if (manifest.failed_dbs?.includes("state.db")) {
                        throw new Error(
                            "hermes backup could not copy state.db",
                        );
                    }
                    checkTables(join(dir, "state.db"));
                    sql = dumpDatabase(join(dir, "state.db"), {
                        mapText: (value) => redactor.text(value),
                        mapBlob: (value) => redactor.bytes(value),
                    });
                    jobs = collectFile(dir, "cron/jobs.json");
                } finally {
                    await deps.hermes.deleteSnapshot(dir);
                }
                const files: BundleFile[] = [
                    {
                        path: "sessions/state.sql",
                        mode: 0o644,
                        encoding: "utf8",
                        content: sql,
                    },
                    ...[...(jobs ? [jobs] : []), ...userFiles(home)].map(
                        (file) => redactFile(file, redactor),
                    ),
                ];
                const { generation } = readTrustedBundle(deps.paths.restore);
                writeBundle(deps.paths.outbox, {
                    version: 1,
                    createdAt: iso(deps.now()),
                    generation,
                    seed: false,
                    files,
                });
                recordStatus(deps, {
                    lastSuccessAt: iso(deps.now()),
                    lastError: undefined,
                });
                deps.log(`wrote a bundle of ${files.length} files`);
                return true;
            } catch (error) {
                recordStatus(deps, { lastError: errorMessage(error) });
                throw error;
            }
        },
        { waitMs: final ? FINAL_BUDGET_MS / 2 : 600_000 },
    );
}

/**
 * The dorothy-snapshot service. Until plan 3 adds dorothy-webhook, the boot
 * check runs here.
 */
export async function serve(
    deps: SnapshotDeps,
    signal: AbortSignal,
): Promise<void> {
    await withLock(join(deps.paths.run, "apply.lock"), async () => {
        try {
            await bootCheck(applyDeps(deps));
        } catch (error) {
            deps.log(`boot check failed: ${errorMessage(error)}`);
        }
    });
    const intervalMs = syncInterval(deps.env) * 1000;
    while (!signal.aborted) {
        try {
            await delay(intervalMs, undefined, { signal });
        } catch {
            return;
        }
        try {
            await snapshotOnce(deps);
        } catch (error) {
            deps.log(`snapshot failed: ${errorMessage(error)}`);
        }
    }
}

if (import.meta.main) {
    const log = logger("dorothy-snapshot");
    const controller = new AbortController();
    process.once("SIGTERM", () => controller.abort());
    const deps: SnapshotDeps = {
        ...realClock,
        // A stop ends waits at once, so the gateway test gives up the locks
        // before the final snapshot needs them.
        sleep: (ms) =>
            delay(ms, undefined, { signal: controller.signal }).catch(
                () => undefined,
            ),
        env: process.env,
        paths: IMAGE_CONTAINER_PATHS,
        hermes: createHermesCli(undefined, controller.signal),
        log,
        signal: controller.signal,
    };
    const args = process.argv.slice(2);
    const work =
        args.includes("--once") || args.includes("--final")
            ? snapshotOnce(deps, { final: args.includes("--final") }).then(
                  () => undefined,
              )
            : serve(deps, controller.signal);
    work.catch((error: unknown) => {
        log(`failed: ${errorMessage(error)}`);
        process.exitCode = 1;
    });
}
