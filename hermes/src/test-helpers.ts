// vim:set expandtab shiftwidth=4 filetype=typescript:
// SPDX-License-Identifier: GPL-3.0-only

//
//
// ~chewygumxx/dorothy-hermes.git
// ::: :/hermes/src/test-helpers.ts
//
//

import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import type { TestContext } from "node:test";
import type { GatewayStatus, HermesCli } from "./hermes.ts";
import type { Clock } from "./util.ts";

export function tempDir(t: TestContext): string {
    const dir = mkdtempSync(join(tmpdir(), "dorothy-test-"));
    t.after(() => rmSync(dir, { recursive: true, force: true }));
    return dir;
}

/** A clock whose sleep advances time instantly. */
export function fakeClock(start = 1_800_000_000_000): Clock {
    let t = start;
    return {
        now: () => t,
        sleep: async (ms) => {
            t += ms;
        },
    };
}

export function writeFiles(root: string, files: Record<string, string>): void {
    for (const [path, content] of Object.entries(files)) {
        mkdirSync(dirname(join(root, path)), { recursive: true });
        writeFileSync(join(root, path), content);
    }
}

export const GIT_ENV: NodeJS.ProcessEnv = {
    ...process.env,
    GIT_CONFIG_GLOBAL: "/dev/null",
    GIT_CONFIG_NOSYSTEM: "1",
};

const AS_TEST = [
    "-c",
    "user.name=Test",
    "-c",
    "user.email=test@example.invalid",
    "-c",
    "commit.gpgsign=false",
];

export function git(args: string[], cwd: string): string {
    return execFileSync("/usr/bin/git", [...AS_TEST, ...args], {
        cwd,
        env: GIT_ENV,
        encoding: "utf8",
    });
}

export function bareRepo(t: TestContext): string {
    const path = join(tempDir(t), "remote.git");
    git(["init", "--bare", "--quiet", "--initial-branch=main", path], tmpdir());
    return `file://${path}`;
}

/**
 * Commits files on main from a separate clone and pushes, as a person would;
 * a null content deletes that file.
 */
export function pushFiles(
    t: TestContext,
    url: string,
    files: Record<string, string | null>,
    message = "human edit",
): string {
    const work = join(tempDir(t), "work");
    git(["clone", "--quiet", url, work], tmpdir());
    git(["symbolic-ref", "HEAD", "refs/heads/main"], work);
    const written: Record<string, string> = {};
    for (const [path, content] of Object.entries(files)) {
        if (content === null) rmSync(join(work, path), { force: true });
        else written[path] = content;
    }
    writeFiles(work, written);
    git(["add", "--all"], work);
    git(["commit", "--quiet", "-m", message], work);
    git(["push", "--quiet", "origin", "HEAD:refs/heads/main"], work);
    return git(["rev-parse", "HEAD"], work).trim();
}

export function remoteMain(url: string): string | null {
    try {
        return git(
            [
                "--git-dir",
                url.slice("file://".length),
                "rev-parse",
                "--verify",
                "--quiet",
                "main",
            ],
            tmpdir(),
        ).trim();
    } catch {
        return null;
    }
}

export function remoteShow(url: string, path: string): string | null {
    try {
        return git(
            ["--git-dir", url.slice("file://".length), "show", `main:${path}`],
            tmpdir(),
        );
    } catch {
        return null;
    }
}

export interface FakeHermesOptions {
    status?(): GatewayStatus | null;
    snapshot?(label: string): Promise<string>;
    restart?(): void;
    start?(): void;
}

export interface FakeHermes extends HermesCli {
    calls: string[];
}

export function fakeHermes(options: FakeHermesOptions = {}): FakeHermes {
    const calls: string[] = [];
    return {
        calls,
        async snapshot(label) {
            calls.push(`snapshot ${label}`);
            if (!options.snapshot) throw new Error("no fake snapshot");
            return options.snapshot(label);
        },
        async deleteSnapshot(dir) {
            calls.push("deleteSnapshot");
            rmSync(dir, { recursive: true, force: true });
        },
        async restartGateway() {
            calls.push("restart");
            options.restart?.();
        },
        async startGateway() {
            calls.push("start");
            options.start?.();
        },
        async gatewayStatus() {
            return options.status ? options.status() : { up: true, pid: 100 };
        },
        async optimizeStorage() {
            calls.push("optimize");
            return "";
        },
    };
}
