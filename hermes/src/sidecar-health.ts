import { syncInterval } from "./settings.ts";
import { sidecarPaths } from "./sidecar.ts";
import { readJson, type SyncStatus } from "./status.ts";

/** Healthy once this run has written restore.json and while its loop turns. */
export function sidecarHealth(
    status: SyncStatus | null,
    intervalSeconds: number,
    now: number,
): string[] {
    if (status === null) return ["no status"];
    const started = Date.parse(status.startedAt);
    if (
        !status.restoreWrittenAt ||
        Date.parse(status.restoreWrittenAt) < started
    ) {
        return ["restore.json not written by this run"];
    }
    if (
        !status.loopAt ||
        now - Date.parse(status.loopAt) > intervalSeconds * 1000 + 120_000
    ) {
        return ["the publish loop has stalled"];
    }
    return [];
}

if (import.meta.main) {
    let problems: string[];
    try {
        problems = sidecarHealth(
            readJson<SyncStatus>(sidecarPaths().status),
            syncInterval(process.env),
            Date.now(),
        );
    } catch (error) {
        problems = [String(error)];
    }
    if (problems.length > 0) {
        console.error(problems.join("; "));
        process.exitCode = 1;
    }
}
