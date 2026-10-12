/**
 * Server-side access to local (on-disk) LeRobot datasets.
 *
 * A local dataset is a directory containing `meta/info.json`, in either of the layouts LeRobot
 * leaves on disk:
 *
 *   <root>/<org>/<name>/meta/info.json                                  (local_dir download)
 *   <root>/hub/datasets--<org>--<name>/snapshots/<sha>/meta/info.json   (hub cache)
 *
 * The second layout stores every file as a symlink into a sibling `blobs/` directory, which is
 * outside the snapshot root — see `allowedRealBases`.
 *
 * This module reads arbitrary directories under an operator-controlled path, so every request path
 * is validated here before a single byte is read. Server-only: never import it from a client
 * component.
 */

import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";

import { LOCAL_ORG } from "@/utils/localDataset";

/** Directories that are never datasets and are expensive or pointless to descend into. */
const SKIP_DIRS = new Set(["blobs", "refs", ".locks", "node_modules", ".git"]);
const MAX_SCAN_DEPTH = 6;
const MAX_SCAN_DIRS = 2000;
const MAX_DATASETS = 200;

export const LOCAL_HUB_API = "/api/lh";
export const LOCAL_ORG_SEGMENT = LOCAL_ORG;

export type LocalDatasetEntry = {
  /** Friendly label, e.g. `lerobot/pusht`. */
  name: string;
  /** Address segment for `/[org]/[dataset]/...`. */
  token: string;
  /** Absolute path on disk. */
  path: string;
  version: string | null;
  totalEpisodes: number | null;
  robotType: string | null;
  hasVideos: boolean;
};

// ---------------------------------------------------------------------------
// Feature gate
// ---------------------------------------------------------------------------

/**
 * Local datasets are a developer feature: the server must be able to read the viewer's disk, which
 * is only true when the app runs on their machine. `auto` follows `NODE_ENV`, so `bun dev` has it
 * and a production build (including the deployed Space) does not unless explicitly enabled.
 */
export function isLocalDatasetsEnabled(): boolean {
  const flag = (process.env.LOCAL_DATASETS ?? "auto").trim().toLowerCase();
  if (flag === "1" || flag === "true" || flag === "on") return true;
  if (flag === "0" || flag === "false" || flag === "off") return false;
  return process.env.NODE_ENV !== "production";
}

// ---------------------------------------------------------------------------
// Request origin
// ---------------------------------------------------------------------------

/**
 * Local file reads are only served to callers on this machine or its private network (Docker's
 * bridge arrives as 172.17.x). A dev server binds all interfaces, so this keeps a public or
 * same-LAN peer from using the route to read the operator's disk.
 *
 * The browser checks matter most, and come first: a page on any website can make the user's own
 * browser request `http://localhost:3000/...`, which would otherwise turn this route into a way to
 * read the local disk from the internet. The source-IP check alone cannot see that, since the
 * request genuinely does come from the machine.
 */
export function isPrivateRequest(req: Request): boolean {
  const site = req.headers.get("sec-fetch-site");
  if (site && site !== "same-origin" && site !== "none") return false;

  const origin = req.headers.get("origin");
  if (origin) {
    try {
      const host = req.headers.get("host");
      if (!host || new URL(origin).host !== host) return false;
    } catch {
      return false;
    }
  }

  const forwarded = req.headers.get("x-forwarded-for");
  const remote = forwarded?.split(",")[0]?.trim() || null;
  if (!remote) {
    // No forwarding header: Next's node server doesn't expose the socket here, and requests that
    // never crossed a proxy are local by construction.
    return true;
  }
  const host = remote.replace(/^\[|\]$/g, "");
  if (host === "::1" || host === "localhost") return true;
  if (
    host.startsWith("127.") ||
    host.startsWith("10.") ||
    host.startsWith("192.168.")
  ) {
    return true;
  }
  // 172.16.0.0 – 172.31.255.255
  const m = /^172\.(\d+)\./.exec(host);
  if (m) {
    const second = Number(m[1]);
    if (second >= 16 && second <= 31) return true;
  }
  // IPv6 unique-local (fc00::/7) and link-local (fe80::/10).
  if (/^f[cd][0-9a-f]{2}:/i.test(host) || /^fe[89ab][0-9a-f]:/i.test(host))
    return true;
  return false;
}

// ---------------------------------------------------------------------------
// Token <-> path
// ---------------------------------------------------------------------------

function toBase64Url(input: string): string {
  const bytes = new TextEncoder().encode(input);
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary)
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/, "");
}

function fromBase64Url(token: string): string | null {
  try {
    const padded = token.replace(/-/g, "+").replace(/_/g, "/");
    const binary = atob(padded + "=".repeat((4 - (padded.length % 4)) % 4));
    const bytes = Uint8Array.from(binary, (c) => c.charCodeAt(0));
    return new TextDecoder().decode(bytes);
  } catch {
    return null;
  }
}

