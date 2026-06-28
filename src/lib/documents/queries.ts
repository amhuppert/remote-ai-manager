import { useQuery } from "@tanstack/react-query";
import { apiFetch } from "@/lib/api/fetcher";
import { ApiCallError } from "@/lib/api/errors";
import { documentContentKeys } from "./query-keys";
import { documentContentResponseSchema } from "./schemas";

/**
 * Load the markdown content of any file in the session worktree by its
 * worktree-relative (or absolute-inside-worktree) `docPath`. The endpoint
 * echoes the normalized `docPath` alongside the content so the viewer keys
 * comments/anchoring by the canonical identity. Disabled until a path is
 * available. Loading/error state comes from React Query; the distinct error
 * kinds are derived from the failed response via `classifyDocumentContentError`.
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
 * - `unavailable` (404) — the file is missing or its absolute path is outside
 *   the worktree; the viewer/file card shows "outside this worktree —
 *   unavailable".
 * - `invalid` (400) — a non-markdown or path-traversal path.
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
