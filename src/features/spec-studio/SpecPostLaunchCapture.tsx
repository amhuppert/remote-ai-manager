"use client";

import { useState } from "react";
import { z } from "zod";

import { ApiCallError } from "@/lib/api/errors";
import { createClientLogger } from "@/lib/logging/client-logger";
import { useSpecActionMutation } from "@/lib/specs/mutations";
import type { SpecDetailView } from "@/lib/specs/queries";

import PostLaunchCapturePaths, {
  type CaptureDiscoveredWorkRequest,
  type PostLaunchFailure,
} from "./PostLaunchCapturePaths";

const logger = createClientLogger("spec-studio-delivery-capture");

const captureScopeAmendmentResponseSchema = z
  .object({
    discovery: z
      .object({
        id: z.string().min(1),
        executionId: z.string().min(1),
        attemptId: z.string().min(1).nullable(),
        title: z.string().min(1),
      })
      .strict(),
    restartRequired: z.boolean(),
    replacement: z
      .object({
        abandonedExecutionId: z.string().min(1),
        replacementAttemptId: z.string().min(1),
      })
      .strict()
      .nullable(),
  })
  .strict();

function captureFailure(error: Error | null): PostLaunchFailure | null {
  if (error === null) return null;
  const instruction =
    error instanceof ApiCallError &&
    typeof error.details?.["instruction"] === "string"
      ? error.details["instruction"]
      : null;
  return { message: error.message, instruction };
}

export default function SpecPostLaunchCapture({
  detail,
  projectName,
}: {
  detail: SpecDetailView;
  projectName: string;
}): React.JSX.Element | null {
  const [outcomePath, setOutcomePath] = useState<"discovery" | "replan" | null>(
    null,
  );
  const capture = useSpecActionMutation<
    CaptureDiscoveredWorkRequest,
    z.infer<typeof captureScopeAmendmentResponseSchema>
  >(
    projectName,
    detail.spec.slug,
    "capture-scope-amendment",
    captureScopeAmendmentResponseSchema,
  );
  const execution = [...detail.executions]
    .reverse()
    .find((candidate) => candidate.state === "running");
  if (execution === undefined) return null;

  return (
    <PostLaunchCapturePaths
      projectName={projectName}
      slug={detail.spec.slug}
      executionId={execution.id}
      state="running"
      capturePending={capture.isPending}
      captureOutcomePath={outcomePath}
      captureReceipt={capture.data ?? null}
      captureFailure={captureFailure(capture.error)}
      onCapture={(path, request) => {
        capture.reset();
        setOutcomePath(path);
        logger.info("spec_studio.discovery.capture_requested", {
          specId: detail.spec.id,
          executionId: execution.id,
          blocking: request.blockingReason !== undefined,
        });
        capture.mutate(request, {
          onSuccess: (receipt) => {
            logger.info("spec_studio.discovery.capture_completed", {
              specId: detail.spec.id,
              executionId: receipt.discovery.executionId,
              discoveryId: receipt.discovery.id,
              restartRequired: receipt.restartRequired,
              replacementAttemptId:
                receipt.replacement?.replacementAttemptId ?? null,
            });
          },
          onError: (error) => {
            logger.warn("spec_studio.discovery.capture_failed", {
              specId: detail.spec.id,
              executionId: execution.id,
              blocking: request.blockingReason !== undefined,
              error: error.message,
            });
          },
        });
      }}
    />
  );
}