export function encodeLocalToken(absPath: string): string {
  return toBase64Url(absPath);
}

/** Expands `~` and makes the path absolute (lexically — the caller realpaths before reading). */
export function normalizeLocalPath(input: string): string {
  const trimmed = input.trim();
  const expanded =
    trimmed === "~"
      ? os.homedir()
      : trimmed.startsWith("~/")
        ? path.join(os.homedir(), trimmed.slice(2))
        : trimmed;
  return path.resolve(expanded);
}

/**
 * Validates that a directory really is a LeRobot dataset and returns its real path.
 * Returns null when it is not readable as one.
 */
export async function resolveLocalDatasetRoot(
  absPath: string,
): Promise<string | null> {
  let real: string;
  try {
    real = await fs.realpath(absPath);
  } catch {
    return null;
  }

  const infoPath = path.join(real, "meta", "info.json");
  try {
    const stat = await fs.stat(real);
    if (!stat.isDirectory()) return null;
    const infoStat = await fs.stat(infoPath);
    if (!infoStat.isFile()) return null;
  } catch {
    return null;
  }
  return real;
}

export async function resolveLocalToken(token: string): Promise<string | null> {
  const decoded = fromBase64Url(token);
  if (!decoded) return null;
  return resolveLocalDatasetRoot(normalizeLocalPath(decoded));
}

// ---------------------------------------------------------------------------
// Path safety
// ---------------------------------------------------------------------------

/**
 * Directories a served file's *real* path may live under.
 *
 * The hub-cache layout symlinks every file to `<...>/datasets--<org>--<name>/blobs/<sha>`, i.e.
 * outside the snapshot root, so allowing only the dataset root would refuse every file of such a
 * dataset. The container directory is added for exactly that case and nothing wider.
 */
export function allowedRealBases(root: string): string[] {
  const bases = [root];
  const parent = path.dirname(root);
  if (path.basename(parent) === "snapshots") bases.push(path.dirname(parent));
  return bases;
}

function isInside(base: string, candidate: string): boolean {
  return (
    candidate === base ||
    candidate.startsWith(base.endsWith(path.sep) ? base : base + path.sep)
  );
}

export type ResolvedFile =
  | { ok: true; realPath: string; logicalPath: string }
  | { ok: false; reason: string };

/**
 * Maps a request path (the `[...path]` segments of the API route) to a file inside `root`.
 *
 * Rejects: traversal, absolute/empty/backslash/NUL segments, anything outside the dataset's
 * `meta/ data/ videos/` trees, non-regular files, and symlinks that escape `allowedRealBases`.
 */
export async function resolveDatasetFilePath(
  root: string,
  segments: string[],
): Promise<ResolvedFile> {
  if (segments.length === 0) return { ok: false, reason: "empty path" };

  for (const segment of segments) {
    if (
      !segment ||
      segment === "." ||
      segment === ".." ||
      segment.includes("\\") ||
      segment.includes("\0") ||
      segment.includes("/") ||
      path.isAbsolute(segment)
    ) {
      return { ok: false, reason: "illegal path segment" };
    }
  }

  const [top] = segments;
  if (top !== "meta" && top !== "data" && top !== "videos") {
    return { ok: false, reason: "path outside meta/, data/, videos/" };
  }

  const logicalPath = path.resolve(root, ...segments);
  if (!isInside(root, logicalPath))
    return { ok: false, reason: "path escapes dataset root" };

  let realPath: string;
  try {
    realPath = await fs.realpath(logicalPath);
  } catch {
    return { ok: false, reason: "not found" };
  }

  const bases = allowedRealBases(root);
  const contained = bases
    .map((b) => path.resolve(b))
    .find((b) => isInside(b, realPath));
  if (!contained)
    return { ok: false, reason: "real path escapes dataset root" };

  try {
    const stat = await fs.stat(realPath);
    if (!stat.isFile()) return { ok: false, reason: "not a regular file" };
  } catch {
    return { ok: false, reason: "not found" };
  }

  return { ok: true, realPath, logicalPath };
}

// ---------------------------------------------------------------------------
// Discovery
// ---------------------------------------------------------------------------

export function localScanRoots(): { dir: string; label: string }[] {
  const roots: { dir: string; label: string }[] = [];

  const lerobotHome =
    process.env.HF_LEROBOT_HOME ||
    path.join(os.homedir(), ".cache", "huggingface", "lerobot");
  roots.push({ dir: path.resolve(lerobotHome), label: "lerobot cache" });

  for (const raw of (process.env.LOCAL_DATASETS_DIR || "").split(/[:;]/)) {
    const dir = raw.trim();
    if (dir)
      roots.push({ dir: normalizeLocalPath(dir), label: "LOCAL_DATASETS_DIR" });
  }
  return roots;
}

