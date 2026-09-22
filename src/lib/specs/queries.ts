import { deliveryReviewViewSchema } from "./delivery-review-schemas";
import { queryOptions, useQuery } from "@tanstack/react-query";
import { z } from "zod";

import { apiFetch, apiFetchOptional } from "@/lib/api/fetcher";

import { specPhaseProjectionSchema, taskWorkStatusSchema } from "./phase";
import { deliveryDeltaProjectionSchema } from "./delivery-delta";
import { deliveryPlanReviewViewSchema } from "./delivery-plan-review";
import {
  deliveryPlanPreviewViewSchema,
  deliveryPlanSnapshotDiffViewSchema,
  type DeliveryPlanPreviewStage,
} from "./delivery-plan-views";
import { specKeys } from "./query-keys";
import { specReferenceQueries } from "./reference-queries";
import {
  integrityReportSchema,
  specDetailViewSchema,
  specStatusViewSchema,
  type SpecDetailView,
} from "./view-schemas";

export { specDetailViewSchema, specStatusViewSchema };
export { specSummaryViewSchema } from "./reference-view-schemas";
export type { SpecDetailView };
export type {
  SpecElementGetResponse,
  SpecElementView,
  SpecSummaryView,
} from "./reference-view-schemas";

const lintFindingSchema = z
  .object({
    ruleId: z.string().min(1),
    severity: z.enum(["blocks_propose", "blocks_signoff", "advisory"]),
    elementHandle: z.string(),
    message: z.string(),
  })
  .strict();

export const specLintViewSchema = z
  .object({
    revisionId: z.string().min(1),
    findings: z.array(lintFindingSchema),
  })
  .strict();

const specSearchResultSchema = z
  .object({
    handle: z.string().min(1),
    kind: z.enum(["section", "requirement", "criterion", "decision", "task"]),
    elementId: z.string().min(1),
    text: z.string(),
  })
  .strict();

export const specSearchViewSchema = z
  .object({ query: z.string(), results: z.array(specSearchResultSchema) })
  .strict();

const linkedTaskReadThroughSchema = z
  .object({
    taskElementId: z.string().min(1),
    taskHandle: z.string().min(1).nullable(),
    sourceTaskState: z.enum(["current", "removed", "changed"]),
    workStatus: taskWorkStatusSchema.shape.status,
  })
  .strict();

const linkedSpecReadThroughSchema = z
  .object({
    specId: z.string().min(1),
    slug: z.string().min(1),
    name: z.string(),
    revision: z.number().int().positive(),
    phase: specPhaseProjectionSchema,
    criteriaProgress: z
      .object({
        proven: z.number().int().nonnegative(),
        total: z.number().int().nonnegative(),
      })
      .strict(),
    linkedTasks: z.array(linkedTaskReadThroughSchema),
  })
  .strict();

export const ticketSpecReadThroughSchema = z
  .object({
    specs: z.array(linkedSpecReadThroughSchema),
  })
  .strict();
export type TicketSpecReadThrough = z.infer<typeof ticketSpecReadThroughSchema>;

function specBasePath(projectName: string, slug: string): string {
  return `/api/specs/${encodeURIComponent(projectName)}/${encodeURIComponent(slug)}`;
}

