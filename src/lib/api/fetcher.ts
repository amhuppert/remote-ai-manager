/**
 * fetcher.ts — Validated fetch helpers.
 *
 * All API responses are validated at the boundary using Zod `parse()`.
 * This replaces the unsafe `res.json() as Promise<T>` pattern.
 */

import type { z } from "zod";
import { ApiCallError } from "@/lib/api/errors";
import { tracedFetch } from "@/lib/shared/traced-fetch";

/**
 * Fetch a GET endpoint and validate the response with a Zod schema.
 */
export async function apiFetch<T>(
  url: string,
  schema: z.ZodType<T>,
): Promise<T> {
  const res = await fetch(url);
  if (!res.ok) {
    const body = await res.json().catch(() => ({ error: "Request failed" }));
    throw new ApiCallError(
      (body as { error?: string }).error ?? `API error ${res.status}`,
    );
  }
  const data: unknown = await res.json();
  return schema.parse(data);
}

/**
 * Fetch a GET endpoint that returns null on 404.
 */
export async function apiFetchOptional<T>(
  url: string,
  schema: z.ZodType<T>,
): Promise<T | null> {
  const res = await fetch(url);
  if (res.status === 404) return null;
  if (!res.ok) {
    throw new ApiCallError(`Failed to fetch`);
  }
  const data: unknown = await res.json();
  return schema.parse(data);
}

/**
 * Fetch a mutation endpoint with tracing and validate the response.
 * When no schema is provided, the raw JSON is returned without validation.
 */
export async function mutationFetch<T>(
  url: string,
  traceLabel: string,
  options: RequestInit,
  schema?: z.ZodType<T>,
): Promise<T> {
  const res = await tracedFetch(url, traceLabel, options);
  if (!res.ok) {
    const body = await res.json().catch(() => ({ error: "Request failed" }));
    const apiBody = body as { error?: string; code?: string; output?: string };
    throw new ApiCallError(
      apiBody.error ?? `API error ${res.status}`,
      apiBody.code,
      apiBody.output,
    );
  }
  const data: unknown = await res.json();
  return schema ? schema.parse(data) : (data as T);
}
