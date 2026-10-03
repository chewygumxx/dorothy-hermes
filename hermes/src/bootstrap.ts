import { existsSync, renameSync, rmSync } from "node:fs";
import { join } from "node:path";
import {
    type Bundle,
    BundleError,
    type BundleFile,
    fileBytes,
    type OpenedBundle,
    openBundle,
    readTrustedBundle,
} from "./bundle.ts";
import {
    configGit,
    configPaths,
    copyConfig,
    hasLastGood,
    skillsWarning,
} from "./config.ts";
import { restoreDatabase } from "./dump.ts";
import {
    emptyDirectory,
    removeUnlisted,
    skillDirectory,
    writeTreeFile,
} from "./files.ts";
import type { Git } from "./git.ts";
import {
    type ContainerPaths,
    createHermesCli,
    type HermesCli,
    IMAGE_CONTAINER_PATHS,
} from "./hermes.ts";
import { dotenvSpans } from "./redact.ts";
import {
    allowlistNames,
    type Env,
    hermesSettings,
    loadRegistry,
    type PlatformRegistry,
} from "./settings.ts";
import {
    type ApplyStatus,
    readJson,
    readText,
    writeFileAtomic,
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

export interface BootstrapDeps extends Clock {
    env: Env;
    registry: PlatformRegistry;
    paths: ContainerPaths;
    hermes: HermesCli;
    log: Log;
    gitEnv?: NodeJS.ProcessEnv;
    retryForMs?: number;
    outboxWaitMs?: number;
}

/**
 * Upstream loads .env over the process environment, so anything the
 * deployment provides, and every allowlist, must not survive there (S6).
 * Entries are read with upstream's grammar and dropped whole, multi-line
 * values included; a line upstream cannot parse is dropped too.
 */
export function cleanDotenv(
    path: string,
    env: Env,
    allowlists: string[],
): string[] {
    const text = readText(path);
    if (text === "") return [];
    const drop = new Set(allowlists);
    const removed: string[] = [];
    const kept = dotenvSpans(text).filter((span) => {
        if (span.invalid) {
            removed.push("an unparsable line");
            return false;
        }
        const name = span.name;
        if (
            name === undefined ||
            (!drop.has(name) && !(env[name] ?? "").trim())
        )
            return true;
        removed.push(name);
        return false;
    });
    if (removed.length > 0) {
        writeFileAtomic(path, kept.map((span) => span.text).join(""), 0o600);
    }
    return removed;
}

/** Memories are replaced wholesale; each restored skill directory is replaced. */
export function writeRestoredFiles(home: string, files: BundleFile[]): void {
    const listed = files.filter((file) => file.path !== "sessions/state.sql");
    removeUnlisted(home, "memories", new Set(listed.map((file) => file.path)));
    const skills = new Set<string>();
    for (const file of listed) {
        const dir = file.path.startsWith("skills/")
            ? skillDirectory(file.path)
            : null;
        if (dir) skills.add(dir);
    }
    for (const dir of skills)
        rmSync(join(home, dir), { recursive: true, force: true });
    for (const file of listed) writeTreeFile(home, file);
}

async function syncCheckout(
    git: Git,
    url: string,
    deps: BootstrapDeps,
): Promise<void> {
    if (existsSync(join(git.dir, ".git"))) {
        await git.setRemote(url);
        try {
            await git.fetch();
        } catch (error) {
            deps.log(
                `GitHub unreachable, using the existing config checkout: ${errorMessage(error)}`,
            );
            return;
        }
    } else {
        await retry(
            "clone dorothy-config",
            async () => {
                rmSync(git.dir, { recursive: true, force: true });
                await git.clone(url);
            },
            { ...deps, forMs: deps.retryForMs ?? 300_000 },
        );
    }
    const remote = await git.remoteHead();
    if (remote === null) throw new Error("dorothy-config has no main branch");
    await git.resetHard(remote);
}

/** Waits until the sidecar has consumed the outbox, so at most nothing is lost. */
async function awaitConsumedOutbox(deps: BootstrapDeps): Promise<Bundle> {
    const deadline = deps.now() + (deps.outboxWaitMs ?? 120_000);
    for (;;) {
        const restore = readTrustedBundle(deps.paths.restore);
        let outbox: OpenedBundle | null = null;
        try {
            outbox = openBundle(deps.paths.outbox, Number.MAX_SAFE_INTEGER);
        } catch (error) {
            if (!(error instanceof BundleError)) throw error;
            deps.log(`ignoring an invalid outbox bundle: ${error.message}`);
        }
        if (
            outbox === null ||
            outbox.bundle.generation !== restore.generation ||
            outbox.hash === restore.bundleHash
        ) {
            return restore;
        }
        if (deps.now() >= deadline) {
            deps.log(
                "the sidecar has not consumed the outbox after two minutes; restoring without it",
            );
            return restore;
        }
        await deps.sleep(2_000);
    }
}

async function restore(deps: BootstrapDeps): Promise<void> {
    const home = deps.paths.home;
    const marker = join(home, "dorothy/restored");
    if (existsSync(marker)) {
        deps.log("warm boot: the volume's state wins");
        return;
    }
    const snapshot = await awaitConsumedOutbox(deps);
    if (snapshot.seed) {
        deps.log("first deployment: keeping Hermes's fresh state");
    } else {
        const sql = snapshot.files.find(
            (file) => file.path === "sessions/state.sql",
        );
        if (!sql) throw new Error("restore.json has no sessions/state.sql");
        for (const suffix of ["-wal", "-shm", "-journal"])
            rmSync(join(home, `state.db${suffix}`), { force: true });
        const temp = join(home, "state.db.dorothy-restore");
        rmSync(temp, { force: true });
        rmSync(`${temp}-journal`, { force: true });
        restoreDatabase(fileBytes(sql).toString("utf8"), temp);
        renameSync(temp, join(home, "state.db"));
        writeRestoredFiles(home, snapshot.files);
        const optimized = (await deps.hermes.optimizeStorage()).trim();
        if (optimized) deps.log(`optimize-storage: ${optimized}`);
        // Wording recorded by the Task 1 probe; a skip leaves CJK search unindexed.
        if (/not enough free disk|nothing to do/i.test(optimized)) {
            deps.log(
                "optimize-storage skipped its work; CJK search may miss restored sessions",
            );
        }
        deps.log(`restored dorothy-memory ${snapshot.memorySha}`);
    }
    writeJson(marker, {
        memorySha: snapshot.memorySha ?? null,
        generation: snapshot.generation,
        restoredAt: iso(deps.now()),
    });
}

export async function bootstrap(deps: BootstrapDeps): Promise<void> {
    const { home, run } = deps.paths;
    writeFileAtomic(join(run, "booted"), iso(deps.now()));
    const settings = hermesSettings(deps.env, deps.registry);
    const removed = cleanDotenv(
        join(home, ".env"),
        deps.env,
        allowlistNames(deps.registry),
    );
    if (removed.length > 0)
        deps.log(`removed from .env: ${removed.join(", ")}`);
    emptyDirectory(join(home, "pairing"));
    emptyDirectory(join(home, "platforms/pairing"));
    writeFileAtomic(join(run, "config.key"), settings.configKey, 0o600);
    const git = configGit(deps.paths, deps.gitEnv);
    await syncCheckout(git, settings.configRepo, deps);
    const head = await git.head();
    const paths = configPaths(home);
    const status = readJson<ApplyStatus>(paths.applyStatus) ?? {};
    if (head !== null && head === status.rolledBackSha) {
        deps.log(`keeping the last-good config: ${head} was rolled back`);
    } else {
        try {
            copyConfig(paths.checkout, home);
            deps.log(`config ${head}`);
        } catch (error) {
            // A broken config never takes the agent offline when a last-good copy exists.
            if (!hasLastGood(paths)) throw error;
            copyConfig(paths.lastGood, home);
            const lastError = `config ${head} not applied: ${errorMessage(error)}`;
            writeJson(paths.applyStatus, {
                ...status,
                ...(head === null ? {} : { rolledBackSha: head }),
                configRolledBack: true,
                lastApplyAt: iso(deps.now()),
                lastError,
            });
            deps.log(`${lastError}; booting the last-good config`);
        }
    }
    const warning = skillsWarning(readText(join(home, "config.yaml")));
    if (warning) deps.log(warning);
    await restore(deps);
}

if (import.meta.main) {
    const log = logger("dorothy-bootstrap");
    bootstrap({
        ...realClock,
        env: process.env,
        registry: loadRegistry(),
        paths: IMAGE_CONTAINER_PATHS,
        hermes: createHermesCli(),
        log,
    })
        .then(() => log("done"))
        .catch((error: unknown) => {
            log(`failed: ${errorMessage(error)}`);
            process.exitCode = 1;
        });
}
