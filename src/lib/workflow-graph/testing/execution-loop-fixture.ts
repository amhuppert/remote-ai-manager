import {
  createGraphWorkflowExecutionServices,
  createGraphWorkflowGates,
  type ExecutionServicesPorts,
} from "../engine-composition";
import { createGraphWorkflowExecutionEventPublisher } from "../execution-events";
import { createLandingEvidenceProber } from "../landing-evidence";
import { createLaneDriftAuditor } from "../lane-drift";
import { resyncSharedIndexToHead } from "@/lib/git/shared-index";
import { readRepoConfig } from "@/lib/projects/repo-config";
import { buildDefaultLiveEditDeps } from "../live-edit-apply";
import { getConfiguredQueryConcurrency } from "@/lib/shared/query-semaphore";
import {
  isConversationBusy,
  acquireConversationLock,
} from "@/lib/prompt/single-flight";
import { clearConversationQuestion } from "@/lib/workflows/conversation/manager";

type FixtureDefaultKeys =
  | "landingEvidenceProber"
  | "laneDriftAuditor"
  | "resyncSharedIndex"
  | "buildLiveEditDeps"
  | "readRepoConfig"
  | "getMaxConcurrentQueries"
  | "eventPublisher"
  | "approvalGateService"
  | "userInputGateService"
  | "isConversationBusy"
  | "acquireConversationLock";
export type ExecutionLoopFixtureDeps = Omit<
  ExecutionServicesPorts,
  FixtureDefaultKeys
> &
  Partial<Pick<ExecutionServicesPorts, FixtureDefaultKeys>>;

export function createExecutionInfrastructureFixture() {
  return {
    landingEvidenceProber: createLandingEvidenceProber(),
    laneDriftAuditor: createLaneDriftAuditor(),
    resyncSharedIndex: resyncSharedIndexToHead,
    buildLiveEditDeps: buildDefaultLiveEditDeps,
    readRepoConfig,
    getMaxConcurrentQueries: getConfiguredQueryConcurrency,
    isConversationBusy,
    acquireConversationLock,
  };
}

export function createExecutionLoopFixture(deps: ExecutionLoopFixtureDeps) {
  const eventPublisher =
    deps.eventPublisher ?? createGraphWorkflowExecutionEventPublisher();
  const gates = createGraphWorkflowGates({
    getActive: deps.executionRepository.getActive,
    mutateActive: deps.executionRepository.mutateActive,
    clearConversationQuestion,
    eventPublisher,
    now: () => new Date().toISOString(),
  });
  return createGraphWorkflowExecutionServices({
    ...deps,
    eventPublisher,
    approvalGateService: deps.approvalGateService ?? gates.approvalGateService,
    userInputGateService:
      deps.userInputGateService ?? gates.userInputGateService,
    landingEvidenceProber:
      deps.landingEvidenceProber ?? createLandingEvidenceProber(),
    laneDriftAuditor: deps.laneDriftAuditor ?? createLaneDriftAuditor(),
    resyncSharedIndex: deps.resyncSharedIndex ?? resyncSharedIndexToHead,
    buildLiveEditDeps: deps.buildLiveEditDeps ?? buildDefaultLiveEditDeps,
    readRepoConfig: deps.readRepoConfig ?? readRepoConfig,
    getMaxConcurrentQueries:
      deps.getMaxConcurrentQueries ?? getConfiguredQueryConcurrency,
    isConversationBusy: deps.isConversationBusy ?? isConversationBusy,
    acquireConversationLock:
      deps.acquireConversationLock ?? acquireConversationLock,
  });
}
