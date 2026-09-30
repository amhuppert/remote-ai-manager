import { createAgentAuth } from "@/lib/agent-gateway/token";
import { withTracing } from "@/lib/logging";
import { resolveProjectPath } from "@/lib/projects/resolver";
import { getStateStore } from "@/lib/state-store";
import {
  createSubscriptionRouteHandlers,
  type SubscriptionRouteDeps,
} from "./route-handlers";
import {
  getActiveWaitService,
  getSubscriptionService,
} from "./service-factory";
import { registerActiveSubscriptionWait } from "./active-wait-production";

const deps: SubscriptionRouteDeps = {
  getService: getSubscriptionService,
  getWaitService: () => {
    const service = getActiveWaitService();
    return { ...service, register: registerActiveSubscriptionWait };
  },
  now: () => new Date().toISOString(),
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
export const sessionSubscriptionWaitPOST = withTracing(session.waitPOST);
export const sessionSubscriptionWaitsGET = withTracing(session.waitsGET);
export const sessionSubscriptionWaitDetailGET = withTracing(session.waitGET);
export const projectSubscriptionWaitPOST = withTracing(project.waitPOST);
export const projectSubscriptionWaitsGET = withTracing(project.waitsGET);
export const projectSubscriptionWaitDetailGET = withTracing(project.waitGET);
