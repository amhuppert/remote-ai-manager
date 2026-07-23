import { queryOptions, useQuery } from "@tanstack/react-query";
import { z } from "zod";

import { apiFetch } from "@/lib/api/fetcher";

import {
  deliveryDisplaySchema,
  requirementStatusSchema,
  specPhaseProjectionSchema,
  taskWorkStatusSchema,
} from "./phase";
import { specKeys } from "./query-keys";
import {
  actorProvenanceSchema,
  specAliasSchema,
  specApprovalRowSchema,
  specAssumptionDispositionSchema,
  specCommentRowSchema,
  specCriterionDispositionRowSchema,
  specEvidenceRowSchema,
  specExecutionRowSchema,
  specGateAdmissionRowSchema,
  specProofVerdictRowSchema,
  specQuestionStatusSchema,
  specRevisionElementSchema,
  specRevisionSchema,
  specRevisionSnapshotSchema,
  specSchema,
  specWaiverRowSchema,
} from "./schemas";
import { specStatusViewSchema } from "./view-schemas";

export { specStatusViewSchema };

export const specQuestionViewSchema = z
  .object({
    id: z.string().min(1),
    number: z.number().int().positive(),
    handle: z.string().min(1),
    elementId: z.string().nullable(),
    text: z.string(),
    status: specQuestionStatusSchema,
    answer: z.string().nullable(),
    answeredAt: z.string().nullable(),
    provenance: actorProvenanceSchema.nullable(),
    createdAt: z.string().min(1),
    updatedAt: z.string().min(1),
  })
  .strict();
export type SpecQuestionView = z.infer<typeof specQuestionViewSchema>;

export const specAssumptionViewSchema = z
  .object({
    id: z.string().min(1),
    number: z.number().int().positive(),
    handle: z.string().min(1),
    elementId: z.string().nullable(),
    text: z.string(),
    disposition: specAssumptionDispositionSchema,
    disposedAt: z.string().nullable(),
    proposedBy: actorProvenanceSchema.nullable(),
    createdAt: z.string().min(1),
    updatedAt: z.string().min(1),
  })
  .strict();
export type SpecAssumptionView = z.infer<typeof specAssumptionViewSchema>;

const elementCountsSchema = z
  .object({
    requirements: z.number().int().nonnegative(),
    criteria: z.number().int().nonnegative(),
    decisions: z.number().int().nonnegative(),
    tasks: z.number().int().nonnegative(),
  })
  .strict();

const linkedWorkRollupSchema = z
  .object({
    tickets: z.number().int().nonnegative(),
    conversations: z.number().int().nonnegative(),
    sessions: z.number().int().nonnegative(),
    workflowExecutions: z.number().int().nonnegative(),
    mergeJobs: z.number().int().nonnegative(),
  })
  .strict();

const linkedTicketReadThroughSchema = z
  .object({
    projectName: z.string().min(1),
    number: z.number().int().positive(),
    title: z.string().min(1),
  })
  .strict();

export const specSummaryViewSchema = z
  .object({
    spec: specSchema,
    phase: specPhaseProjectionSchema,
    currentRevision: specRevisionSchema.nullable(),
    counts: elementCountsSchema,
    pendingApprovalCount: z.number().int().nonnegative(),
    approvalState: z.enum(["complete", "pending"]),
    delivery: deliveryDisplaySchema,
    linkedWork: linkedWorkRollupSchema,
  })
  .strict();
export type SpecSummaryView = z.infer<typeof specSummaryViewSchema>;

export const specDetailViewSchema = z
  .object({
    spec: specSchema,
    aliases: z.array(specAliasSchema),
    revisions: z.array(specRevisionSchema),
    baseRevision: specRevisionSnapshotSchema.nullable(),
    currentRevision: specRevisionSnapshotSchema.nullable(),
    currentApprovedRevision: specRevisionSnapshotSchema.nullable(),
    executionRevisionSnapshots: z.array(specRevisionSnapshotSchema),
    approvals: z.array(specApprovalRowSchema),
    comments: z.array(specCommentRowSchema),
    executions: z.array(specExecutionRowSchema),
    criterionDispositions: z.array(specCriterionDispositionRowSchema),
    waivers: z.array(specWaiverRowSchema),
    // Admissions recorded against the executions' revisions, so the UI can
    // present gated actions honestly (granted vs still blocking).
    gateAdmissions: z.array(specGateAdmissionRowSchema).default([]),
    elementStatuses: z
      .object({
        requirements: z.array(
          z
            .object({
              elementId: z.string().min(1),
              status: requirementStatusSchema,
            })
            .strict(),
        ),
        tasks: z.array(
          z
            .object({
              elementId: z.string().min(1),
              status: taskWorkStatusSchema,
            })
            .strict(),
        ),
      })
      .strict(),
    status: specStatusViewSchema,
    linkedTickets: z.array(linkedTicketReadThroughSchema),
    questions: z.array(specQuestionViewSchema).default([]),
    assumptions: z.array(specAssumptionViewSchema).default([]),
  })
  .strict();
export type SpecDetailView = z.infer<typeof specDetailViewSchema>;

