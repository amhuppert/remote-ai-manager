// Turbopack's persistent build cache (`experimental.turbopackFileSystemCacheForBuild`)
// has no eviction of its own: the store accrues roughly a gigabyte per build and
// nothing in Next.js or this repo ever prunes it. Past a few gigabytes the compile
// collapses onto a single core instead of parallelising, so an unbounded store
// silently inverts the optimisation it exists to provide.
//
// Measured in the main worktree at de2a8cdf on 2026-09-01, same tree each time:
// an 8.4GB store compiled in 28.3min (99% CPU, 1 of 16 cores); an empty store in
// 69s; a 1.5GB store in 28.9s (1310% CPU). The store is a genuine ~2.4x win while
// small, so this prunes it by size rather than disabling the cache.
import { readdirSync, rmSync, statSync, type Dirent } from "node:fs";
import path from "node:path";

/**
 * Two builds' worth of headroom. A healthy single-generation store measured
 * 1.5GB, so this tolerates normal growth while staying far below the range
 * where the compile degrades. Pruning costs one cold compile (~40s more) and
 * is therefore much cheaper than the regression it prevents.
 */
export const DEFAULT_MAX_CACHE_GIB = 3;

/** Operator override, in GB, for the threshold above. */
export const MAX_CACHE_ENV_VAR = "CC_TURBOPACK_CACHE_MAX_GB";

const BYTES_PER_GIB = 1024 ** 3;

export interface CachePruneInput {
  /** Store size, or null when the store does not exist yet. */
  sizeBytes: number | null;
  maxBytes: number;
}

export interface CachePruneDecision {
  prune: boolean;
  message: string;
}

export function formatGiB(bytes: number): string {
  return `${(bytes / BYTES_PER_GIB).toFixed(2)}GB`;
}

export function decideCachePrune(input: CachePruneInput): CachePruneDecision {
  const { sizeBytes, maxBytes } = input;

  if (sizeBytes === null) {
    return { prune: false, message: "no Turbopack cache yet — cold build." };
  }

  if (sizeBytes < maxBytes) {
    return {
      prune: false,
      message: `Turbopack cache ${formatGiB(sizeBytes)} (limit ${formatGiB(maxBytes)}) — kept.`,
    };
  }

  return {
    prune: true,
    message:
      `Turbopack cache ${formatGiB(sizeBytes)} reached the ${formatGiB(maxBytes)} limit — pruning. ` +
      "An oversized store serialises the compile; the next build is cold and rebuilds it.",
  };
}

export function resolveMaxCacheBytes(raw: string | undefined): number {
  const parsed = Number(raw);
  // A malformed or non-positive override must not silently prune on every
  // build, so anything that is not a positive finite number falls back.
  if (
    raw === undefined ||
    raw.trim().length === 0 ||
    !Number.isFinite(parsed) ||
    parsed <= 0
  ) {
    return DEFAULT_MAX_CACHE_GIB * BYTES_PER_GIB;
  }
  return parsed * BYTES_PER_GIB;
}

export function measureDirectoryBytes(directory: string): number | null {
  let entries: Dirent[];
  try {
    entries = readdirSync(directory, { withFileTypes: true });
  } catch {
    return null;
  }

  let total = 0;
  for (const entry of entries) {
    const entryPath = path.join(directory, entry.name);
    if (entry.isDirectory()) {
      total += measureDirectoryBytes(entryPath) ?? 0;
      continue;
    }
    if (!entry.isFile()) continue;
    try {
      total += statSync(entryPath).size;
    } catch {
      // A file the build removed mid-walk contributes nothing.
    }
  }
  return total;
}

function main(): void {
  const cacheDir = path.join(__dirname, "..", ".next", "cache", "turbopack");
  const decision = decideCachePrune({
    sizeBytes: measureDirectoryBytes(cacheDir),
    maxBytes: resolveMaxCacheBytes(process.env[MAX_CACHE_ENV_VAR]),
  });

  console.log(`turbopack-cache: ${decision.message}`);
  if (decision.prune) {
    rmSync(cacheDir, { recursive: true, force: true });
  }
}

if (import.meta.main) {
  // Housekeeping must never be what fails a build.
  try {
    main();
  } catch (error) {
    console.warn(
      `turbopack-cache: skipped the size check (${error instanceof Error ? error.message : String(error)}).`,
    );
  }
}
