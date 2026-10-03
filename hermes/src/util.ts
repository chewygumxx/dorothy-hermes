import { lstatSync, type Stats } from "node:fs";
import { setTimeout as delay } from "node:timers/promises";

export type Log = (message: string) => void;

export interface Clock {
    now(): number;
    sleep(ms: number): Promise<void>;
}

export const realClock: Clock = {
    now: () => Date.now(),
    sleep: (ms) => delay(ms),
};

export function logger(prefix: string): Log {
    return (message) => console.log(`[${prefix}] ${message}`);
}

export function errorMessage(error: unknown): string {
    return error instanceof Error ? error.message : String(error);
}

export function errorCode(error: unknown): string | undefined {
    return (error as NodeJS.ErrnoException | null)?.code;
}

export function iso(ms: number): string {
    return new Date(ms).toISOString();
}

/** `lstat` that answers null for a missing path or a missing parent. */
export function lstatOrNull(path: string): Stats | null {
    try {
        return lstatSync(path);
    } catch (error) {
        const code = errorCode(error);
        if (code === "ENOENT" || code === "ENOTDIR") return null;
        throw error;
    }
}

export interface RetryOptions extends Clock {
    forMs: number;
    log: Log;
}

/** Retries fn with exponential backoff (1 s doubling to 30 s) for forMs. */
export async function retry<T>(
    what: string,
    fn: () => Promise<T>,
    options: RetryOptions,
): Promise<T> {
    const deadline = options.now() + options.forMs;
    let wait = 1_000;
    for (;;) {
        try {
            return await fn();
        } catch (error) {
            if (options.now() + wait > deadline) {
                const seconds = Math.round(options.forMs / 1000);
                throw new Error(
                    `${what} kept failing for ${seconds} s: ${errorMessage(error)}`,
                );
            }
            options.log(
                `${what} failed, retrying in ${wait / 1000} s: ${errorMessage(error)}`,
            );
            await options.sleep(wait);
            wait = Math.min(wait * 2, 30_000);
        }
    }
}
