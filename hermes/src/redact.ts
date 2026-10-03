// vim:set expandtab shiftwidth=4 filetype=typescript:
// SPDX-License-Identifier: GPL-3.0-only

//
//
// ~chewygumxx/dorothy-hermes.git
// ::: :/hermes/src/redact.ts
//
//

/** Variable names whose values are treated as secrets (S5). */
export const SECRET_NAME = /_(TOKEN|KEY|SECRET|PASSWORD)$/;
export const MIN_SECRET_LENGTH = 8;

/** One piece of a `.env` file; joining every span's text gives the file back. */
export interface DotenvSpan {
    text: string;
    name?: string;
    value?: string;
    /** A line python-dotenv skips with a warning. */
    invalid?: boolean;
}

// python-dotenv's grammar (dotenv/parser.py), which upstream loads `.env` with.
// Python's \s is not JavaScript's: it adds \x1c-\x1f and \x85 and lacks
// \ufeff, so whitespace is spelled out. INLINE is \s without \r and \n.
const INLINE =
    "\\t\\v\\f \\x1c-\\x1f\\x85\\xa0\\u1680\\u2000-\\u200a\\u2028\\u2029\\u202f\\u205f\\u3000";
const SPACE = `\\r\\n${INLINE}`;
const BLANK = new RegExp(`[${SPACE}]+`, "y");
const EXPORT = new RegExp(`export[${INLINE}]+`, "y");
const QUOTED_KEY = /'([^']+)'/y;
const KEY = new RegExp(`[^=#${SPACE}]+`, "y");
const GAP = new RegExp(`[${INLINE}]*`, "y");
const EQUALS = new RegExp(`=[${INLINE}]*`, "y");
const SINGLE = /'((?:\\'|[^'])*)'/y;
const DOUBLE = /"((?:\\"|[^"])*)"/y;
const UNQUOTED = /[^\r\n]*/y;
const END = new RegExp(
    `[${INLINE}]*(?:#[^\\r\\n]*)?[${INLINE}]*(?:\\r\\n|\\n|\\r|$)`,
    "y",
);
const COMMENT = new RegExp(`[${SPACE}]+#[^]*`);
const TRAILING = new RegExp(`[${SPACE}]+$`);
const REST = /[^\r\n]*(?:\r|\n|\r\n)?/y;
const ESCAPES: Record<string, string> = {
    "\\": "\\",
    "'": "'",
    '"': '"',
    a: "\u0007",
    b: "\b",
    f: "\f",
    n: "\n",
    r: "\r",
    t: "\t",
    v: "\v",
};

interface Binding {
    name?: string;
    value?: string;
    /** Where reading stopped; on failure, python-dotenv skips the rest of that line. */
    end: number;
    failed: boolean;
}

function binding(source: string, start: number): Binding {
    let index = start;
    const step = (pattern: RegExp): RegExpExecArray | null => {
        pattern.lastIndex = index;
        const match = pattern.exec(source);
        if (match) index += match[0].length;
        return match;
    };
    const failed = (): Binding => {
        step(REST);
        return { end: index, failed: true };
    };
    let name: string | undefined;
    let value: string | undefined;
    step(EXPORT);
    if (source[index] !== "#") {
        const key =
            source[index] === "'" ? step(QUOTED_KEY)?.[1] : step(KEY)?.[0];
        if (key === undefined) return failed();
        name = key;
        step(GAP);
        if (step(EQUALS)) {
            const quote = source[index];
            if (quote === "'" || quote === '"') {
                const match = step(quote === "'" ? SINGLE : DOUBLE);
                if (!match) return failed();
                value = (match[1] ?? "").replace(
                    quote === "'" ? /\\([\\'])/g : /\\([\\'"abfnrtv])/g,
                    (_, escaped: string) => ESCAPES[escaped] ?? escaped,
                );
            } else {
                value = (step(UNQUOTED)?.[0] ?? "")
                    .replace(COMMENT, "")
                    .replace(TRAILING, "");
            }
        }
    }
    if (!step(END)) return failed();
    return { name, value, end: index, failed: false };
}

/** Splits `.env` text exactly as python-dotenv reads it, keeping every byte. */
export function dotenvSpans(source: string): DotenvSpan[] {
    const spans: DotenvSpan[] = [];
    let index = 0;
    while (index < source.length) {
        BLANK.lastIndex = index;
        const blank = BLANK.exec(source);
        if (blank) {
            index += blank[0].length;
            spans.push({ text: blank[0] });
            continue;
        }
        const entry = binding(source, index);
        const text = source.slice(index, entry.end);
        index = entry.end;
        spans.push(
            entry.failed
                ? { text, invalid: true }
                : { text, name: entry.name, value: entry.value },
        );
    }
    return spans;
}

export function parseDotenv(text: string): Map<string, string> {
    const values = new Map<string, string>();
    for (const span of dotenvSpans(text)) {
        if (span.name !== undefined && span.value !== undefined)
            values.set(span.name, span.value);
    }
    return values;
}

/** Maps each secret value (and each decoded key line) to its variable name. */
export function collectSecrets(
    sources: Iterable<[string, string | undefined]>,
): Map<string, string> {
    const secrets = new Map<string, string>();
    const add = (value: string, name: string): void => {
        if (value.length >= MIN_SECRET_LENGTH && !secrets.has(value)) {
            secrets.set(value, name);
        }
    };
    for (const [name, value] of sources) {
        if (!value || !SECRET_NAME.test(name)) continue;
        add(value, name);
        const decoded = Buffer.from(value, "base64").toString("utf8");
        if (!decoded.includes("-----BEGIN")) continue;
        for (const line of decoded.split(/\r?\n/)) {
            const trimmed = line.trim();
            if (trimmed.length > 20 && !trimmed.startsWith("-----"))
                add(trimmed, name);
        }
    }
    return secrets;
}

export class Redactor {
    readonly #entries: [string, string][];

    constructor(secrets: Map<string, string>) {
        this.#entries = [...secrets].sort((a, b) => b[0].length - a[0].length);
    }

    text(input: string): string {
        let output = input;
        for (const [value, name] of this.#entries) {
            if (output.includes(value))
                output = output.replaceAll(value, `[REDACTED:${name}]`);
        }
        return output;
    }

    bytes(input: Uint8Array): Uint8Array {
        let output = Buffer.from(input);
        for (const [value, name] of this.#entries) {
            const needle = Buffer.from(value);
            let at = output.indexOf(needle);
            if (at < 0) continue;
            const marker = Buffer.from(`[REDACTED:${name}]`);
            const parts: Buffer[] = [];
            let from = 0;
            while (at >= 0) {
                parts.push(output.subarray(from, at), marker);
                from = at + needle.length;
                at = output.indexOf(needle, from);
            }
            parts.push(output.subarray(from));
            output = Buffer.concat(parts);
        }
        return output;
    }
}
