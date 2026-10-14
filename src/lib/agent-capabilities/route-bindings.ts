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

// Next supplies context to HTTP handlers; factory callers can omit it.
type HttpRouteHandler = (
  request: Request,
  context: { params: Promise<Record<string, string>> },
) => Promise<Response>;

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

export const globalGET: HttpRouteHandler = withTracing(globalHandlers.GET);
export const globalPATCH: HttpRouteHandler = withTracing(globalHandlers.PATCH);
export const globalPOST: HttpRouteHandler = withTracing(globalHandlers.POST);

export const projectGET: HttpRouteHandler = withTracing(projectHandlers.GET);
export const projectPATCH: HttpRouteHandler = withTracing(
  projectHandlers.PATCH,
);
export const projectPOST: HttpRouteHandler = withTracing(projectHandlers.POST);

export const sessionGET: HttpRouteHandler = withTracing(sessionHandlers.GET);
export const sessionPATCH: HttpRouteHandler = withTracing(
  sessionHandlers.PATCH,
);
export const sessionPOST: HttpRouteHandler = withTracing(sessionHandlers.POST);

export const conversationGET: HttpRouteHandler = withTracing(
  conversationHandlers.GET,
);
export const conversationPATCH: HttpRouteHandler = withTracing(
  conversationHandlers.PATCH,
);
export const conversationPOST: HttpRouteHandler = withTracing(
  conversationHandlers.POST,
);

export const projectConversationGET: HttpRouteHandler = withTracing(
  projectConversationHandlers.GET,
);
export const projectConversationPATCH: HttpRouteHandler = withTracing(
  projectConversationHandlers.PATCH,
);
export const projectConversationPOST: HttpRouteHandler = withTracing(
  projectConversationHandlers.POST,
);
