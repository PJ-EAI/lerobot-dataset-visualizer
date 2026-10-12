/**
 * Lists the local datasets found under the LeRobot cache and `LOCAL_DATASETS_DIR`.
 *
 * Returns `{ enabled: false }` when the feature is off, which is how the UI knows to hide itself —
 * a client component can't decide this from `NODE_ENV`.
 */

import type { NextRequest } from "next/server";

import {
  isLocalDatasetsEnabled,
  isPrivateRequest,
  scanLocalDatasets,
  type LocalDatasetEntry,
} from "@/lib/localDatasetServer";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// Scanning touches the filesystem, so keep a short cache to spare the home page a walk on every
// mount, while still noticing a dataset that was just downloaded.
const CACHE_TTL_MS = 15_000;
let cache: { datasets: LocalDatasetEntry[]; expiry: number } | null = null;

export async function GET(req: NextRequest) {
  if (!isLocalDatasetsEnabled()) {
    return Response.json({ enabled: false, datasets: [] });
  }
  if (!isPrivateRequest(req)) {
    return Response.json({ enabled: false, datasets: [] });
  }

  const now = Date.now();
  if (!cache || now >= cache.expiry) {
    try {
      cache = {
        datasets: await scanLocalDatasets(),
        expiry: now + CACHE_TTL_MS,
      };
    } catch (err) {
      console.error("[local] scan failed", err);
      return Response.json({ enabled: true, datasets: [] });
    }
  }

  return Response.json({ enabled: true, datasets: cache.datasets });
}
