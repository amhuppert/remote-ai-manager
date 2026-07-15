import { z } from "zod";
import { agentBackendSchema, type AgentSessionRef } from "./schemas";

/**
 * Persistence codec for `AgentSessionRef`. The on-disk shape is canonical
 * `{ backend, ref }` — identical to the in-memory/wire shape. Migration
 * `0005-agent-session-ref-shape` converges every persisted ref (legacy
 * `sessionId`/`threadId` unions and the earlier shadow superset) to canonical
 * and bumps the forward-only `KNOWN_SCHEMA_VERSION`, so an older build sharing
 * `CC_CONFIG_DIR` is refused on open rather than expected to read a superset.
 *
 * Every persisted seam encodes through `encodeAgentSessionRefForStorage` and
 * decodes through `persistedAgentSessionRefSchema`. The decoder's legacy and
 * superset arms exist only as transitional read-tolerance for a pre-cutover or
 * dev DB whose rows the migration has not yet converged; they are removable
 * once no such DB can exist (that replaces the retired shadow-retirement
 * follow-up).
 */

const canonicalArm = z
  .object({ backend: agentBackendSchema, ref: z.string().min(1) })
  .transform(
    (value): AgentSessionRef => ({ backend: value.backend, ref: value.ref }),
  );

const supersetArm = z
  .looseObject({ backend: agentBackendSchema, ref: z.string().min(1) })
  .transform(
    (value): AgentSessionRef => ({ backend: value.backend, ref: value.ref }),
  );

const legacyClaudeArm = z
  .looseObject({ backend: z.literal("claude"), sessionId: z.string().min(1) })
  .transform(
    (value): AgentSessionRef => ({ backend: "claude", ref: value.sessionId }),
  );

const legacyCodexArm = z
  .looseObject({ backend: z.literal("codex"), threadId: z.string().min(1) })
  .transform(
    (value): AgentSessionRef => ({ backend: "codex", ref: value.threadId }),
  );

/**
 * Lenient decoder for persisted refs: accepts canonical `{ backend, ref }` plus
 * the transitional legacy (`sessionId`/`threadId`) and shadow-superset shapes,
 * normalizing every arm to the canonical `{ backend, ref }`. The legacy and
 * superset arms are read-only tolerance for pre-cutover / dev-DB rows the
 * migration has not yet converged (see module doc).
 */
export const persistedAgentSessionRefSchema = z.union([
  canonicalArm,
  supersetArm,
  legacyClaudeArm,
  legacyCodexArm,
]);

/**
 * Encode a ref for storage. The on-disk shape is canonical `{ backend, ref }`,
 * identical to the in-memory shape — no `sessionId`/`threadId` mirror.
 * Deterministic, so the canonical-row byte-comparison contract of the
 * conversation codec holds.
 */
export function encodeAgentSessionRefForStorage(
  ref: AgentSessionRef,
): AgentSessionRef {
  return { backend: ref.backend, ref: ref.ref };
}

// ============================================================
// Deep ref transforms for opaque persisted JSON
// ============================================================

/**
 * Exact-key-set matchers for ref occurrences inside opaque JSON (XState
 * machine snapshots embed refs in the root context AND in every child
 * snapshot's `input`, so persisted trees must be walked recursively). The key
 * set is checked exactly — the same discipline as migration
 * `0005-agent-session-ref-shape` — because a looser predicate could rewrite an
 * unrelated object that merely resembles a ref (e.g. an `activeTurn` carrying
 * a `backend` field).
 */
const LEGACY_HANDLE_KEY: Record<
  AgentSessionRef["backend"],
  "sessionId" | "threadId"
> = {
  claude: "sessionId",
  codex: "threadId",
};

function legacyKeyFor(backend: AgentSessionRef["backend"]): string {
  return LEGACY_HANDLE_KEY[backend];
}

function asRefObject(value: unknown): Record<string, unknown> | null {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    return null;
  }
  return value as Record<string, unknown>;
}