export const specQueries = {
  deliveryReview: (projectName: string, slug: string, executionId?: string) =>
    queryOptions({
      queryKey: specKeys.deliveryReview(projectName, slug, executionId),
      queryFn: ({ signal }) =>
        apiFetch(
          `${specBasePath(projectName, slug)}/delivery-review${executionId ? `?execution=${encodeURIComponent(executionId)}` : ""}`,
          deliveryReviewViewSchema.nullable(),
          { signal },
        ),
      refetchOnReconnect: false,
    }),
  inventory: specReferenceQueries.inventory,
  detail: (projectName: string, slug: string) =>
    queryOptions({
      queryKey: specKeys.detail(projectName, slug),
      queryFn: ({ signal }) =>
        apiFetch(specBasePath(projectName, slug), specDetailViewSchema, {
          signal,
        }),
      refetchOnReconnect: false,
    }),
  summary: specReferenceQueries.summary,
  status: (projectName: string, slug: string) =>
    queryOptions({
      queryKey: specKeys.status(projectName, slug),
      queryFn: ({ signal }) =>
        apiFetch(
          `${specBasePath(projectName, slug)}/status`,
          specStatusViewSchema,
          { signal },
        ),
      refetchOnReconnect: false,
    }),
  ticketReadThrough: (projectName: string, number: number) =>
    queryOptions({
      queryKey: specKeys.ticketReadThrough(projectName, number),
      queryFn: ({ signal }) =>
        apiFetch(
          `/api/specs/${encodeURIComponent(projectName)}/ticket-read-through/${number}`,
          ticketSpecReadThroughSchema,
          { signal },
        ),
      refetchOnReconnect: false,
    }),
  element: specReferenceQueries.element,
  lint: (projectName: string, slug: string) =>
    queryOptions({
      queryKey: specKeys.lint(projectName, slug),
      queryFn: ({ signal }) =>
        apiFetch(
          `${specBasePath(projectName, slug)}/lint`,
          specLintViewSchema,
          { signal },
        ),
      refetchOnReconnect: false,
    }),
  // The delivery delta is a pure server projection over immutable revisions, so
  // it is plain cached read state: no SSE channel pushes it and nothing polls.
  delta: (projectName: string, slug: string, sinceExecutionId?: string) =>
    queryOptions({
      queryKey: specKeys.delta(projectName, slug, sinceExecutionId),
      queryFn: ({ signal }) => {
        const query =
          sinceExecutionId === undefined
            ? ""
            : `?since=${encodeURIComponent(sinceExecutionId)}`;
        return apiFetch(
          `${specBasePath(projectName, slug)}/delta${query}`,
          deliveryDeltaProjectionSchema,
          { signal },
        );
      },
      refetchOnReconnect: false,
    }),
  // The delivery-plan attempt as a reviewer reads it. Like the delta it is a
  // pure server projection over an immutable pin, so it is plain cached read
  // state; a plan mutation invalidates the key rather than pushing to it.
  planReview: (projectName: string, slug: string) =>
    queryOptions({
      queryKey: specKeys.planReview(projectName, slug),
      queryFn: () =>
        apiFetchOptional(
          `${specBasePath(projectName, slug)}/plan/review`,
          deliveryPlanReviewViewSchema,
        ),
      refetchOnReconnect: false,
    }),
  // Cached on the draft revision it was read for: the preview describes one
  // attempt state, and a caller that names a different one is refused rather
  // than served the bytes it did not ask for.
  planPreview: (
    projectName: string,
    slug: string,
    stage: DeliveryPlanPreviewStage,
    expectedDraftRevision?: number,
  ) =>
    queryOptions({
      queryKey: specKeys.planPreview(
        projectName,
        slug,
        stage,
        expectedDraftRevision,
      ),
      queryFn: ({ signal }) => {
        const params = new URLSearchParams({ stage });
        if (expectedDraftRevision !== undefined) {
          params.set("expectedDraftRevision", String(expectedDraftRevision));
        }
        return apiFetch(
          `${specBasePath(projectName, slug)}/plan-preview?${params.toString()}`,
          deliveryPlanPreviewViewSchema,
          { signal },
        );
      },
      refetchOnReconnect: false,
    }),
  // A comparison of two immutable snapshots: the answer can never change for a
  // given pair, so it is cached on the pair itself.
  planDiff: (
    projectName: string,
    slug: string,
    fromSnapshotId: string,
    toSnapshotId: string,
  ) =>
    queryOptions({
      queryKey: specKeys.planDiff(
        projectName,
        slug,
        fromSnapshotId,
        toSnapshotId,
      ),
      queryFn: ({ signal }) => {
        const params = new URLSearchParams({
          from: fromSnapshotId,
          to: toSnapshotId,
        });
        return apiFetch(
          `${specBasePath(projectName, slug)}/plan/diff?${params.toString()}`,
          deliveryPlanSnapshotDiffViewSchema,
          { signal },
        );
      },
      refetchOnReconnect: false,
    }),
  // Verification recomputes hashes and writes nothing, so it is read state that
  // happens to sit behind the POST action surface. The cache — not a requesting
  // component — has to own the report, because the panel that asks for it can
  // remount before the answer arrives.
  integrity: (projectName: string, slug: string) =>
    queryOptions({
      queryKey: specKeys.integrity(projectName, slug),
      queryFn: ({ signal }) =>
        apiFetch(
          `${specBasePath(projectName, slug)}/actions/verify`,
          integrityReportSchema,
          {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: "{}",
            signal,
          },
        ),
      refetchOnReconnect: false,
    }),
  search: (projectName: string, slug: string, query: string) =>
    queryOptions({
      queryKey: specKeys.search(projectName, slug, query),
      queryFn: ({ signal }) => {
        const params = new URLSearchParams({ q: query });
        return apiFetch(
          `${specBasePath(projectName, slug)}/search?${params.toString()}`,
          specSearchViewSchema,
          { signal },
        );
      },
      refetchOnReconnect: false,
    }),
} as const;

export function useSpecInventoryQuery(projectName: string) {
  return useQuery({
    ...specQueries.inventory(projectName),
    enabled: projectName.length > 0,
  });
}

export function useSpecDetailQuery(projectName: string, slug: string) {
  return useQuery(specQueries.detail(projectName, slug));
}

export function useTicketSpecReadThroughQuery(
  projectName: string,
  number: number,
) {
  return useQuery(specQueries.ticketReadThrough(projectName, number));
}

export function useSpecLintQuery(projectName: string, slug: string) {
  return useQuery(specQueries.lint(projectName, slug));
}

export function useSpecDeltaQuery(
  projectName: string,
  slug: string,
  sinceExecutionId?: string,
) {
  return useQuery(specQueries.delta(projectName, slug, sinceExecutionId));
}

export function useSpecPlanReviewQuery(projectName: string, slug: string) {
  return useQuery(specQueries.planReview(projectName, slug));
}
