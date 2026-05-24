import { withTracing } from "@/lib/logging";
import { broadcast } from "@/lib/events/broadcaster";

import { defaultCapabilityRouteDeps } from "./route-defaults";
import {
  createConversationCapabilityHandlers,
  createGlobalCapabilityHandlers,
  createProjectCapabilityHandlers,
  createSessionCapabilityHandlers,
} from "./route-handlers";

const globalHandlers = createGlobalCapabilityHandlers({
  ...defaultCapabilityRouteDeps,
  broadcast,
});

const projectHandlers = createProjectCapabilityHandlers({
  ...defaultCapabilityRouteDeps,
  broadcast,
});

const sessionHandlers = createSessionCapabilityHandlers({
  ...defaultCapabilityRouteDeps,
  broadcast,
});

const conversationHandlers = createConversationCapabilityHandlers({
  ...defaultCapabilityRouteDeps,
  broadcast,
});

export const globalGET = withTracing(globalHandlers.GET);
export const globalPATCH = withTracing(globalHandlers.PATCH);
export const globalPOST = withTracing(globalHandlers.POST);

export const projectGET = withTracing(projectHandlers.GET);
export const projectPATCH = withTracing(projectHandlers.PATCH);
export const projectPOST = withTracing(projectHandlers.POST);

export const sessionGET = withTracing(sessionHandlers.GET);
export const sessionPATCH = withTracing(sessionHandlers.PATCH);
export const sessionPOST = withTracing(sessionHandlers.POST);

export const conversationGET = withTracing(conversationHandlers.GET);
export const conversationPATCH = withTracing(conversationHandlers.PATCH);
export const conversationPOST = withTracing(conversationHandlers.POST);
