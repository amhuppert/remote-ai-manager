import { queryOptions, useQuery } from "@tanstack/react-query";
import { z } from "zod";

import { apiFetch } from "@/lib/api/fetcher";

import { specPhaseProjectionSchema } from "./phase";
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
  })
  .strict();

const linkedSpecReadThroughSchema = z
  .object({
    specId: z.string().min(1),
    slug: z.string().min(1),
    name: z.string(),
    revision: z.number().int().positive(),
    phase: specPhaseProjectionSchema,
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
