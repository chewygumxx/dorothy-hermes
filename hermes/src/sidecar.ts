// vim:set expandtab shiftwidth=4 filetype=typescript:
// SPDX-License-Identifier: GPL-3.0-only

//
//
// ~chewygumxx/dorothy-hermes.git
// ::: :/hermes/src/sidecar.ts
//
//

import { randomBytes } from "node:crypto";
import { existsSync, readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import {
    type Bundle,
    type BundleFile,
    fileBytes,
    openBundle,
    validateBundle,
    validPath,
} from "./bundle.ts";
import {
    collectFile,
    collectTree,
    removeUnlisted,
    writeTreeFile,
} from "./files.ts";
import { Git } from "./git.ts";
import { type SidecarSettings, sidecarSettings } from "./settings.ts";
import { type SyncStatus, writeFileAtomic, writeJson } from "./status.ts";
import {
    type Clock,
    errorMessage,
    iso,
    type Log,
    logger,
    realClock,
    retry,
} from "./util.ts";

export interface SidecarPaths {
    checkout: string;
    generation: string;
    consumed: string;
    restore: string;
    status: string;
    outbox: string;
    key: string;
    knownHosts: string;
}

export function sidecarPaths(
    root = "/var/lib/dorothy",
    keyDir = "/tmp/dorothy",
): SidecarPaths {
    return {
        checkout: join(root, "state/memory"),
        generation: join(root, "state/generation"),
        consumed: join(root, "state/consumed"),
        restore: join(root, "restore/restore.json"),
        status: join(root, "restore/status.json"),
        outbox: join(root, "outbox/bundle.json"),
        key: join(keyDir, "memory.key"),
        knownHosts: "/opt/dorothy/known_hosts",
    };
}

export const SIZE_LIMITS = {
    warnBytes: 80 * 1024 * 1024,
    failBytes: 95 * 1024 * 1024,
};
export const PUBLISH_EVERY_MS = 30_000;

export interface SidecarDeps extends Clock {
    settings: SidecarSettings;
    paths: SidecarPaths;
    log: Log;
    gitEnv?: NodeJS.ProcessEnv;
    retryForMs?: number;
    limits?: typeof SIZE_LIMITS;
}

const AREAS: [string, string][] = [
    ["sessions/", "sessions"],
    ["memories/", "memories"],
    ["skills/", "skills"],
    ["cron/", "scheduled jobs"],
];

export function commitMessage(host: string, changed: string[]): string {
    const areas = AREAS.filter(([prefix]) =>
        changed.some((path) => path.startsWith(prefix)),
    ).map(([, name]) => name);
    return `chore(sync): Snapshot from ${host}\n\nChanged: ${areas.join(", ")}.`;
}

/** Makes the checkout's synced trees match the bundle exactly. */
export function mirror(root: string, files: BundleFile[]): void {
    const listed = new Set(files.map((file) => file.path));
    for (const top of ["memories", "skills", "cron"])
        removeUnlisted(root, top, listed);
    for (const file of files) writeTreeFile(root, file);
}

function readTrimmed(path: string): string | null {
    try {
        return readFileSync(path, "utf8").trim() || null;
    } catch {
        return null;
    }
}

export class Sidecar {
    readonly status: SyncStatus;
    readonly #deps: SidecarDeps;
    readonly #git: Git;
    #generation = "";
    #consumed: string | null = null;
    #ignoredHash: string | null = null;
    #pushRejected = false;
    #nextPushAt = 0;
    #pushDelayMs = PUBLISH_EVERY_MS;

    constructor(deps: SidecarDeps) {
        this.#deps = deps;
        this.#git = new Git(deps.paths.checkout, {
            keyPath: deps.paths.key,
            knownHostsPath: deps.paths.knownHosts,
            env: deps.gitEnv,
        });
        this.status = {
            startedAt: iso(deps.now()),
            pendingCommits: 0,
            pushRejected: false,
            largestFileBytes: 0,
            sizeWarning: false,
        };
        this.#save();
    }

    get generation(): string {
        return this.#generation;
    }

    async start(): Promise<void> {
        const { paths, settings, log } = this.#deps;
        writeFileAtomic(paths.key, settings.memoryKey, 0o600);
        rmSync(join(paths.checkout, ".git/index.lock"), { force: true });
        // The generation is minted only once a clone completes, so a checkout
        // without one is an interrupted clone: serving it would offer hermes
        // an empty seed while dorothy-memory holds history.
        const generation = readTrimmed(paths.generation);
        if (generation !== null && existsSync(join(paths.checkout, ".git"))) {
            // A crash mid-mirror leaves a half-written tree that restore.json
            // must not serve. Nothing is lost: consumed is recorded only after
            // the commit, so the outbox bundle is mirrored again.
            if ((await this.#git.head()) !== null)
                await this.#git.resetHard("HEAD");
            await this.#git.clean();
            await this.#git.setRemote(settings.memoryRepo);
            this.#generation = generation;
            this.#consumed = readTrimmed(paths.consumed);
            try {
                await this.#git.fetch();
                await this.#fastForward();
            } catch (error) {
                log(
                    `GitHub unreachable, continuing from the local head: ${errorMessage(error)}`,
                );
            }
        } else {
            await retry(
                "clone dorothy-memory",
                async () => {
                    rmSync(paths.checkout, { recursive: true, force: true });
                    await this.#git.clone(settings.memoryRepo);
                },
                { ...this.#deps, forMs: this.#deps.retryForMs ?? 300_000 },
            );
            this.#mint();
            this.#consumed = null;
            rmSync(paths.consumed, { force: true });
        }
        await this.#writeRestore();
        this.status.restoreWrittenAt = iso(this.#deps.now());
        this.#save();
        log(`ready with generation ${this.#generation}`);
    }

    /** One publish attempt and one push attempt; never throws. */
    async cycle(): Promise<void> {
        this.status.loopAt = iso(this.#deps.now());
        this.#save();
        // Separate attempts: a refused bundle must not hold back earlier commits.
        const errors: string[] = [];
        for (const [step, attempt] of [
            ["publish", () => this.#publish()],
            ["push", () => this.#pushIfDue()],
        ] as const) {
            try {
                await attempt();
            } catch (error) {
                errors.push(`${step} failed: ${errorMessage(error)}`);
            }
        }
        const failed = errors.length > 0;
        if (failed) {
            const lastError = errors.join("; ");
            // A refused bundle is read again every cycle; log it once.
            if (lastError !== this.status.lastError) this.#deps.log(lastError);
            this.status.lastError = lastError;
        }
        try {
            this.status.pendingCommits = await this.#git.unpushed();
        } catch {}
        this.status.pushRejected = this.#pushRejected;
        if (!failed && this.status.pendingCommits === 0) {
            this.status.lastSuccessAt = iso(this.#deps.now());
            delete this.status.lastError;
        }
        this.#save();
    }

    #mint(): string {
        this.#generation = randomBytes(16).toString("hex");
        writeFileAtomic(this.#deps.paths.generation, this.#generation);
        return this.#generation;
    }

    #save(): void {
        writeJson(this.#deps.paths.status, this.status);
    }

    async #fastForward(): Promise<void> {
        const head = await this.#git.head();
        const remote = await this.#git.remoteHead();
        if (remote === null || head === remote) return;
        if (head === null || (await this.#git.isAncestor(head, remote))) {
            await this.#git.resetHard(remote);
            this.#deps.log(`fast-forwarded to ${remote}`);
            return;
        }
        if (await this.#git.isAncestor(remote, head)) return;
        this.#pushRejected = true;
        this.#deps.log(
            "local and remote histories have diverged; pushing stops until a person resolves it",
        );
    }

    async #writeRestore(): Promise<void> {
        const { paths } = this.#deps;
        const head = await this.#git.head();
        const base = {
            version: 1 as const,
            createdAt: iso(this.#deps.now()),
            generation: this.#generation,
        };
        if (head === null) {
            writeJson(paths.restore, { ...base, seed: true, files: [] });
            return;
        }
        const state = collectFile(paths.checkout, "sessions/state.sql");
        if (!state)
            throw new Error(`dorothy-memory ${head} has no sessions/state.sql`);
        const jobs = collectFile(paths.checkout, "cron/jobs.json");
        const files = [
            state,
            ...(jobs ? [jobs] : []),
            ...collectTree(paths.checkout, "memories"),
            ...collectTree(paths.checkout, "skills"),
        ].filter((file) => validPath(file.path));
        const bundle: Bundle = {
            ...base,
            memorySha: head,
            ...(this.#consumed ? { bundleHash: this.#consumed } : {}),
            seed: false,
            files,
        };
        writeJson(paths.restore, validateBundle(bundle));
    }

    #guardEmpty(bundle: Bundle): void {
        if (this.#deps.settings.allowEmpty) return;
        for (const required of ["sessions/state.sql", "memories/MEMORY.md"]) {
            const present = existsSync(
                join(this.#deps.paths.checkout, required),
            );
            if (
                present &&
                !bundle.files.some((file) => file.path === required)
            ) {
                throw new Error(
                    `refusing a bundle without ${required} (DOROTHY_ALLOW_EMPTY=1 allows it)`,
                );
            }
        }
    }

    async #publish(): Promise<void> {
        const { paths, settings, log } = this.#deps;
        const opened = openBundle(paths.outbox, settings.bundleMaxBytes);
        if (opened === null || opened.hash === this.#consumed) return;
        const { bundle, hash } = opened;
        if (bundle.generation !== this.#generation) {
            if (this.#ignoredHash !== hash)
                log(`ignoring a bundle from generation ${bundle.generation}`);
            this.#ignoredHash = hash;
            return;
        }
        if (bundle.seed) throw new Error("the outbox holds a seed bundle");
        const limits = this.#deps.limits ?? SIZE_LIMITS;
        const largest = Math.max(
            0,
            ...bundle.files.map((file) => fileBytes(file).length),
        );
        if (largest > limits.failBytes) {
            throw new Error(
                `a ${largest}-byte file exceeds the ${limits.failBytes}-byte limit`,
            );
        }
        this.status.largestFileBytes = largest;
        this.status.sizeWarning = largest > limits.warnBytes;
        try {
            await this.#git.fetch();
            if ((await this.#git.unpushed()) === 0) await this.#fastForward();
        } catch (error) {
            log(`fetch failed; committing locally: ${errorMessage(error)}`);
        }
        // After the fast-forward, so files only the remote head has are guarded.
        this.#guardEmpty(bundle);
        mirror(paths.checkout, bundle.files);
        await this.#git.addAll();
        const changed = await this.#git.stagedPaths();
        if (changed.length > 0) {
            await this.#git.commit(commitMessage(settings.host, changed));
            log(`committed ${changed.length} changed file(s)`);
        }
        this.#consumed = hash;
        writeFileAtomic(paths.consumed, hash);
        this.status.lastBundleAt = bundle.createdAt;
        await this.#writeRestore();
        this.#nextPushAt = 0;
    }

    async #pushIfDue(): Promise<void> {
        if (this.#pushRejected) return;
        if ((await this.#git.unpushed()) === 0) {
            this.#pushDelayMs = PUBLISH_EVERY_MS;
            return;
        }
        if (this.#deps.now() < this.#nextPushAt) return;
        const result = await this.#git.push();
        if (result === "pushed") {
            this.#pushDelayMs = PUBLISH_EVERY_MS;
            this.#nextPushAt = 0;
            this.#deps.log("pushed");
            return;
        }
        if (result === "rejected") {
            this.#pushRejected = true;
            this.#deps.log(
                "push rejected: the remote moved while commits were unpushed; pushing stops until a person resolves it",
            );
            return;
        }
        this.#nextPushAt = this.#deps.now() + this.#pushDelayMs;
        this.#pushDelayMs = Math.min(
            this.#pushDelayMs * 2,
            this.#deps.settings.interval * 1000,
        );
        throw new Error("push failed; the commit stays local and is retried");
    }
}

export async function runSidecar(
    deps: SidecarDeps,
    signal: AbortSignal,
): Promise<void> {
    const sidecar = new Sidecar(deps);
    await sidecar.start();
    while (!signal.aborted) {
        await sidecar.cycle();
        await delay(PUBLISH_EVERY_MS, undefined, { signal }).catch(
            () => undefined,
        );
    }
    deps.log("stopping: publishing once more");
    await sidecar.cycle();
}

if (import.meta.main) {
    const log = logger("dorothy-sync");
    const controller = new AbortController();
    process.once("SIGTERM", () => controller.abort());
    process.once("SIGINT", () => controller.abort());
    try {
        const deps: SidecarDeps = {
            ...realClock,
            settings: sidecarSettings(process.env),
            paths: sidecarPaths(),
            log,
        };
        runSidecar(deps, controller.signal)
            .then(() => process.exit(0))
            .catch((error: unknown) => {
                log(`failed: ${errorMessage(error)}`);
                process.exit(1);
            });
    } catch (error) {
        log(`failed: ${errorMessage(error)}`);
        process.exit(1);
    }
}