/**
 * Legacy `{backend, sessionId|threadId}` only — the sole shape the storage
 * canonicalizer must rewrite. A canonical `{backend, ref}` object never
 * matches (its second key is `ref`, not the legacy handle), which makes the
 * deep write transform a no-op on an already-canonical tree — the live
 * machine-snapshot tree the write path clones.
 */
function asLegacyRef(value: unknown): AgentSessionRef | null {
  const obj = asRefObject(value);
  if (!obj) return null;
  const backend = agentBackendSchema.safeParse(obj.backend);
  if (!backend.success) return null;
  const keys = Object.keys(obj).sort();
  if (keys.length !== 2 || keys[0] !== "backend") return null;
  const legacyKey = legacyKeyFor(backend.data);
  if (keys[1] !== legacyKey) return null;
  const handle = obj[legacyKey];
  if (typeof handle !== "string" || handle.length === 0) return null;
  return { backend: backend.data, ref: handle };
}

/** Legacy `{backend, sessionId|threadId}` or superset `{backend, ref,
 *  sessionId|threadId}` — the shapes restoration must normalize back to
 *  canonical. Canonical shapes never match, so normalization is a no-op on an
 *  already-canonical tree. */
function asNormalizableRef(value: unknown): AgentSessionRef | null {
  const obj = asRefObject(value);
  if (!obj) return null;
  const backend = agentBackendSchema.safeParse(obj.backend);
  if (!backend.success) return null;
  const legacyKey = legacyKeyFor(backend.data);
  // Sorted key order: "backend" < "ref" < "sessionId" / "threadId".
  const keys = Object.keys(obj).sort().join(",");
  const isLegacy = keys === `backend,${legacyKey}`;
  const isSuperset = keys === `backend,ref,${legacyKey}`;
  if (!isLegacy && !isSuperset) return null;
  const handle = isSuperset ? obj.ref : obj[legacyKey];
  if (typeof handle !== "string" || handle.length === 0) return null;
  return { backend: backend.data, ref: handle };
}

function rewriteRefsInPlace(
  node: unknown,
  match: (value: unknown) => AgentSessionRef | null,
  replace: (ref: AgentSessionRef) => unknown,
): number {
  if (node === null || typeof node !== "object") return 0;
  let rewritten = 0;
  if (Array.isArray(node)) {
    for (let i = 0; i < node.length; i += 1) {
      const ref = match(node[i]);
      if (ref) {
        node[i] = replace(ref);
        rewritten += 1;
      } else {
        rewritten += rewriteRefsInPlace(node[i], match, replace);
      }
    }
    return rewritten;
  }
  const obj = node as Record<string, unknown>;
  for (const key of Object.keys(obj)) {
    const ref = match(obj[key]);
    if (ref) {
      obj[key] = replace(ref);
      rewritten += 1;
    } else {
      rewritten += rewriteRefsInPlace(obj[key], match, replace);
    }
  }
  return rewritten;
}

/**
 * Canonicalize every legacy ref occurrence anywhere in an opaque JSON tree
 * (machine snapshots: root context, child snapshot inputs, nested arrays) to
 * `{ backend, ref }`. The live actor snapshot is already canonical, so this is
 * a no-op there: it returns the original object untouched with `rewrittenRefs:
 * 0` when nothing legacy is found, and otherwise a rewritten `structuredClone`
 * so callers keep their live tree unmutated.
 */
export function canonicalizeSessionRefsForStorageDeep<T>(value: T): {
  value: T;
  rewrittenRefs: number;
} {
  const clone = structuredClone(value);
  const rewrittenRefs = rewriteRefsInPlace(
    clone,
    asLegacyRef,
    encodeAgentSessionRefForStorage,
  );
  return rewrittenRefs > 0
    ? { value: clone, rewrittenRefs }
    : { value, rewrittenRefs: 0 };
}

/**
 * Normalize every persisted ref occurrence (legacy or shadow superset)
 * anywhere in an opaque JSON tree back to the canonical `{backend, ref}`,
 * mutating in place. Returns the number of refs rewritten.
 */
export function normalizeSessionRefsDeepInPlace(value: unknown): number {
  return rewriteRefsInPlace(value, asNormalizableRef, (ref) => ref);
}
