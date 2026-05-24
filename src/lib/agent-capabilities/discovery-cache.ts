/**
 * Discovery cache + per-backend fan-out for agent capabilities.
 *
 * Discovery is content-addressable by `sourceSignature`. Each cascade's
 * fetcher walks its native sources and returns an inventory plus a hash that
 * changes whenever any item id, path, description, or argument-hint changes
 * (see `claude-discovery.ts` and `codex-discovery.ts`).
 *
 * This module provides:
 *   - `createAgentCapabilityDiscoveryCache()` — a per-cascade × per-scope map
 *     used to short-circuit when the new signature matches the cached one.
 *   - `runDiscoveryThroughCache()` — runs a single fetcher and either reuses
 *     the cached object reference (signatures match) or replaces it. Throws
 *     are re-thrown without disturbing the cache; the caller (or fan-out
 *     orchestrator) decides whether to surface the failure as a diagnostic.
 *   - `discoverBackendCapabilities()` — fan-out helper. Discovers every
 *     requested cascade in parallel, isolates per-cascade failures so one
 *     bad source does not blow away the others, and supports a manual
 *     `refresh: true` to force re-run. Failures are returned as structured
 *     entries (cascade + sanitized message) instead of thrown so callers can
 *     log + surface them as cascade-scoped diagnostics.
 */

import { createLogger } from "@/lib/logging";
import { timed } from "@/lib/logging/timed";
import { getErrorMessage } from "@/lib/shared/errors";

import type {
  AgentCapabilityCascadeKind,
  AgentCapabilityScopeContext,
} from "./schemas";

import { redactAgentCapabilityText } from "./redaction";

const logger = createLogger("agent-capabilities.discovery-cache");

export interface AgentCapabilityCachedInventory {
  sourceSignature: string;
}

function scopeKey(scope: AgentCapabilityScopeContext): string {
  return [
    scope.level,
    scope.projectName ?? "",
    scope.sessionName ?? "",
    scope.conversationId ?? "",
  ].join("|");
}

export interface AgentCapabilityDiscoveryCache<
  T extends AgentCapabilityCachedInventory,
> {
  get(
    cascadeKind: AgentCapabilityCascadeKind,
    scope: AgentCapabilityScopeContext,
  ): T | undefined;
  set(
    cascadeKind: AgentCapabilityCascadeKind,
    scope: AgentCapabilityScopeContext,
    value: T,
  ): void;
  invalidate(
    cascadeKind: AgentCapabilityCascadeKind,
    scope: AgentCapabilityScopeContext,
  ): void;
  invalidateAll(): void;
}

export function createAgentCapabilityDiscoveryCache<
  T extends AgentCapabilityCachedInventory,
>(): AgentCapabilityDiscoveryCache<T> {
  const entries = new Map<string, T>();

  const compositeKey = (
    cascadeKind: AgentCapabilityCascadeKind,
    scope: AgentCapabilityScopeContext,
  ): string => `${cascadeKind}::${scopeKey(scope)}`;

  return {
    get(cascadeKind, scope) {
      return entries.get(compositeKey(cascadeKind, scope));
    },
    set(cascadeKind, scope, value) {
      entries.set(compositeKey(cascadeKind, scope), value);
    },
    invalidate(cascadeKind, scope) {
      entries.delete(compositeKey(cascadeKind, scope));
    },
    invalidateAll() {
      entries.clear();
    },
  };
}

export interface RunDiscoveryThroughCacheInput<
  T extends AgentCapabilityCachedInventory,
> {
  cache: AgentCapabilityDiscoveryCache<T>;
  cascadeKind: AgentCapabilityCascadeKind;
  scope: AgentCapabilityScopeContext;
  fetcher: () => Promise<T>;
  /** Force the fetcher and always replace the cache entry, even when the new
   * signature equals the cached one. Used by the manual refresh path. */
  force?: boolean;
}

export async function runDiscoveryThroughCache<
  T extends AgentCapabilityCachedInventory,
>(input: RunDiscoveryThroughCacheInput<T>): Promise<T> {
  const { cache, cascadeKind, scope, fetcher, force = false } = input;
  const previous = cache.get(cascadeKind, scope);
  const fresh = await timed(
    logger,
    "discovery_cache.fetch",
    {
      cascadeKind,
      scopeLevel: scope.level,
      projectName: scope.projectName,
      sessionName: scope.sessionName,
      conversationId: scope.conversationId,
      force,
    },
    () => fetcher(),
  );

  if (
    !force &&
    previous &&
    previous.sourceSignature === fresh.sourceSignature
  ) {
    logger.info("discovery_cache.hit", {
      cascadeKind,
      scopeLevel: scope.level,
      sourceSignature: fresh.sourceSignature,
      projectName: scope.projectName,
      sessionName: scope.sessionName,
      conversationId: scope.conversationId,
    });
    return previous;
  }

  cache.set(cascadeKind, scope, fresh);
  logger.info("discovery.refreshed", {
    cascadeKind,
    scopeLevel: scope.level,
    sourceSignature: fresh.sourceSignature,
    force,
    previousSignature: previous?.sourceSignature,
    projectName: scope.projectName,
    sessionName: scope.sessionName,
    conversationId: scope.conversationId,
  });
  return fresh;
}

export interface DiscoverBackendCapabilitiesInput<
  T extends AgentCapabilityCachedInventory,
> {
  cache: AgentCapabilityDiscoveryCache<T>;
  scope: AgentCapabilityScopeContext;
  cascadeKinds: readonly AgentCapabilityCascadeKind[];
  fetcher: (cascadeKind: AgentCapabilityCascadeKind) => Promise<T>;
  refresh?: boolean;
}

interface DiscoveryFailure {
  cascadeKind: AgentCapabilityCascadeKind;
  message: string;
}

export interface DiscoverBackendCapabilitiesResult<
  T extends AgentCapabilityCachedInventory,
> {
  inventories: Partial<Record<AgentCapabilityCascadeKind, T>>;
  failures: readonly DiscoveryFailure[];
}

export async function discoverBackendCapabilities<
  T extends AgentCapabilityCachedInventory,
>(
  input: DiscoverBackendCapabilitiesInput<T>,
): Promise<DiscoverBackendCapabilitiesResult<T>> {
  const { cache, scope, cascadeKinds, fetcher, refresh = false } = input;

  const results = await Promise.allSettled(
    cascadeKinds.map(async (cascadeKind) => {
      const inventory = await runDiscoveryThroughCache({
        cache,
        cascadeKind,
        scope,
        fetcher: () => fetcher(cascadeKind),
        force: refresh,
      });
      return { cascadeKind, inventory };
    }),
  );

  const inventories: Partial<Record<AgentCapabilityCascadeKind, T>> = {};
  const failures: DiscoveryFailure[] = [];

  for (let i = 0; i < results.length; i += 1) {
    const settled = results[i];
    const cascadeKind = cascadeKinds[i]!;
    if (!settled) continue;
    if (settled.status === "fulfilled") {
      inventories[settled.value.cascadeKind] = settled.value.inventory;
      continue;
    }
    const message = redactAgentCapabilityText(getErrorMessage(settled.reason));
    failures.push({ cascadeKind, message });
    logger.warn("discovery.failed", {
      cascadeKind,
      scopeLevel: scope.level,
      error: message,
      projectName: scope.projectName,
      sessionName: scope.sessionName,
      conversationId: scope.conversationId,
    });
  }

  return { inventories, failures };
}