/** `datasets--<org>--<name>` → `<org>/<name>`; otherwise the path relative to its scan root. */
export function localDatasetLabel(absPath: string, roots: string[]): string {
  for (const part of absPath.split(path.sep)) {
    const m = /^datasets--(.+?)--(.+)$/.exec(part);
    if (m) return `${m[1]}/${m[2]}`;
  }
  for (const root of roots) {
    if (isInside(root, absPath)) {
      const rel = path.relative(root, absPath);
      if (rel && !rel.startsWith("..")) return rel.split(path.sep).join("/");
    }
  }
  return path.basename(absPath);
}

/**
 * Whether a tree holds any regular file, walked to a fixed depth: `videos/` nests a camera
 * directory and a chunk directory before the mp4s (`videos/<camera>/chunk-000/file-000.mp4`), so
 * looking only at direct children would report a dataset as having no camera data.
 */
async function treeHasFiles(dir: string, depth = 0): Promise<boolean> {
  if (depth > 3) return false;
  let entries;
  try {
    entries = await fs.readdir(dir, { withFileTypes: true });
  } catch {
    return false;
  }
  for (const entry of entries) {
    const child = path.join(dir, entry.name);
    try {
      const stat = await fs.stat(child);
      if (stat.isFile()) return true;
      if (stat.isDirectory() && (await treeHasFiles(child, depth + 1)))
        return true;
    } catch {
      // Broken symlink or unreadable entry: keep looking.
    }
  }
  return false;
}

async function readInfoSummary(root: string): Promise<{
  version: string | null;
  totalEpisodes: number | null;
  robotType: string | null;
}> {
  try {
    const raw = await fs.readFile(path.join(root, "meta", "info.json"), "utf8");
    const info = JSON.parse(raw) as {
      codebase_version?: string;
      total_episodes?: number;
      robot_type?: string | null;
    };
    return {
      version: info.codebase_version ?? null,
      totalEpisodes:
        typeof info.total_episodes === "number" ? info.total_episodes : null,
      robotType: info.robot_type ?? null,
    };
  } catch {
    return { version: null, totalEpisodes: null, robotType: null };
  }
}

/** Reads one dataset directory into the shape the UI consumes. Null if it isn't a dataset. */
export async function describeLocalDataset(
  absPath: string,
  labels: string[] = [],
): Promise<LocalDatasetEntry | null> {
  const real = await resolveLocalDatasetRoot(absPath);
  if (!real) return null;

  const summary = await readInfoSummary(real);
  return {
    name: localDatasetLabel(real, labels),
    token: encodeLocalToken(real),
    path: real,
    ...summary,
    hasVideos: await treeHasFiles(path.join(real, "videos")),
  };
}

/**
 * Walks each root and records every directory holding `meta/info.json`, without descending into a
 * directory once it is recognised as a dataset. Bounded in both depth and directories visited so a
 * large home directory cannot wedge the dev server, and per-entry failures never abort the scan.
 */
export async function scanLocalDatasets(): Promise<LocalDatasetEntry[]> {
  const roots = localScanRoots();
  const rootPaths = roots.map((r) => r.dir);
  const found = new Map<string, LocalDatasetEntry>();
  let visited = 0;

  const walk = async (dir: string, depth: number): Promise<void> => {
    if (
      depth > MAX_SCAN_DEPTH ||
      visited >= MAX_SCAN_DIRS ||
      found.size >= MAX_DATASETS
    )
      return;
    visited++;

    let entries;
    try {
      entries = await fs.readdir(dir, { withFileTypes: true });
    } catch {
      return;
    }

    const subdirs: string[] = [];
    for (const entry of entries) {
      if (entry.name.startsWith(".") || SKIP_DIRS.has(entry.name)) continue;
      if (!entry.isDirectory() && !entry.isSymbolicLink()) continue;
      const child = path.join(dir, entry.name);
      try {
        if ((await fs.stat(child)).isDirectory()) subdirs.push(child);
      } catch {
        // Unreadable entry: skip it.
      }
    }

    if (subdirs.length > 0) {
      // A directory holding meta/info.json is a dataset; its children are not scanned further.
      try {
        if ((await fs.stat(path.join(dir, "meta", "info.json"))).isFile()) {
          const entry = await describeLocalDataset(dir, rootPaths);
          if (entry && !found.has(entry.path)) found.set(entry.path, entry);
          return;
        }
      } catch {
        // Not a dataset: fall through and keep walking.
      }
    }

    for (const sub of subdirs) await walk(sub, depth + 1);
  };

  for (const root of roots) {
    try {
      if (!(await fs.stat(root.dir)).isDirectory()) continue;
    } catch {
      continue;
    }
    await walk(root.dir, 0);
  }

  return [...found.values()].sort((a, b) => a.name.localeCompare(b.name));
}
