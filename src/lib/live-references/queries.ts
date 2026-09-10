"use client";

import { queryOptions, useQuery } from "@tanstack/react-query";
import { apiFetch } from "@/lib/api/fetcher";
import { createClientLogger } from "@/lib/logging/client-logger";
import {
  liveReferenceKey,
  liveReferenceResponseSchema,
  type LiveReferenceResult,
  type LiveReferenceTarget,
} from "./schemas";

const logger = createClientLogger("live-references");
type PendingRead = {
  target: LiveReferenceTarget;
  resolve(result: LiveReferenceResult): void;
  reject(error: unknown): void;
};
let pending: PendingRead[] = [];
let timer: ReturnType<typeof setTimeout> | undefined;

async function flushReads(): Promise<void> {
  timer = undefined;
  const batch = pending;
  pending = [];
  for (let offset = 0; offset < batch.length; offset += 100) {
    const chunk = batch.slice(offset, offset + 100);
    try {
      const response = await apiFetch(
        "/api/live-references",
        liveReferenceResponseSchema,
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ targets: chunk.map((item) => item.target) }),
          signal: AbortSignal.timeout(5000),
        },
      );
      const byKey = new Map(
        response.results.map((result) => [
          liveReferenceKey(result.target),
          result,
        ]),
      );
      for (const item of chunk) {
        const result = byKey.get(liveReferenceKey(item.target));
        if (
          !result ||
          result.unavailableReason === "error" ||
          result.unavailableReason === "timeout"
        )
          item.reject(new Error("Current state unavailable"));
        else item.resolve(result);
      }
    } catch (error) {
      logger.warn("live_reference.batch_failed", {
        count: chunk.length,
        error: String(error),
      });
      chunk.forEach((item) => item.reject(error));
    }
  }
}

export function liveReferenceQuery(target: LiveReferenceTarget) {
  return queryOptions({
    queryKey: ["live-references", liveReferenceKey(target)],
    queryFn: ({ signal }) =>
      new Promise<LiveReferenceResult>((resolve, reject) => {
        const cancel = () => {
          pending = pending.filter((entry) => entry !== item);
          reject(signal.reason ?? new Error("Reference read cancelled"));
        };
        const item: PendingRead = {
          target,
          resolve(result) {
            signal.removeEventListener("abort", cancel);
            resolve(result);
          },
          reject(error) {
            signal.removeEventListener("abort", cancel);
            reject(error);
          },
        };
        signal.addEventListener("abort", cancel, { once: true });
        pending.push(item);
        timer ??= setTimeout(() => void flushReads(), 10);
      }),
    staleTime: 2000,
    refetchInterval: 3000,
    retry: false,
    refetchOnWindowFocus: "always",
    refetchOnReconnect: "always",
  });
}

export function useLiveReference(target: LiveReferenceTarget, enabled = true) {
  return useQuery({ ...liveReferenceQuery(target), enabled });
}
