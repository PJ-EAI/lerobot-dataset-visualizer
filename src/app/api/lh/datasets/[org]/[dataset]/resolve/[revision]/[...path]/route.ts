/**
 * Serves a local dataset's files over the same URL shape the Hub uses
 * (`{endpoint}/datasets/{repoId}/resolve/{revision}/{path}`), so `@huggingface/lerobot` and the
 * hyparquet readers can point at it by swapping only their base URL. See `src/utils/datasetSource.ts`.
 *
 * Ranged reads are what make video seeking work: the player asks for byte ranges, and this route
 * answers 206 with `Content-Range`, streaming straight off disk.
 *
 * Everything here is validated by `src/lib/localDatasetServer.ts` before any file is opened.
 */

import { createReadStream } from "node:fs";
import { stat } from "node:fs/promises";
import { Readable } from "node:stream";
import type { NextRequest } from "next/server";

import { createHash } from "node:crypto";

import {
  isLocalDatasetsEnabled,
  isPrivateRequest,
  resolveDatasetFilePath,
  resolveLocalToken,
} from "@/lib/localDatasetServer";
import { LOCAL_ORG } from "@/utils/localDataset";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * An allowlist, never a guess: this route is same-origin with the app, so serving a stray
 * `attack.html` or `.svg` with its natural type would run script with the viewer's privileges.
 * Anything unlisted (including `.html`/`.svg`) falls through to `application/octet-stream`.
 */
const CONTENT_TYPES: Record<string, string> = {
  ".mp4": "video/mp4",
  ".webm": "video/webm",
  ".json": "application/json",
  ".jsonl": "application/x-ndjson",
  ".parquet": "application/octet-stream",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".webp": "image/webp",
  ".txt": "text/plain; charset=utf-8",
};

function contentTypeFor(filePath: string): string {
  const dot = filePath.lastIndexOf(".");
  const ext = dot >= 0 ? filePath.slice(dot).toLowerCase() : "";
  return CONTENT_TYPES[ext] ?? "application/octet-stream";
}

/** `bytes=start-end` / `bytes=start-` / `bytes=-suffix`, clamped to the file. */
function parseRange(
  header: string | null,
  size: number,
): { start: number; end: number } | "unsatisfiable" | null {
  if (!header) return null;
  const match = /^bytes=(\d*)-(\d*)$/.exec(header.trim());
  if (!match) return null;
  const [, rawStart, rawEnd] = match;

  if (rawStart === "" && rawEnd === "") return null;

  if (rawStart === "") {
    const suffix = Number(rawEnd);
    if (!Number.isFinite(suffix) || suffix <= 0) return "unsatisfiable";
    return { start: Math.max(0, size - suffix), end: size - 1 };
  }

  const start = Number(rawStart);
  if (!Number.isFinite(start) || start >= size) return "unsatisfiable";
  const end = rawEnd === "" ? size - 1 : Math.min(Number(rawEnd), size - 1);
  if (end < start) return "unsatisfiable";
  return { start, end };
}

function fileStream(
  realPath: string,
  start: number,
  end: number,
  signal: AbortSignal,
): ReadableStream<Uint8Array> {
  const nodeStream = createReadStream(realPath, { start, end });
  // A seek abandons the previous range request; without this the descriptor stays open until the
  // stream drains.
  const onAbort = () => nodeStream.destroy();
  if (signal.aborted) onAbort();
  else signal.addEventListener("abort", onAbort, { once: true });
  nodeStream.on("close", () => signal.removeEventListener("abort", onAbort));
  return Readable.toWeb(nodeStream) as unknown as ReadableStream<Uint8Array>;
}

async function serve(
  req: NextRequest,
  ctx: {
    params: Promise<{
      org: string;
      dataset: string;
      revision: string;
      path: string[];
    }>;
  },
  headOnly: boolean,
): Promise<Response> {
  if (!isLocalDatasetsEnabled()) return new Response(null, { status: 404 });
  if (!isPrivateRequest(req)) return new Response("Forbidden", { status: 403 });

  const { org, dataset, path: segments } = await ctx.params;
  if (org !== LOCAL_ORG) return new Response(null, { status: 404 });

  const root = await resolveLocalToken(dataset);
  if (!root) return new Response("Dataset not found", { status: 404 });

  const resolved = await resolveDatasetFilePath(root, segments);
  if (!resolved.ok) {
    return new Response(resolved.reason, {
      status: resolved.reason === "not found" ? 404 : 403,
    });
  }

  let size: number;
  let mtimeMs: number;
  try {
    const info = await stat(resolved.realPath);
    size = info.size;
    mtimeMs = info.mtimeMs;
  } catch {
    return new Response("Not found", { status: 404 });
  }

  // Enough to let the browser reuse bytes across seeks without re-reading a large video.
  const etag = `"${createHash("sha1")
    .update(`${resolved.realPath}:${size}:${mtimeMs}`)
    .digest("hex")
    .slice(0, 16)}"`;

  const headers = new Headers({
    // From the requested path, not the real one: hub-cache files are sha-named symlinks into
    // `blobs/`, so the real path has no extension and the video would be typed as a download.
    "Content-Type": contentTypeFor(resolved.logicalPath),
    "Accept-Ranges": "bytes",
    ETag: etag,
    // `max-age=0` + ETag keeps a seeked 65 MB video from being re-sent while still picking up a
    // dataset edited mid-session. `nosniff` backs up the content-type allowlist above.
    "Cache-Control": "private, max-age=0, must-revalidate",
    "X-Content-Type-Options": "nosniff",
    "Cross-Origin-Resource-Policy": "same-origin",
  });

  if (req.headers.get("if-none-match") === etag) {
    return new Response(null, { status: 304, headers });
  }

  const range = parseRange(req.headers.get("range"), size);
  if (range === "unsatisfiable") {
    headers.set("Content-Range", `bytes */${size}`);
    return new Response(null, { status: 416, headers });
  }

  if (!range) {
    headers.set("Content-Length", String(size));
    return new Response(
      headOnly ? null : fileStream(resolved.realPath, 0, size - 1, req.signal),
      { status: 200, headers },
    );
  }

  const length = range.end - range.start + 1;
  headers.set("Content-Length", String(length));
  // `content-range` is how the package and hyparquet learn the file's total size; without it on a
  // 206 they fall back to buffering the whole file.
  headers.set("Content-Range", `bytes ${range.start}-${range.end}/${size}`);
  return new Response(
    headOnly
      ? null
      : fileStream(resolved.realPath, range.start, range.end, req.signal),
    { status: 206, headers },
  );
}

export async function GET(
  req: NextRequest,
  ctx: {
    params: Promise<{
      org: string;
      dataset: string;
      revision: string;
      path: string[];
    }>;
  },
) {
  return serve(req, ctx, false);
}

export async function HEAD(
  req: NextRequest,
  ctx: {
    params: Promise<{
      org: string;
      dataset: string;
      revision: string;
      path: string[];
    }>;
  },
) {
  return serve(req, ctx, true);
}
