import { mkdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";

/**
 * On-disk cache for outside data.
 *
 * The files these sources publish are tens of megabytes and change at most
 * daily, so re-fetching them per run is rude to the people hosting them for
 * free and slow for us. More importantly it makes the draft-night failure mode
 * worse: a source that is unreachable at 8pm on draft day should cost nothing,
 * because the copy from this morning is just as good.
 */

const CACHE_DIR = join(process.cwd(), ".cache", "sources");
const DEFAULT_TTL_MS = 12 * 60 * 60 * 1000;

export interface FetchTextOptions {
  /** How long a cached copy stays fresh. */
  ttlMs?: number;
  /** Seconds before giving up on the network. */
  timeoutSeconds?: number;
}

/**
 * Fetches a URL as text, via cache.
 *
 * A stale cache entry beats a failed request: if the network is down and we
 * have yesterday's copy, yesterday's copy is returned with a warning rather
 * than an exception. Only a miss on both is an error.
 */
export async function fetchTextCached(
  url: string,
  key: string,
  { ttlMs = DEFAULT_TTL_MS, timeoutSeconds = 60 }: FetchTextOptions = {},
): Promise<{ text: string; fromCache: boolean; stale: boolean }> {
  const path = join(CACHE_DIR, key);

  const cached = readCache(path);
  if (cached && Date.now() - cached.mtimeMs < ttlMs) {
    return { text: cached.text, fromCache: true, stale: false };
  }

  try {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutSeconds * 1000);
    const response = await fetch(url, { signal: controller.signal });
    clearTimeout(timer);
    if (!response.ok) throw new Error(`${response.status} ${response.statusText}`);
    const text = await response.text();

    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, text, "utf8");
    return { text, fromCache: false, stale: false };
  } catch (err) {
    if (cached) return { text: cached.text, fromCache: true, stale: true };
    throw new Error(`Could not fetch ${url} and no cached copy exists: ${describe(err)}`);
  }
}

function readCache(path: string): { text: string; mtimeMs: number } | null {
  try {
    return { text: readFileSync(path, "utf8"), mtimeMs: statSync(path).mtimeMs };
  } catch {
    return null;
  }
}

function describe(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
