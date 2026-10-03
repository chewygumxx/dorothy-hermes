// vim:set expandtab shiftwidth=4 filetype=typescript:
// SPDX-License-Identifier: GPL-3.0-only

//
//
// ~chewygumxx/dorothy-hermes.git
// ::: :/hermes/src/hermes.ts
//
//

import { execFile } from "node:child_process";
import { readdirSync, rmSync } from "node:fs";
import { basename, dirname, join } from "node:path";

export interface GatewayStatus {
    up: boolean;
    pid: number | null;
}

export interface HermesCli {
    /** `hermes backup --quick --label <label>`; returns the snapshot directory. */
    snapshot(label: string): Promise<string>;
    deleteSnapshot(dir: string): Promise<void>;
    restartGateway(): Promise<void>;
    startGateway(): Promise<void>;
    /** Null while the gateway-default slot is not registered. */
    gatewayStatus(): Promise<GatewayStatus | null>;
    /** Returns the command's output: it exits 0 even when it skips the work. */
    optimizeStorage(): Promise<string>;
}

export interface CliPaths {
    home: string;
    bin: string;
    svstat: string;
    slot: string;
}

export const IMAGE_CLI_PATHS: CliPaths = {
    home: "/opt/data",
    bin: "/opt/hermes/bin/hermes",
    svstat: "/command/s6-svstat",
    slot: "/run/service/gateway-default",
};

/** Where things live inside the `hermes` container. */
export interface ContainerPaths {
    home: string;
    run: string;
    restore: string;
    syncStatus: string;
    outbox: string;
    knownHosts: string;
}

export const IMAGE_CONTAINER_PATHS: ContainerPaths = {
    home: "/opt/data",
    run: "/run/dorothy",
    restore: "/var/lib/dorothy/restore/restore.json",
    syncStatus: "/var/lib/dorothy/restore/status.json",
    outbox: "/var/lib/dorothy/outbox/bundle.json",
    knownHosts: "/opt/dorothy/known_hosts",
};

export function parseSvstat(output: string): GatewayStatus {
    const [up, pid] = output.trim().split(/\s+/);
    const number = Number(pid);
    return up === "true" && number > 0
        ? { up: true, pid: number }
        : { up: false, pid: null };
}

export function newSnapshot(
    before: Set<string>,
    after: Iterable<string>,
    label: string,
): string {
    const escaped = label.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    const pattern = new RegExp(`-${escaped}(-\\d+)?$`);
    const created = [...after].filter(
        (name) => !before.has(name) && pattern.test(name),
    );
    if (created.length !== 1) {
        throw new Error(
            `expected one new snapshot labelled ${label}, found ${created.length}`,
        );
    }
    return created[0] as string;
}

function run(
    file: string,
    args: string[],
    signal?: AbortSignal,
): Promise<string> {
    return new Promise((resolve, reject) => {
        execFile(
            file,
            args,
            { signal, maxBuffer: 64 * 1024 * 1024 },
            (error, stdout, stderr) => {
                if (error) {
                    reject(
                        new Error(
                            `${basename(file)} ${args.join(" ")} failed: ${stderr.trim() || error.message}`,
                        ),
                    );
                } else {
                    resolve(stdout);
                }
            },
        );
    });
}

export function createHermesCli(
    paths: CliPaths = IMAGE_CLI_PATHS,
    signal?: AbortSignal,
): HermesCli {
    const snapshots = join(paths.home, "state-snapshots");
    const list = (): Set<string> => {
        try {
            return new Set(readdirSync(snapshots));
        } catch {
            return new Set();
        }
    };
    return {
        async snapshot(label) {
            const before = list();
            await run(
                paths.bin,
                ["backup", "--quick", "--label", label],
                signal,
            );
            return join(snapshots, newSnapshot(before, list(), label));
        },
        async deleteSnapshot(dir) {
            if (dirname(dir) !== snapshots)
                throw new Error(`${dir} is not a snapshot`);
            rmSync(dir, { recursive: true, force: true });
        },
        async restartGateway() {
            await run(paths.bin, ["gateway", "restart"], signal);
        },
        async startGateway() {
            await run(paths.bin, ["gateway", "start"], signal);
        },
        async gatewayStatus() {
            try {
                return parseSvstat(
                    await run(paths.svstat, ["-o", "up,pid", paths.slot]),
                );
            } catch {
                return null;
            }
        },
        async optimizeStorage() {
            return run(
                paths.bin,
                ["sessions", "optimize-storage", "--yes"],
                signal,
            );
        },
    };
}
