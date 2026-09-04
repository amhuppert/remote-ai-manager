import { createAgentAuth } from "@/lib/agent-gateway/token";
import { readConfig } from "@/lib/config/loader";
import { withTracing } from "@/lib/logging";
import { resolveProjectPath } from "@/lib/projects/resolver";
import { readRepoConfig } from "@/lib/projects/repo-config";
import { createProductionDeliveryPlanPreflightPort } from "@/lib/specs/delivery-plan-preflight";
import { getSession } from "@/lib/state-store";
import { createGraphWorkflowValidateHandlers } from "@/lib/workflow-graph/validate-route-handlers";

const handlers = createGraphWorkflowValidateHandlers({
  auth: createAgentAuth(),
  resolveProjectPath,
  getSession,
  readRepoConfig,
  readConfig,
  managedDefinitionPreflight: createProductionDeliveryPlanPreflightPort(),
});

/** POST /api/projects/[name]/sessions/[session]/graph-workflow/validate */
export const POST = withTracing(handlers.POST);
