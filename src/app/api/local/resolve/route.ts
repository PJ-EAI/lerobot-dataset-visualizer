/**
 * Turns a path typed into the search box into something navigable, and says why when it can't.
 *
 * Going through the server (rather than encoding the path in the browser) is what lets a bad path
 * produce a real message — "no meta/info.json here" instead of a blank 404 — and keeps the
 * filesystem checks in one place.
 */

import type { NextRequest } from "next/server";

import {
  describeLocalDataset,
  isLocalDatasetsEnabled,
  isPrivateRequest,
  localScanRoots,
  normalizeLocalPath,
} from "@/lib/localDatasetServer";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(req: NextRequest) {
  if (!isLocalDatasetsEnabled()) {
    return Response.json(
      { ok: false, error: "Local datasets are disabled." },
      { status: 404 },
    );
  }
  if (!isPrivateRequest(req)) {
    return Response.json({ ok: false, error: "Forbidden." }, { status: 403 });
  }

  const input = req.nextUrl.searchParams.get("path")?.trim();
  if (!input) {
    return Response.json(
      { ok: false, error: "No path given." },
      { status: 400 },
    );
  }

  let entry;
  try {
    entry = await describeLocalDataset(
      normalizeLocalPath(input),
      localScanRoots().map((root) => root.dir),
    );
  } catch (err) {
    console.error("[local] resolve failed", err);
    return Response.json(
      { ok: false, error: "Could not read that path." },
      { status: 500 },
    );
  }

  if (!entry) {
    return Response.json(
      {
        ok: false,
        error: `Not a LeRobot dataset: ${input} has no readable meta/info.json.`,
      },
      { status: 404 },
    );
  }

  return Response.json({ ok: true, dataset: entry });
}
