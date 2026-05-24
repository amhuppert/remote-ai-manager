import { useQuery } from "@tanstack/react-query";
import { apiFetch, apiFetchOptional } from "@/lib/api/fetcher";
import { contentResponseSchema } from "@/lib/shared/schemas";
import { kiroDocKeys } from "./query-keys";
import { kiroDocTreeSchema } from "./schemas";

export function useKiroDocTreeQuery(
  projectName: string,
  sessionName?: string,
  options?: { enabled?: boolean },
) {
  return useQuery({
    queryKey: kiroDocKeys.tree(projectName, sessionName),
    queryFn: () => {
      const params = sessionName
        ? `?session=${encodeURIComponent(sessionName)}`
        : "";
      return apiFetch(
        `/api/projects/${encodeURIComponent(projectName)}/kiro-docs${params}`,
        kiroDocTreeSchema,
      );
    },
    staleTime: 30_000,
    enabled: options?.enabled ?? true,
  });
}

export function useKiroDocFileQuery(
  projectName: string,
  filePath: string | null,
  sessionName?: string,
  options?: { enabled?: boolean },
) {
  return useQuery({
    queryKey: kiroDocKeys.file(projectName, filePath ?? "", sessionName),
    queryFn: async () => {
      const params = new URLSearchParams();
      params.set("path", filePath!);
      if (sessionName) params.set("session", sessionName);
      const data = await apiFetchOptional(
        `/api/projects/${encodeURIComponent(projectName)}/kiro-docs?${params.toString()}`,
        contentResponseSchema,
      );
      return data?.content ?? null;
    },
    staleTime: 60_000,
    enabled: (options?.enabled ?? true) && !!filePath,
  });
}
