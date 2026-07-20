import { decodeRouteSegment } from "@/lib/shared/decode-route-segment";
import { parseTicketsPageState } from "./ticket-url-state";

export interface QuickTicketRouteLocation {
  pathname: string;
  searchParams?: Pick<URLSearchParams, "get">;
}

export interface QuickTicketRouteContext {
  projectName?: string;
  sessionName?: string;
}

export interface QuickTicketConversationRegistration {
  token: string;
  projectName: string;
  sessionName: string | null;
  conversationId: string;
  title: string;
}

export type QuickTicketConversationContext = Omit<
  QuickTicketConversationRegistration,
  "token"
>;

export interface ResolvedQuickTicketContext {
  projectName?: string;
  sessionName?: string | null;
  conversation?: QuickTicketConversationContext;
}

export interface ResolveQuickTicketContextInput extends QuickTicketRouteLocation {
  registrations?: readonly QuickTicketConversationRegistration[];
}

const PROJECT_STATIC_CHILDREN = new Set(["workflows"]);
const SESSION_STATIC_CHILDREN = new Set([
  "conflicts",
  "diff",
  "templates",
  "workflow",
]);

function pathSegments(pathname: string): string[] {
  const pathOnly = pathname.split("?", 1)[0] ?? pathname;
  return pathOnly.split("/").filter((segment) => segment.length > 0);
}

function projectRouteContext(
  segments: readonly string[],
): QuickTicketRouteContext {
  const encodedProjectName = segments[1];
  if (encodedProjectName === undefined) return {};

  const projectName = decodeRouteSegment(encodedProjectName);
  const encodedThirdSegment = segments[2];
  if (encodedThirdSegment === undefined) return { projectName };

  const thirdSegment = decodeRouteSegment(encodedThirdSegment);
  if (PROJECT_STATIC_CHILDREN.has(thirdSegment)) return { projectName };

  if (segments.length === 3) {
    return { projectName, sessionName: thirdSegment };
  }

  const encodedSessionChild = segments[3];
  if (
    segments.length === 4 &&
    encodedSessionChild !== undefined &&
    SESSION_STATIC_CHILDREN.has(decodeRouteSegment(encodedSessionChild))
  ) {
    return { projectName, sessionName: thirdSegment };
  }

  return { projectName };
}

function ticketsRouteContext(
  segments: readonly string[],
  searchParams: Pick<URLSearchParams, "get">,
): QuickTicketRouteContext {
  if (segments.length === 1) {
    const projectName = parseTicketsPageState(searchParams).filters.projectName;
    return projectName === null ? {} : { projectName };
  }

  const encodedProjectName = segments[1];
  const number = segments[2];
  if (
    segments.length !== 3 ||
    encodedProjectName === undefined ||
    number === undefined ||
    !/^[1-9]\d*$/.test(number)
  ) {
    return {};
  }
  return { projectName: decodeRouteSegment(encodedProjectName) };
}

export function isQuickTicketAvailable(
  pathname: string | null | undefined,
): boolean {
  if (!pathname) return false;
  const segments = pathSegments(pathname);
  return segments[0] !== "config";
}

export function inferQuickTicketRouteContext({
  pathname,
  searchParams = new URLSearchParams(),
}: QuickTicketRouteLocation): QuickTicketRouteContext {
  const segments = pathSegments(pathname);
  if (segments[0] === "projects") return projectRouteContext(segments);
  if (segments[0] === "tickets") {
    return ticketsRouteContext(segments, searchParams);
  }
  return {};
}

function registrationIsCompatible(
  registration: QuickTicketConversationRegistration,
  routeContext: QuickTicketRouteContext,
): boolean {
  if (
    routeContext.projectName !== undefined &&
    registration.projectName !== routeContext.projectName
  ) {
    return false;
  }
  if (
    routeContext.sessionName !== undefined &&
    registration.sessionName !== routeContext.sessionName
  ) {
    return false;
  }
  return true;
}

export function resolveQuickTicketContext({
  registrations = [],
  ...location
}: ResolveQuickTicketContextInput): ResolvedQuickTicketContext {
  const routeContext = inferQuickTicketRouteContext(location);
  const registration = registrations.findLast((candidate) =>
    registrationIsCompatible(candidate, routeContext),
  );
  if (registration === undefined) return routeContext;

  const conversation: QuickTicketConversationContext = {
    projectName: registration.projectName,
    sessionName: registration.sessionName,
    conversationId: registration.conversationId,
    title: registration.title,
  };
  return {
    projectName: conversation.projectName,
    sessionName: conversation.sessionName,
    conversation,
  };
}
