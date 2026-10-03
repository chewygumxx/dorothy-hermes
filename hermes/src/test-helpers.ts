import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import type { TestContext } from "node:test";
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
