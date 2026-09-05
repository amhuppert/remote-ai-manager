"use client";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { apiFetch, mutationFetch } from "@/lib/api/fetcher";
import {
  bundleTransferSchema,
  type BundleTransfer,
} from "./bundle-transfer-schemas";
import { ticketKeys } from "./query-keys";

export function bundleTransferUrl(project: string, id?: string): string {
  return `/api/projects/${encodeURIComponent(project)}/ticket-bundles${id ? `/${encodeURIComponent(id)}` : ""}`;
}
export function useBundleTransfer(
  project: string,
  transfer: BundleTransfer | null,
) {
  return useQuery({
    queryKey: ["ticket-bundle", project, transfer?.id],
    queryFn: () =>
      apiFetch(bundleTransferUrl(project, transfer?.id), bundleTransferSchema),
    enabled: transfer !== null,
    initialData: transfer ?? undefined,
    refetchInterval: (query) =>
      ["preparing", "importing"].includes(query.state.data?.status ?? "")
        ? 1000
        : false,
  });
}
function fileBase64(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => {
      if (typeof reader.result !== "string") {
        reject(new Error("Cannot read the archive"));
        return;
      }
      resolve(reader.result.slice(reader.result.indexOf(",") + 1));
    };
    reader.onerror = () => reject(new Error("Cannot read the archive"));
    reader.readAsDataURL(file);
  });
}
export function usePrepareBundle() {
  return useMutation({
    mutationFn: async (input: {
      project: string;
      number?: number;
      file?: File;
    }) => {
      if (!input.number && !input.file)
        throw new Error("Choose a ticket bundle");
      if (input.file && input.file.size > 256 * 1024 * 1024)
        throw new Error("Archive exceeds the 256 MiB limit");
      const url = input.number
        ? `/api/projects/${encodeURIComponent(input.project)}/tickets/${input.number}/bundle`
        : bundleTransferUrl(input.project);
      return mutationFetch(
        url,
        "ticket-bundle.prepare",
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(
            input.file ? { archive: await fileBase64(input.file) } : {},
          ),
        },
        bundleTransferSchema,
      );
    },
  });
}
export function useProceedBundle() {
  const client = useQueryClient();
  return useMutation({
    mutationFn: async (input: {
      project: string;
      transfer: BundleTransfer;
      allowDuplicate: boolean;
    }) => {
      const { project, transfer, allowDuplicate } = input;
      const base = bundleTransferUrl(project, transfer.id);
      if (transfer.mode === "import") {
        const result = await mutationFetch(
          `${base}/import`,
          "ticket-bundle.import",
          {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ digest: transfer.digest, allowDuplicate }),
          },
          bundleTransferSchema,
        );
        client.setQueryData(["ticket-bundle", project, transfer.id], result);
        return result;
      }
      const response = await fetch(
        `${base}/download?acknowledge=${encodeURIComponent(transfer.digest ?? "")}`,
      );
      if (!response.ok)
        throw new Error(
          "Could not download the bundle. Retry or prepare it again.",
        );
      const url = URL.createObjectURL(await response.blob());
      const link = document.createElement("a");
      link.href = url;
      link.download = "ticket.cc-ticket.gz";
      document.body.appendChild(link);
      link.click();
      link.remove();
      setTimeout(() => URL.revokeObjectURL(url), 1000);
      return transfer;
    },
    onSuccess: () => {
      void client.invalidateQueries({ queryKey: ticketKeys.lists() });
    },
  });
}
