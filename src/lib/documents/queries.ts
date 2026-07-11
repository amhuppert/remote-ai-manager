import { useQuery } from "@tanstack/react-query";
import { apiFetch } from "@/lib/api/fetcher";
import { ApiCallError } from "@/lib/api/errors";
import { documentContentKeys, markdownDocumentKeys } from "./query-keys";
import {
  documentContentResponseSchema,
  markdownDocumentsResponseSchema,
} from "./schemas";

export function useMarkdownDocumentsQuery(
  projectName: string,
  sessionName: string,
) {
  return useQuery({
    queryKey: markdownDocumentKeys.list(projectName, sessionName),
    queryFn: () =>
      apiFetch(
        `/api/projects/${encodeURIComponent(projectName)}/sessions/${encodeURIComponent(sessionName)}/markdown-documents`,
        markdownDocumentsResponseSchema,
      ),
  });
}

/**
 * Load Markdown content by its canonical worktree-relative or authorized
 * external `docPath`. The endpoint echoes the normalized identity so the
 * viewer keys content consistently. Disabled until a path is available.
 * Loading/error state comes from React Query; the distinct error kinds are
 * derived from the failed response via `classifyDocumentContentError`.
 */
export function useDocumentContentQuery(
  projectName: string,
  sessionName: string,
  docPath: string | null,
) {
  return useQuery({
    queryKey: documentContentKeys.content(
      projectName,
      sessionName,
      docPath ?? "",
    ),
    queryFn: () =>
      apiFetch(
        `/api/projects/${encodeURIComponent(projectName)}/sessions/${encodeURIComponent(sessionName)}/document-content?path=${encodeURIComponent(docPath!)}`,
        documentContentResponseSchema,
      ),
    enabled: docPath != null && docPath !== "",
  });
}

/** Distinguishable content-load failure kinds for the viewer/file-card UI. */
export type DocumentContentErrorKind = "unavailable" | "invalid" | "error";

/**
 * Classify a `useDocumentContentQuery` error into a UI-actionable kind:
 * - `unavailable` (404) — the file is missing or is not authorized for the
 *   session.
 * - `invalid` (400) — a non-Markdown path.
 * - `error` — any other failure (read error, network, non-API error).
 */
export function classifyDocumentContentError(
  error: unknown,
): DocumentContentErrorKind {
  if (error instanceof ApiCallError) {
    if (error.status === 404) return "unavailable";
    if (error.status === 400) return "invalid";
  }
  return "error";
}
