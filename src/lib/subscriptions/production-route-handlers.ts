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
  getSubscriptionRuntime,
  getSubscriptionControlsService,
} from "./service-factory";
import { registerActiveSubscriptionWait } from "./active-wait-production";

import { createSubscriptionControlsHandlers } from "./controls-route-handlers";
import { getSubscriptionOverviewService } from "./overview-production";

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
function controlsFor(resolve: typeof session.resolve) {
  return createSubscriptionControlsHandlers({
    resolve,
    getControls: getSubscriptionControlsService,
    getDetail: (recipient, id) =>
      getSubscriptionOverviewService().detail(recipient, id),
    pendingCount: async (recipient) =>
      getSubscriptionRuntime().repo.pendingCount(recipient),
    now: deps.now,
  });
}
const sessionControls = controlsFor(session.resolve);
const projectControls = controlsFor(project.resolve);

export const sessionSubscriptionListGET = withTracing(session.listGET);
export const sessionSubscriptionUnfollowDELETE = withTracing(
  sessionControls.unfollowDELETE,
);
export const sessionInboxListGET = withTracing(session.inboxGET);
export const sessionInboxDetailGET = withTracing(session.deliveryGET);
export const projectSubscriptionListGET = withTracing(project.listGET);
export const projectSubscriptionUnfollowDELETE = withTracing(
  projectControls.unfollowDELETE,
);
export const projectInboxListGET = withTracing(project.inboxGET);
export const projectInboxDetailGET = withTracing(project.deliveryGET);
export const sessionSubscriptionWaitPOST = withTracing(session.waitPOST);
export const sessionSubscriptionWaitsGET = withTracing(session.waitsGET);
export const sessionSubscriptionWaitDetailGET = withTracing(session.waitGET);
export const projectSubscriptionWaitPOST = withTracing(project.waitPOST);
export const projectSubscriptionWaitsGET = withTracing(project.waitsGET);
export const projectSubscriptionWaitDetailGET = withTracing(project.waitGET);

export const sessionSubscriptionPOST = withTracing(
  sessionControls.subscribePOST,
);
export const sessionSubscriptionDetailGET = withTracing(
  sessionControls.detailGET,
);
export const sessionSubscriptionControlPATCH = withTracing(
  sessionControls.controlPATCH,
);
export const sessionInboxSummaryGET = withTracing(sessionControls.summaryGET);
export const sessionInboxPreferencesGET = withTracing(
  sessionControls.preferencesGET,
);
export const sessionInboxPreferencesPATCH = withTracing(
  sessionControls.preferencesPATCH,
);
export const sessionInboxReadPATCH = withTracing(sessionControls.readPATCH);
export const projectSubscriptionPOST = withTracing(
  projectControls.subscribePOST,
);
export const projectSubscriptionDetailGET = withTracing(
  projectControls.detailGET,
);
export const projectSubscriptionControlPATCH = withTracing(
  projectControls.controlPATCH,
);
export const projectInboxSummaryGET = withTracing(projectControls.summaryGET);
export const projectInboxPreferencesGET = withTracing(
  projectControls.preferencesGET,
);
export const projectInboxPreferencesPATCH = withTracing(
  projectControls.preferencesPATCH,
);
export const projectInboxReadPATCH = withTracing(projectControls.readPATCH);
