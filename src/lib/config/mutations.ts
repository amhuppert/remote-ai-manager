import { useMutation, useQueryClient } from "@tanstack/react-query";
import { configKeys } from "@/lib/config/query-keys";
import { mutationFetch } from "@/lib/api/fetcher";
import { fullConfigResponseSchema } from "@/lib/config/schemas";
import type { GlobalConfig } from "@/lib/config/schemas";
export function useUpdateConfigMutation() {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: (data: Partial<GlobalConfig>) =>
      mutationFetch(
        "/api/config",
        "update-config",
        {
          method: "PUT",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(data),
        },
        fullConfigResponseSchema,
      ),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: configKeys.all });
    },
  });
}
