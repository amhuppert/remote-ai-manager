import type { QueryClient, QueryKey } from "@tanstack/react-query";

import type { SpecSseEvent } from "@/lib/api/sse-events";
import {
  pendingSpecOverlayFor,
  rememberDeferredSpecEvent,
  type SpecPendingOverlay,
} from "./pending-overlay";

export const specSseCacheKeys = {
  all: ["specs"] as const,
  lists: () => ["specs", "list"] as const,
  summaries: () => ["specs", "summary"] as const,
  summary: (projectPath: string, specSlug: string) =>
    ["specs", "summary", projectPath, specSlug] as const,
  details: () => ["specs", "detail"] as const,
  detail: (projectPath: string, specSlug: string) =>
    ["specs", "detail", projectPath, specSlug] as const,
} as const;

export type SpecCacheFacet =
  | "approval"
  | "attention"
  | "content"
  | "evidence"
  | "execution"
  | "lint"
  | "revision"
  | "summary";

export interface SpecCacheReduction {
  clearApprovalBanner: boolean;
  deferInvalidation: boolean;
  facets: readonly SpecCacheFacet[];
}

const facetsByEventType = {
  "spec-changed": ["content", "lint", "summary"],
  "spec-revision-changed": ["approval", "content", "revision", "summary"],
  "spec-approval-changed": ["approval", "attention", "summary"],
  "spec-execution-changed": ["attention", "execution", "summary"],
  "spec-evidence-changed": ["evidence", "execution", "summary"],
  "spec-attention-changed": ["attention", "summary"],
} as const satisfies Record<SpecSseEvent["type"], readonly SpecCacheFacet[]>;

export function reduceSpecSseEvent(
  event: SpecSseEvent,
  overlay: SpecPendingOverlay | null,
): SpecCacheReduction {
  return {
    clearApprovalBanner: event.type === "spec-approval-changed",
    deferInvalidation: overlay?.eventTypes.includes(event.type) ?? false,
    facets: facetsByEventType[event.type],
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function recordMatchesSpec(
  value: Record<string, unknown>,
  event: SpecSseEvent,
): boolean {
  if (value.specId === event.specId || value.id === event.specId) return true;
  if (
    value.projectPath === event.projectPath &&
    value.slug === event.specSlug
  ) {
    return true;
  }

  const nestedSpec = value.spec;
  return (
    isRecord(nestedSpec) &&
    (nestedSpec.id === event.specId ||
      (nestedSpec.projectPath === event.projectPath &&
        nestedSpec.slug === event.specSlug))
  );
}

export function clearApprovalBannerForEvent(
  cached: unknown,
  event: SpecSseEvent,
): unknown {
  if (event.type !== "spec-approval-changed") return cached;

  if (Array.isArray(cached)) {
    let changed = false;
    const next = cached.map((entry) => {
      const reduced = clearApprovalBannerForEvent(entry, event);
      changed ||= reduced !== entry;
      return reduced;
    });
    return changed ? next : cached;
  }

  if (!isRecord(cached)) return cached;

  let next = cached;
  const items = cached.items;
  if (Array.isArray(items)) {
    const reducedItems = clearApprovalBannerForEvent(items, event);
    if (reducedItems !== items) next = { ...next, items: reducedItems };
  }

  if (
    recordMatchesSpec(cached, event) &&
    Object.hasOwn(cached, "approvalBanner") &&
    cached.approvalBanner !== null
  ) {
    next = { ...next, approvalBanner: null };
  }

  return next;
}

function patchApprovalBannerCaches(
  queryClient: QueryClient,
  event: SpecSseEvent,
): void {
  for (const [queryKey, cached] of queryClient.getQueriesData({
    queryKey: specSseCacheKeys.all,
  })) {
    const next = clearApprovalBannerForEvent(cached, event);
    if (next !== cached) queryClient.setQueryData(queryKey, next);
  }
}

function invalidateSpecSurfaces(
  queryClient: QueryClient,
  event: SpecSseEvent,
): void {
  const queryKeys: QueryKey[] = [
    specSseCacheKeys.lists(),
    specSseCacheKeys.summary(event.projectPath, event.specSlug),
    specSseCacheKeys.detail(event.projectPath, event.specSlug),
  ];
  for (const queryKey of queryKeys) {
    void queryClient.invalidateQueries({ queryKey });
  }
}

export function applySpecSseEvent(
  queryClient: QueryClient,
  event: SpecSseEvent,
): void {
  const overlay = pendingSpecOverlayFor(queryClient, event.specId);
  const reduction = reduceSpecSseEvent(event, overlay);

  if (reduction.clearApprovalBanner) {
    patchApprovalBannerCaches(queryClient, event);
  }

  if (reduction.deferInvalidation) {
    rememberDeferredSpecEvent(queryClient, event);
    return;
  }

  invalidateSpecSurfaces(queryClient, event);
}

export function replayDeferredSpecEvents(
  queryClient: QueryClient,
  events: readonly SpecSseEvent[],
): void {
  for (const event of events) applySpecSseEvent(queryClient, event);
}
