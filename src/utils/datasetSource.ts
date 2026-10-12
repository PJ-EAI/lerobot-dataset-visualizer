/**
 * Where a dataset's bytes come from.
 *
 * Every reader in this app is client-side, and every path it fetches is
 * `{base}/{repoId}/resolve/main/{path}` — either hand-built (`buildVersionedUrl`) or built by
 * `@huggingface/lerobot` from its `endpoint` option (`endpoint` + `/datasets/...`). So "is this
 * dataset local?" can be answered from the repoId alone, which keeps the two sources from needing
 * a parallel code path: a local repo is `local/<token>`, served by our own `/api/lh` routes, and
 * anything else is a Hub repo served from huggingface.co exactly as before.
 */

import { authHeaders } from "./auth";
import { isLocalRepoId } from "./localDataset";

const DATASET_URL =
  process.env.DATASET_URL || "https://huggingface.co/datasets";
const HUB_ENDPOINT = DATASET_URL.replace(/\/datasets\/?$/, "");

/**
 * Origin of the running app, so local URLs are absolute — `<video>` sources, `fetch`, and any
 * `new URL()` parsing all behave unambiguously with them. Readers only ever run in the browser;
 * the relative fallback keeps server-side rendering from throwing.
 */
function appOrigin(): string {
  return typeof window !== "undefined" ? window.location.origin : "";
}

/** Base for `{base}/{repoId}/resolve/main/{path}`. */
export function datasetBaseUrl(repoId: string): string {
  return isLocalRepoId(repoId) ? `${appOrigin()}/api/lh/datasets` : DATASET_URL;
}

/** `endpoint` for `LeRobotDataset`, which appends `/datasets/{repoId}/resolve/...` itself. */
export function datasetEndpoint(repoId: string): string {
  return isLocalRepoId(repoId) ? `${appOrigin()}/api/lh` : HUB_ENDPOINT;
}

/** Hub requests carry the viewer's token; our own routes are same-origin and need none. */
export function datasetFetchHeaders(repoId: string): Record<string, string> {
  return isLocalRepoId(repoId) ? {} : authHeaders();
}

export { HUB_ENDPOINT, DATASET_URL };
