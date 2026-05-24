import { useMutation, useQueryClient } from "@tanstack/react-query";
import { mutationFetch } from "@/lib/api/fetcher";
import { installPresetResponseSchema } from "@/lib/presets/schemas";
import { presetKeys } from "@/lib/dev-server/query-keys";

export function useInstallPresetMutation(projectName: string) {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: (params: { presetId: string; subdir?: string }) =>
      mutationFetch(
        `/api/projects/${encodeURIComponent(projectName)}/dev-servers/presets/install`,
        "install-preset",
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(params),
        },
        installPresetResponseSchema,
      ),
    onSuccess: () => {
      void queryClient.invalidateQueries({
        queryKey: presetKeys.list(projectName),
      });
    },
  });
}
