import { existsSync } from "node:fs";
import { join } from "node:path";
import {
    type ContainerPaths,
    createHermesCli,
    type HermesCli,
    IMAGE_CONTAINER_PATHS,
} from "./hermes.ts";
import { type Env, syncInterval } from "./settings.ts";
import {
    type ApplyStatus,
    readJson,
    readText,
    type SnapshotStatus,
    type SyncStatus,
} from "./status.ts";

export interface HealthDeps {
    env: Env;
    paths: ContainerPaths;
    hermes: HermesCli;
    now(): number;
}

/** Status files here are agent-writable: an operational signal, not a control (S13). */
function readSafe<T>(path: string): T | null {
    try {
        return readJson<T>(path);
    } catch {
        return null;
    }
}

export async function hermesHealth(deps: HealthDeps): Promise<string[]> {
    const { home, run } = deps.paths;
    const age = (time: string | undefined): number =>
        time ? deps.now() - Date.parse(time) : Number.POSITIVE_INFINITY;
    const limit = 3 * syncInterval(deps.env) * 1000;
    const uptime = age(readText(join(run, "booted")).trim() || undefined);
    const problems: string[] = [];
    if (!existsSync(join(home, "dorothy/restored")))
        problems.push("not restored yet");
    const snapshot = readSafe<SnapshotStatus>(
        join(home, "dorothy/status/snapshot.json"),
    );
    if (age(snapshot?.lastSuccessAt) > limit && uptime > limit) {
        problems.push("no successful snapshot in three intervals");
    }
    if (
        readSafe<ApplyStatus>(join(home, "dorothy/status/apply.json"))
            ?.configRolledBack
    ) {
        problems.push("a config push was rolled back");
    }
    if (!(await deps.hermes.gatewayStatus())?.up)
        problems.push("the gateway is down");
    const sync = readSafe<SyncStatus>(deps.paths.syncStatus);
    if (sync === null) {
        problems.push("no sidecar status");
    } else {
        if (sync.pushRejected) problems.push("the sidecar's push was rejected");
        if (sync.sizeWarning) problems.push("a synced file is over 80 MB");
        if (age(sync.lastSuccessAt) > limit && age(sync.startedAt) > limit) {
            problems.push("no successful publish in three intervals");
        }
    }
    return problems;
}

if (import.meta.main) {
    hermesHealth({
        env: process.env,
        paths: IMAGE_CONTAINER_PATHS,
        hermes: createHermesCli(),
        now: Date.now,
    }).then(
        (problems) => {
            if (problems.length > 0) {
                console.error(problems.join("; "));
                process.exitCode = 1;
            }
        },
        (error: unknown) => {
            console.error(String(error));
            process.exitCode = 1;
        },
    );
}
