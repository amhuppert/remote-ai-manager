import { z } from "zod";
import { useQuery } from "@tanstack/react-query";
import { apiFetch } from "@/lib/api/fetcher";
import { documentCommentKeys } from "./query-keys";
import { documentCommentSchema } from "./schemas";

const documentCommentsResponseSchema = z.array(documentCommentSchema);

/**
 * Load the comment list for one document, keyed by its worktree-relative
 * `docPath`. Disabled until a document path is available so switching tabs to
 * "no active document" does not fire a request.
 */
export function useDocumentCommentsQuery(
  projectName: string,
  sessionName: string,
  docPath: string | null,
) {
  return useQuery({
    queryKey: documentCommentKeys.list(projectName, sessionName, docPath ?? ""),
    queryFn: () =>
      apiFetch(
        `/api/projects/${encodeURIComponent(projectName)}/sessions/${encodeURIComponent(sessionName)}/document-comments?docPath=${encodeURIComponent(docPath!)}`,
        documentCommentsResponseSchema,
      ),
    enabled: docPath != null && docPath !== "",
  });
}
