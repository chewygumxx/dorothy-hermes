import { randomBytes } from "node:crypto";
import {
    closeSync,
    constants,
    type Dirent,
    fchmodSync,
    fstatSync,
    mkdirSync,
    openSync,
    readdirSync,
    renameSync,
    rmdirSync,
    rmSync,
    writeFileSync,
} from "node:fs";
import { basename, dirname, join } from "node:path";
import {
    type BundleFile,
    encodeFile,
    type FileMode,
    fileBytes,
    readExactly,
} from "./bundle.ts";
import { errorCode, lstatOrNull } from "./util.ts";

const READ = constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK;
const WRITE =
    constants.O_WRONLY |
    constants.O_CREAT |
    constants.O_EXCL |
    constants.O_NOFOLLOW;

function byName(a: Dirent, b: Dirent): number {
    if (a.name < b.name) return -1;
    return a.name > b.name ? 1 : 0;
}

function parentsAreDirectories(root: string, path: string): boolean {
    let dir = root;
    for (const part of path.split("/").slice(0, -1)) {
        dir = join(dir, part);
        if (!lstatOrNull(dir)?.isDirectory()) return false;
    }
    return true;
}

/** Reads root/path, or null when it is missing, a link, or not a regular file. */
export function collectFile(root: string, path: string): BundleFile | null {
    if (!parentsAreDirectories(root, path)) return null;
    let fd: number;
    try {
        fd = openSync(join(root, path), READ);
    } catch (error) {
        const code = errorCode(error);
        if (code === "ENOENT" || code === "ELOOP") return null;
        throw error;
    }
    try {
        const stat = fstatSync(fd);
        if (!stat.isFile()) return null;
        const mode: FileMode = stat.mode & 0o111 ? 0o755 : 0o644;
        return encodeFile(path, readExactly(fd, stat.size), mode);
    } finally {
        closeSync(fd);
    }
}

export interface TreeOptions {
    skipDirectory?(path: string): boolean;
    includeFile?(path: string): boolean;
}

export function collectTree(
    root: string,
    top: string,
    options: TreeOptions = {},
): BundleFile[] {
    const files: BundleFile[] = [];
    const walk = (dir: string): void => {
        const entries = readdirSync(join(root, dir), {
            withFileTypes: true,
        }).sort(byName);
        for (const entry of entries) {
            if (entry.name.startsWith(".")) continue;
            const path = `${dir}/${entry.name}`;
            if (entry.isDirectory()) {
                if (!options.skipDirectory?.(path)) walk(path);
            } else if (
                entry.isFile() &&
                (options.includeFile?.(path) ?? true)
            ) {
                const file = collectFile(root, path);
                if (file) files.push(file);
            }
        }
    };
    if (lstatOrNull(join(root, top))?.isDirectory()) walk(top);
    return files;
}

/** Writes one bundle file, replacing anything but a directory in its way. */
export function writeTreeFile(root: string, file: BundleFile): void {
    let dir = root;
    for (const part of file.path.split("/").slice(0, -1)) {
        dir = join(dir, part);
        const stat = lstatOrNull(dir);
        if (stat?.isDirectory()) continue;
        if (stat) rmSync(dir, { force: true });
        mkdirSync(dir, { mode: 0o755 });
    }
    const target = join(root, file.path);
    if (lstatOrNull(target)?.isDirectory())
        rmSync(target, { recursive: true, force: true });
    // Written aside and renamed over the target (a link is replaced, not
    // followed), so no reader or crash ever sees a half-written file.
    const temp = join(
        dirname(target),
        `.${basename(target)}.${randomBytes(4).toString("hex")}.tmp`,
    );
    try {
        const fd = openSync(temp, WRITE, file.mode);
        try {
            writeFileSync(fd, fileBytes(file));
            fchmodSync(fd, file.mode);
        } finally {
            closeSync(fd);
        }
        renameSync(temp, target);
    } catch (error) {
        rmSync(temp, { force: true });
        throw error;
    }
}

/** Deletes everything under root/top that keep does not list; links are removed, not followed. */
export function removeUnlisted(
    root: string,
    top: string,
    keep: Set<string>,
): void {
    const walk = (dir: string): void => {
        for (const entry of readdirSync(join(root, dir), {
            withFileTypes: true,
        })) {
            const path = `${dir}/${entry.name}`;
            if (entry.isDirectory()) {
                walk(path);
                if (readdirSync(join(root, path)).length === 0)
                    rmdirSync(join(root, path));
            } else if (!keep.has(path)) {
                rmSync(join(root, path), { force: true });
            }
        }
    };
    const stat = lstatOrNull(join(root, top));
    if (stat === null) return;
    if (!stat.isDirectory()) {
        rmSync(join(root, top), { force: true });
        return;
    }
    walk(top);
}

export function emptyDirectory(path: string): void {
    let names: string[];
    try {
        names = readdirSync(path);
    } catch (error) {
        if (errorCode(error) === "ENOENT") return;
        throw error;
    }
    for (const name of names)
        rmSync(join(path, name), { recursive: true, force: true });
}

/** `skills/<category>/<name>` (or `skills/<name>`) holding path, or null. */
/**
 * The directory a restored skill file replaces: `skills/<cat>/<name>` or an
 * uncategorised `skills/<name>`. A category's own files (`DESCRIPTION.md`)
 * name none, since the category also holds bundled skills the bundle omits.
 */
export function skillDirectory(path: string): string | null {
    const parts = path.split("/");
    if (parts.length < 3) return null;
    if (parts.length === 3 && parts[2] !== "SKILL.md") return null;
    return parts.slice(0, Math.min(3, parts.length - 1)).join("/");
}
