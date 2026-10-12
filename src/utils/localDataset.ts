/**
 * Local (on-disk) LeRobot datasets are addressed through the same `[org]/[dataset]` routes as Hub
 * datasets, with the reserved org `local` and the dataset segment carrying the absolute directory
 * path in base64url (so it stays a single URL segment).
 *
 * The encoding is stateless on purpose: a link keeps working across dev-server restarts, and the
 * home page's "scan the cache directory" flow needs no registry — it just encodes what it found.
 *
 * Nothing here touches the filesystem; decoding and validation happen server-side (see
 * `src/lib/localDatasetServer.ts`).
 */

export const LOCAL_ORG = "local";
export const LOCAL_REPO_PREFIX = `${LOCAL_ORG}/`;

export function isLocalRepoId(repoId: string): boolean {
  return repoId.startsWith(LOCAL_REPO_PREFIX);
}

/** The dataset segment of a local repo id (`local/<token>` → `<token>`). */
export function localTokenFrom(repoId: string): string {
  return repoId.slice(LOCAL_REPO_PREFIX.length);
}

/** Where a scanned/typed local dataset lives in the app. */
export function localDatasetHref(token: string, episodeIndex = 0): string {
  return `/${LOCAL_ORG}/${token}/episode_${episodeIndex}`;
}

/**
 * Decodes a token back to its path for display only. The server re-derives and re-validates every
 * path it serves, so nothing here is a security boundary — it just keeps labels readable and links
 * honest.
 */
export function localPathFromToken(token: string): string | null {
  try {
    const padded = token.replace(/-/g, "+").replace(/_/g, "/");
    const binary = atob(padded + "=".repeat((4 - (padded.length % 4)) % 4));
    const bytes = Uint8Array.from(binary, (c) => c.charCodeAt(0));
    return new TextDecoder().decode(bytes);
  } catch {
    return null;
  }
}

/** What to show a reader: the on-disk path for a local dataset, the repo id otherwise. */
export function displayDatasetId(repoId: string): string {
  if (!isLocalRepoId(repoId)) return repoId;
  return localPathFromToken(localTokenFrom(repoId)) ?? repoId;
}

/**
 * Whether a search-box query looks like a filesystem path rather than a Hub repo id. Only POSIX
 * paths are meaningful here (the feature is local-development only), plus `~` expansion-friendly
 * input and Windows drive letters, which are cheap to recognise even though the server rejects
 * what it cannot resolve.
 */
export function looksLikeLocalPath(query: string): boolean {
  const q = query.trim();
  if (!q) return false;
  return q.startsWith("/") || q.startsWith("~") || /^[a-zA-Z]:[\\/]/.test(q);
}
