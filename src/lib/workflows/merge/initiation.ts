import {
  currentRunRefusal,
  type CurrentRun,
  type CurrentRunRefusal,
} from "@/lib/runs/session-guard";
import {
  backgroundWorkRefusal,
  type BackgroundWorkRefusal,
  type SessionBackgroundWork,
} from "./background-work-guard";
import { createLogger } from "@/lib/logging";

const logger = createLogger("merge.initiation");

export interface MergeInitiationInput {
  projectPath: string;
  projectName?: string;
  sessionName: string;
  surface: string;
  readCurrentRuns(
    projectPath: string,
    sessionName: string,
  ): readonly CurrentRun[];
  readBackgroundWork(
    projectPath: string,
    sessionName: string,
  ): readonly SessionBackgroundWork[];
}
export type MergeInitiation =
  | { admitted: true }
  | { admitted: false; refusal: CurrentRunRefusal | BackgroundWorkRefusal };

export async function evaluateMergeInitiation(
  input: MergeInitiationInput,
): Promise<MergeInitiation> {
  const runRefusal = currentRunRefusal(
    input.readCurrentRuns(input.projectPath, input.sessionName),
    "merging this session",
  );
  if (runRefusal !== null) {
    logger.warn("merge.initiation.run_current_refused", {
      projectPath: input.projectPath,
      sessionName: input.sessionName,
      surface: input.surface,
      runId: runRefusal.runId,
      runProgress: runRefusal.progress,
    });
    return { admitted: false, refusal: runRefusal };
  }
  const workRefusal = backgroundWorkRefusal(
    input.readBackgroundWork(input.projectPath, input.sessionName),
    "merging this session",
  );
  if (workRefusal !== null) {
    logger.warn("merge.initiation.background_work_refused", {
      projectPath: input.projectPath,
      sessionName: input.sessionName,
      surface: input.surface,
      conversationId: workRefusal.conversationId,
    });
    return { admitted: false, refusal: workRefusal };
  }
  return { admitted: true };
}
