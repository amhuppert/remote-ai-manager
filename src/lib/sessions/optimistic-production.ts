import { executePromptStream } from "../prompt/sdk-driver";
import { currentRuns, sessionBackgroundWork } from "@/lib/supervision/handles";
import { dispatchMergeJob } from "../jobs/queue";
import { createJobNotification } from "../notifications/service";
import { evaluateMergeInitiation as evaluateSessionMergeAdmission } from "@/lib/workflows/merge/initiation";
import { sleep } from "@/lib/shared/sleep";
import type { OptimisticDeps } from "./optimistic";

export const defaultOptimisticDeps: OptimisticDeps = {
  executePromptStream,
  dispatchMergeJob,
  createNotification: createJobNotification,
  sleep,
  evaluateSessionMergeAdmission(input) {
    return evaluateSessionMergeAdmission({
      ...input,
      surface: "optimistic",
      readCurrentRuns: currentRuns,
      readBackgroundWork: sessionBackgroundWork,
    });
  },
};
