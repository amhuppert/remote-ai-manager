import { useQuery } from "@tanstack/react-query";
import { configKeys } from "@/lib/config/query-keys";
import { apiFetch } from "@/lib/api/fetcher";
import {
  configResponseSchema,
  fullConfigResponseSchema,
} from "@/lib/config/schemas";

export function useConfigQuery() {
  return useQuery({
    queryKey: configKeys.all,
    queryFn: () => apiFetch("/api/config", configResponseSchema),
  });
}

export function useFullConfigQuery(options?: { enabled?: boolean }) {
  return useQuery({
    queryKey: configKeys.full(),
    queryFn: () => apiFetch("/api/config", fullConfigResponseSchema),
    enabled: options?.enabled ?? true,
  });
}
