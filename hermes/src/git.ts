import { execFile } from "node:child_process";
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";

export const GIT = "/usr/bin/git";

export class GitError extends Error {
    readonly output: string;
    readonly exitCode: number | null;

    constructor(message: string, output: string, exitCode: number | null) {
        super(message);
        this.output = output;
        this.exitCode = exitCode;
    }
}

export interface GitOptions {
    keyPath?: string;
    knownHostsPath?: string;
    /** Base environment; defaults to process.env. */
    env?: NodeJS.ProcessEnv;
    /**
     * None by default: a clone of a long history may take as long as it
     * takes, and a stalled connection is cut by ssh's keepalives instead.
     */
    timeoutMs?: number;
    /** Aborting sends SIGTERM to the running git, as the service stops. */
    signal?: AbortSignal;
}

export type PushResult = "pushed" | "rejected" | "failed";

const REJECTED =
    /\[rejected\]|\[remote rejected\]|non-fast-forward|fetch first/;
const DOROTHY = [
    "-c",
    "user.name=Dorothy",
    "-c",
    "user.email=noreply@dorothy.invalid",
    "-c",
    "commit.gpgsign=false",
];

export function sshCommand(keyPath: string, knownHostsPath: string): string {
    return (
        `/usr/bin/ssh -F none -i ${keyPath} -o IdentitiesOnly=yes ` +
        `-o UserKnownHostsFile=${knownHostsPath} -o StrictHostKeyChecking=yes ` +
        "-o ConnectTimeout=30 -o ServerAliveInterval=15 -o ServerAliveCountMax=4"
    );
}

function verb(args: string[]): string {
    return (
        args.find((arg, i) => !arg.startsWith("-") && args[i - 1] !== "-c") ??
        "command"
    );
}

export class Git {
    readonly dir: string;
    readonly #options: GitOptions;

    constructor(dir: string, options: GitOptions = {}) {
        this.dir = dir;
        this.#options = options;
    }

    run(args: string[], cwd = this.dir): Promise<string> {
        const env: NodeJS.ProcessEnv = {
            ...(this.#options.env ?? process.env),
            GIT_TERMINAL_PROMPT: "0",
            LC_ALL: "C",
        };
        if (this.#options.keyPath) {
            env.GIT_SSH_COMMAND = sshCommand(
                this.#options.keyPath,
                this.#options.knownHostsPath ?? "/opt/dorothy/known_hosts",
            );
        }
        const options = {
            cwd,
            env,
            maxBuffer: 256 * 1024 * 1024,
            timeout: this.#options.timeoutMs ?? 0,
            signal: this.#options.signal,
        };
        return new Promise((resolve, reject) => {
            execFile(GIT, args, options, (error, stdout, stderr) => {
                if (!error) {
                    resolve(stdout);
                    return;
                }
                const code = typeof error.code === "number" ? error.code : null;
                const detail = stderr.trim() || error.message;
                reject(
                    new GitError(
                        `git ${verb(args)} failed: ${detail}`,
                        `${stdout}${stderr}`,
                        code,
                    ),
                );
            });
        });
    }

    async clone(url: string): Promise<void> {
        mkdirSync(dirname(this.dir), { recursive: true });
        await this.run(
            ["clone", "--quiet", "--origin", "origin", "--", url, this.dir],
            dirname(this.dir),
        );
        if ((await this.head()) === null)
            await this.run(["symbolic-ref", "HEAD", "refs/heads/main"]);
    }

    head(): Promise<string | null> {
        return this.#verify("HEAD");
    }

    remoteHead(): Promise<string | null> {
        return this.#verify("refs/remotes/origin/main");
    }

    async #verify(ref: string): Promise<string | null> {
        try {
            return (
                await this.run([
                    "rev-parse",
                    "--verify",
                    "--quiet",
                    `${ref}^{commit}`,
                ])
            ).trim();
        } catch (error) {
            if (error instanceof GitError && error.exitCode === 1) return null;
            throw error;
        }
    }

    async fetch(): Promise<void> {
        await this.run(["fetch", "--quiet", "--prune", "origin"]);
    }

    async isAncestor(ancestor: string, descendant: string): Promise<boolean> {
        try {
            await this.run([
                "merge-base",
                "--is-ancestor",
                ancestor,
                descendant,
            ]);
            return true;
        } catch (error) {
            if (error instanceof GitError && error.exitCode === 1) return false;
            throw error;
        }
    }

    async resetHard(ref: string): Promise<void> {
        await this.run(["reset", "--hard", "--quiet", ref]);
    }

    /** Commits on HEAD that origin/main lacks. */
    async unpushed(): Promise<number> {
        if ((await this.head()) === null) return 0;
        const remote = await this.remoteHead();
        const out = await this.run([
            "rev-list",
            "--count",
            remote ? `${remote}..HEAD` : "HEAD",
        ]);
        return Number(out.trim());
    }

    async addAll(): Promise<void> {
        await this.run(["add", "--all"]);
    }

    /** Removes every untracked file, ignored ones included. */
    async clean(): Promise<void> {
        await this.run(["clean", "-f", "-f", "-d", "-x", "--quiet"]);
    }

    async stagedPaths(): Promise<string[]> {
        const out = await this.run(["diff", "--cached", "--name-only", "-z"]);
        return out.split("\u0000").filter(Boolean);
    }

    async commit(message: string): Promise<void> {
        await this.run([
            ...DOROTHY,
            "commit",
            "--quiet",
            "--no-verify",
            "-m",
            message,
        ]);
    }

    /** Fast-forward only: git refuses a non-fast-forward without --force. */
    async push(): Promise<PushResult> {
        try {
            await this.run([
                "push",
                "--porcelain",
                "origin",
                "HEAD:refs/heads/main",
            ]);
            return "pushed";
        } catch (error) {
            if (!(error instanceof GitError)) throw error;
            return REJECTED.test(error.output) ? "rejected" : "failed";
        }
    }

    async setRemote(url: string): Promise<void> {
        await this.run(["remote", "set-url", "origin", url]);
    }
}
