import { DatabaseSync } from "node:sqlite";

export class DumpError extends Error {}

export interface DumpOptions {
    mapText?(value: string): string;
    mapBlob?(value: Uint8Array): Uint8Array;
}

export interface SchemaObject {
    type: string;
    name: string;
    tbl_name: string;
    sql: string | null;
}

const FTS5 = /^\s*CREATE\s+VIRTUAL\s+TABLE\s+.*?\bUSING\s+fts5\b/is;
const VIRTUAL = /^\s*CREATE\s+VIRTUAL\s+TABLE\b/i;
const WITHOUT_ROWID = /\bWITHOUT\s+ROWID\s*$/i;
const SHADOW_SUFFIXES = ["_data", "_idx", "_content", "_docsize", "_config"];

export function ident(name: string): string {
    return `"${name.replaceAll('"', '""')}"`;
}

function escapeRegExp(text: string): string {
    return text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function refersTo(sql: string, names: Set<string>): boolean {
    for (const name of names) {
        if (
            new RegExp(`(^|[^\\w$])${escapeRegExp(name)}($|[^\\w$])`, "i").test(
                sql,
            )
        ) {
            return true;
        }
    }
    return false;
}

/**
 * FTS5 tables, their shadow tables and content views, statistics, orphaned
 * trash tables, and every view, trigger and index that depends on them.
 * Hermes rebuilds the search indexes on its first open after a restore.
 */
export function omittedObjects(objects: SchemaObject[]): Set<string> {
    const omitted = new Set<string>();
    const views = new Set(
        objects.filter((o) => o.type === "view").map((o) => o.name),
    );
    for (const object of objects) {
        const sql = object.sql ?? "";
        if (object.type === "table" && FTS5.test(sql)) {
            omitted.add(object.name);
            for (const suffix of SHADOW_SUFFIXES)
                omitted.add(object.name + suffix);
            const content = /\bcontent\s*=\s*['"]?(\w+)/i.exec(sql)?.[1];
            if (content && views.has(content)) omitted.add(content);
        }
        if (
            /^sqlite_stat\d+$/.test(object.name) ||
            object.name.startsWith("fts_v22_trash_")
        ) {
            omitted.add(object.name);
        }
    }
    let grew = true;
    while (grew) {
        grew = false;
        for (const object of objects) {
            const dependent =
                object.type === "view" || object.type === "trigger";
            if (
                dependent &&
                !omitted.has(object.name) &&
                refersTo(object.sql ?? "", omitted)
            ) {
                omitted.add(object.name);
                grew = true;
            }
        }
    }
    for (const object of objects) {
        if (object.type === "index" && omitted.has(object.tbl_name))
            omitted.add(object.name);
    }
    return omitted;
}

export function literal(value: unknown, options: DumpOptions = {}): string {
    if (value === null) return "NULL";
    if (typeof value === "bigint") return value.toString();
    if (typeof value === "number") {
        if (value === Number.POSITIVE_INFINITY) return "9e999";
        if (value === Number.NEGATIVE_INFINITY) return "-9e999";
        if (Number.isNaN(value)) return "NULL";
        const text = String(value);
        return /[.e]/.test(text) ? text : `${text}.0`;
    }
    if (typeof value === "string") {
        const text = options.mapText?.(value) ?? value;
        // sqlite3_exec stops at a NUL, so such text travels as hex.
        if (text.includes("\u0000")) {
            return `CAST(X'${Buffer.from(text, "utf8").toString("hex").toUpperCase()}' AS TEXT)`;
        }
        return `'${text.replaceAll("'", "''")}'`;
    }
    if (value instanceof Uint8Array) {
        const bytes = options.mapBlob?.(value) ?? value;
        return `X'${Buffer.from(bytes).toString("hex").toUpperCase()}'`;
    }
    throw new DumpError(`unsupported value of type ${typeof value}`);
}

function schema(db: DatabaseSync): SchemaObject[] {
    return db
        .prepare(
            "SELECT type, name, tbl_name, sql FROM sqlite_master ORDER BY name",
        )
        .all() as unknown as SchemaObject[];
}

function dataTables(
    objects: SchemaObject[],
    omitted: Set<string>,
): SchemaObject[] {
    return objects.filter(
        (o) =>
            o.type === "table" &&
            !omitted.has(o.name) &&
            !o.name.startsWith("sqlite_"),
    );
}

export function dumpDatabase(path: string, options: DumpOptions = {}): string {
    const db = new DatabaseSync(path, { readOnly: true });
    try {
        const objects = schema(db);
        const omitted = omittedObjects(objects);
        const version = db.prepare("PRAGMA user_version").get() as {
            user_version: number;
        };
        const out = [
            "PRAGMA foreign_keys=OFF;",
            "BEGIN;",
            `PRAGMA user_version=${version.user_version};`,
        ];
        for (const table of dataTables(objects, omitted)) {
            const sql = table.sql ?? "";
            if (VIRTUAL.test(sql))
                throw new DumpError(`unsupported virtual table ${table.name}`);
            out.push(`${sql};`);
            const columns = (
                db
                    .prepare(`PRAGMA table_xinfo(${ident(table.name)})`)
                    .all() as unknown as {
                    name: string;
                    hidden: number;
                }[]
            )
                .filter((column) => column.hidden === 0)
                .map((column) => ident(column.name));
            const order = WITHOUT_ROWID.test(sql) ? "" : " ORDER BY rowid";
            const select = db.prepare(
                `SELECT ${columns.join(", ")} FROM ${ident(table.name)}${order}`,
            );
            select.setReadBigInts(true);
            select.setReturnArrays(true);
            const target = `INSERT INTO ${ident(table.name)}(${columns.join(",")}) VALUES(`;
            for (const row of select.iterate() as Iterable<unknown[]>) {
                out.push(
                    `${target}${row.map((value) => literal(value, options)).join(",")});`,
                );
            }
        }
        if (objects.some((o) => o.name === "sqlite_sequence")) {
            out.push("DELETE FROM sqlite_sequence;");
            const sequence = db.prepare(
                "SELECT name, seq FROM sqlite_sequence ORDER BY name",
            );
            sequence.setReadBigInts(true);
            for (const row of sequence.all() as unknown as {
                name: string;
                seq: bigint;
            }[]) {
                if (omitted.has(row.name)) continue;
                out.push(
                    `INSERT INTO sqlite_sequence(name,seq) VALUES(${literal(row.name)},${literal(row.seq)});`,
                );
            }
        }
        for (const type of ["index", "view", "trigger"]) {
            for (const object of objects) {
                if (
                    object.type === type &&
                    object.sql &&
                    !omitted.has(object.name)
                ) {
                    out.push(`${object.sql};`);
                }
            }
        }
        out.push("COMMIT;");
        return `${out.join("\n")}\n`;
    } finally {
        db.close();
    }
}

export function restoreDatabase(sql: string, path: string): void {
    const db = new DatabaseSync(path);
    try {
        db.exec(sql);
    } catch (error) {
        if (db.isTransaction) db.exec("ROLLBACK");
        throw error;
    } finally {
        db.close();
    }
}

/**
 * `quick_check` per ordinary table: a whole-database check would touch the
 * FTS tables, whose CJK tokenizer Node cannot load.
 */
export function checkTables(path: string): void {
    const db = new DatabaseSync(path, { readOnly: true });
    try {
        const objects = schema(db);
        for (const table of dataTables(objects, omittedObjects(objects))) {
            if (VIRTUAL.test(table.sql ?? "")) continue;
            const quoted = `'${table.name.replaceAll("'", "''")}'`;
            const rows = db
                .prepare(`PRAGMA quick_check(${quoted})`)
                .all() as unknown as {
                quick_check: string;
            }[];
            const problems = rows
                .map((row) => row.quick_check)
                .filter((message) => message !== "ok");
            if (problems.length > 0) {
                throw new DumpError(
                    `integrity check failed for ${table.name}: ${problems.join("; ")}`,
                );
            }
        }
    } finally {
        db.close();
    }
}
