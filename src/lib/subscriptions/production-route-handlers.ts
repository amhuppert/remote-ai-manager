import { createAgentAuth } from "@/lib/agent-gateway/token";
import { withTracing } from "@/lib/logging";
import { resolveProjectPath } from "@/lib/projects/resolver";
import { getStateStore } from "@/lib/state-store";
import {
  createSubscriptionRouteHandlers,
  type SubscriptionRouteDeps,
} from "./route-handlers";
import { getSubscriptionService } from "./service-factory";

const deps: SubscriptionRouteDeps = {
  getService: getSubscriptionService,
  resolveProjectPath,
  getSession: (projectPath, sessionName) =>
    getStateStore().getSession(projectPath, sessionName),
  getProjectConversation: (projectPath, conversationId) =>
    getStateStore().getProjectConversation(projectPath, conversationId),
  auth: createAgentAuth(),
};
const session = createSubscriptionRouteHandlers(deps, "session");
const project = createSubscriptionRouteHandlers(deps, "project");

export const sessionSubscriptionListGET = withTracing(session.listGET);
export const sessionSubscriptionUnfollowDELETE = withTracing(
  session.unfollowDELETE,
);
export const sessionInboxListGET = withTracing(session.inboxGET);
export const sessionInboxDetailGET = withTracing(session.deliveryGET);
export const projectSubscriptionListGET = withTracing(project.listGET);
export const projectSubscriptionUnfollowDELETE = withTracing(
  project.unfollowDELETE,
);
export const projectInboxListGET = withTracing(project.inboxGET);
export const projectInboxDetailGET = withTracing(project.deliveryGET);