const evidenceStateSchema = z
  .object({
    criterionElementId: z.string().min(1),
    handle: z.string().min(1),
    evidence: z.array(specEvidenceRowSchema),
    verdicts: z.array(specProofVerdictRowSchema),
    waiver: specWaiverRowSchema.nullable(),
  })
  .strict();

export const specElementReferenceStateSchema = z
  .object({
    observedRevision: z.number().int().positive(),
    observedPayloadHash: z.string().min(1).nullable(),
    latestContainingRevision: z.number().int().positive(),
    latestPayloadHash: z.string().min(1),
  })
  .strict();
export type SpecElementReferenceState = z.infer<
  typeof specElementReferenceStateSchema
>;

export const specElementViewSchema = z
  .object({
    specId: z.string().min(1),
    slug: z.string().min(1),
    revision: specRevisionSchema,
    handle: z.string().min(1),
    element: specRevisionElementSchema,
    approvals: z.array(specApprovalRowSchema),
    evidenceState: z.array(evidenceStateSchema),
    referenceState: specElementReferenceStateSchema.nullable(),
  })
  .strict();
export type SpecElementView = z.infer<typeof specElementViewSchema>;

const specQuestionElementViewSchema = z
  .object({
    specId: z.string().min(1),
    slug: z.string().min(1),
    kind: z.literal("question"),
    handle: z.string().min(1),
    question: specQuestionViewSchema,
  })
  .strict();

const specAssumptionElementViewSchema = z
  .object({
    specId: z.string().min(1),
    slug: z.string().min(1),
    kind: z.literal("assumption"),
    handle: z.string().min(1),
    assumption: specAssumptionViewSchema,
  })
  .strict();

// The elements/<handle> endpoint serves revision elements and the
// revision-independent Q/A records through one address space; every
// bare-handle consumer parses this union.
export const specElementGetResponseSchema = z.union([
  specElementViewSchema,
  specQuestionElementViewSchema,
  specAssumptionElementViewSchema,
]);
export type SpecElementGetResponse = z.infer<
  typeof specElementGetResponseSchema
>;

const lintFindingSchema = z
  .object({
    ruleId: z.string().min(1),
    severity: z.enum([
      "blocks_propose",
      "blocks_claim",
      "blocks_signoff",
      "advisory",
    ]),
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

export const specInventoryViewSchema = z
  .object({ specs: z.array(specSummaryViewSchema) })
  .strict();
export type SpecInventoryView = z.infer<typeof specInventoryViewSchema>;

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
  inventory: (projectName: string) =>
    queryOptions({
      queryKey: specKeys.list(projectName),
      queryFn: ({ signal }) =>
        apiFetch(
          `/api/specs/${encodeURIComponent(projectName)}`,
          specInventoryViewSchema,
          { signal },
        ),
      refetchOnReconnect: false,
    }),
  detail: (projectName: string, slug: string) =>
    queryOptions({
      queryKey: specKeys.detail(projectName, slug),
      queryFn: ({ signal }) =>
        apiFetch(specBasePath(projectName, slug), specDetailViewSchema, {
          signal,
        }),
      refetchOnReconnect: false,
    }),
  summary: (projectName: string, slug: string) =>
    queryOptions({
      queryKey: specKeys.summary(projectName, slug),
      queryFn: ({ signal }) =>
        apiFetch(
          `${specBasePath(projectName, slug)}/summary`,
          specSummaryViewSchema,
          { signal },
        ),
      refetchOnReconnect: false,
    }),
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
  element: (
    projectName: string,
    slug: string,
    handle: string,
    observedRevision?: number,
    targetRevisionId?: string,
  ) =>
    queryOptions({
      queryKey: specKeys.element(
        projectName,
        slug,
        handle,
        observedRevision,
        targetRevisionId,
      ),
      queryFn: ({ signal }) => {
        const params = new URLSearchParams();
        if (observedRevision !== undefined) {
          params.set("observedRevision", String(observedRevision));
        }
        if (targetRevisionId !== undefined) {
          params.set("revisionId", targetRevisionId);
        }
        const query = params.size === 0 ? "" : `?${params.toString()}`;
        return apiFetch(
          `${specBasePath(projectName, slug)}/elements/${encodeURIComponent(handle)}${query}`,
          specElementGetResponseSchema,
          { signal },
        );
      },
      refetchOnReconnect: false,
    }),
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

export function useSpecSummaryQuery(projectName: string, slug: string) {
  return useQuery(specQueries.summary(projectName, slug));
}

export function useSpecStatusQuery(projectName: string, slug: string) {
  return useQuery(specQueries.status(projectName, slug));
}

export function useTicketSpecReadThroughQuery(
  projectName: string,
  number: number,
) {
  return useQuery(specQueries.ticketReadThrough(projectName, number));
}

export function useSpecElementQuery(
  projectName: string,
  slug: string,
  handle: string,
  observedRevision?: number,
  targetRevisionId?: string,
) {
  return useQuery(
    specQueries.element(
      projectName,
      slug,
      handle,
      observedRevision,
      targetRevisionId,
    ),
  );
}

export function useSpecLintQuery(projectName: string, slug: string) {
  return useQuery(specQueries.lint(projectName, slug));
}

export function useSpecSearchQuery(
  projectName: string,
  slug: string,
  query: string,
) {
  return useQuery(specQueries.search(projectName, slug, query));
}
