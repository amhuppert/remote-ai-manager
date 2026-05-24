import { useQuery } from "@tanstack/react-query";
import { apiFetch } from "@/lib/api/fetcher";
import { presetsResponseSchema } from "@/lib/presets/schemas";
import { presetKeys } from "@/lib/dev-server/query-keys";

export function usePresetsQuery(projectName: string) {
  return useQuery({
    queryKey: presetKeys.list(projectName),
    queryFn: () =>
      apiFetch(
        `/api/projects/${encodeURIComponent(projectName)}/dev-servers/presets`,
        presetsResponseSchema,
      ).then((r) => r.presets),
  });
}
