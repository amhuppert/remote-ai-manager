import { withTracing } from "@/lib/logging";
import { publishEvent } from "@/lib/events/publication";

import { defaultCapabilityRouteDeps } from "./route-defaults";
import {
  createConversationCapabilityHandlers,
  createGlobalCapabilityHandlers,
  createProjectConversationCapabilityHandlers,
  createProjectCapabilityHandlers,
  createSessionCapabilityHandlers,
} from "./route-handlers";

const globalHandlers = createGlobalCapabilityHandlers({
  ...defaultCapabilityRouteDeps,
  broadcast: publishEvent,
});

const projectHandlers = createProjectCapabilityHandlers({
  ...defaultCapabilityRouteDeps,
  broadcast: publishEvent,
});

const sessionHandlers = createSessionCapabilityHandlers({
  ...defaultCapabilityRouteDeps,
  broadcast: publishEvent,
});

const conversationHandlers = createConversationCapabilityHandlers({
  ...defaultCapabilityRouteDeps,
  broadcast: publishEvent,
});

const projectConversationHandlers = createProjectConversationCapabilityHandlers(
  {
    ...defaultCapabilityRouteDeps,
    broadcast: publishEvent,
  },
);

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

export const projectConversationGET = withTracing(
  projectConversationHandlers.GET,
);
export const projectConversationPATCH = withTracing(
  projectConversationHandlers.PATCH,
);
export const projectConversationPOST = withTracing(
  projectConversationHandlers.POST,
);
