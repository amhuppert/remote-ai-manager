import { z } from "zod";
import { useQuery } from "@tanstack/react-query";
import { apiFetch } from "@/lib/api/fetcher";
import { contentResponseSchema } from "@/lib/shared/schemas";
import { referenceDocumentKeys } from "./query-keys";

export function useReferenceDocumentsQuery(
  projectName: string,
  sessionName: string,
) {
  return useQuery({
    queryKey: referenceDocumentKeys.list(projectName, sessionName),
    queryFn: async () => {
      const data = await apiFetch(
        `/api/projects/${encodeURIComponent(projectName)}/sessions/${encodeURIComponent(sessionName)}/reference-documents`,
        z.array(
          z.object({
            id: z.string(),
            filePath: z.string(),
            description: z.string(),
            createdAt: z.string(),
          }),
        ),
      );
      return data;
    },
  });
}

export function useReferenceDocumentContentQuery(
  projectName: string,
  sessionName: string,
  documentId: string | null,
) {
  return useQuery({
    queryKey: referenceDocumentKeys.content(
      projectName,
      sessionName,
      documentId ?? "",
    ),
    queryFn: async () => {
      const data = await apiFetch(
        `/api/projects/${encodeURIComponent(projectName)}/sessions/${encodeURIComponent(sessionName)}/reference-documents/${encodeURIComponent(documentId!)}/content`,
        contentResponseSchema,
      );
      return data.content;
    },
    enabled: documentId != null,
  });
}
