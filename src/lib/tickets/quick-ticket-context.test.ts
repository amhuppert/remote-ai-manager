import { describe, expect, it } from "vitest";

import {
  inferQuickTicketRouteContext,
  isQuickTicketAvailable,
  resolveQuickTicketContext,
  type QuickTicketConversationRegistration,
} from "./quick-ticket-context";

function registration(
  overrides: Partial<QuickTicketConversationRegistration> = {},
): QuickTicketConversationRegistration {
  return {
    token: "owner-a",
    projectName: "command-center",
    sessionName: "quick-ticket",
    conversationId: "conversation-a",
    title: "Implement quick ticket",
    ...overrides,
  };
}

describe("isQuickTicketAvailable", () => {
  it.each(["/config", "/config/"])(
    "excludes the configuration surface at %s",
    (pathname) => {
      expect(isQuickTicketAvailable(pathname)).toBe(false);
    },
  );

  it.each([
    "/projects",
    "/projects/command-center",
    "/conversations",
    "/tickets",
    "/workflows",
  ])("allows quick-ticket creation at %s", (pathname) => {
    expect(isQuickTicketAvailable(pathname)).toBe(true);
  });
});

describe("inferQuickTicketRouteContext", () => {
  it.each([
    {
      pathname: "/projects/command-center",
      search: "",
      expected: { projectName: "command-center" },
    },
    {
      pathname: "/projects/command%20center",
      search: "",
      expected: { projectName: "command center" },
    },
    {
      pathname: "/projects/command-center/quick%20ticket",
      search: "",
      expected: {
        projectName: "command-center",
        sessionName: "quick ticket",
      },
    },
    {
      pathname: "/projects/command-center/quick-ticket/conflicts",
      search: "",
      expected: {
        projectName: "command-center",
        sessionName: "quick-ticket",
      },
    },
    {
      pathname: "/projects/command-center/quick-ticket/diff",
      search: "",
      expected: {
        projectName: "command-center",
        sessionName: "quick-ticket",
      },
    },
    {
      pathname: "/projects/command-center/quick-ticket/templates",
      search: "",
      expected: {
        projectName: "command-center",
        sessionName: "quick-ticket",
      },
    },
    {
      pathname: "/projects/command-center/quick-ticket/workflow",
      search: "",
      expected: {
        projectName: "command-center",
        sessionName: "quick-ticket",
      },
    },
    {
      pathname: "/projects/command-center/workflows",
      search: "",
      expected: { projectName: "command-center" },
    },
    {
      pathname: "/projects/command-center/workflows/unrecognized",
      search: "",
      expected: { projectName: "command-center" },
    },
    {
      pathname: "/tickets/command%20center/42",
      search: "",
      expected: { projectName: "command center" },
    },
    {
      pathname: "/tickets",
      search: "project=command-center&view=board",
      expected: { projectName: "command-center" },
    },
    {
      pathname: "/tickets",
      search: "project=",
      expected: {},
    },
    {
      pathname: "/projects/malformed%project",
      search: "",
      expected: { projectName: "malformed%project" },
    },
    {
      pathname: "/tickets/command-center/not-a-number",
      search: "",
      expected: {},
    },
    { pathname: "/projects", search: "", expected: {} },
    { pathname: "/conversations", search: "", expected: {} },
    { pathname: "/workflows", search: "", expected: {} },
  ])("infers $pathname explicitly", ({ pathname, search, expected }) => {
    expect(
      inferQuickTicketRouteContext({
        pathname,
        searchParams: new URLSearchParams(search),
      }),
    ).toEqual(expected);
  });
});

describe("resolveQuickTicketContext", () => {
  it("lets the newest compatible registration override route-only context", () => {
    const registrations = [
      registration({
        token: "older-compatible",
        conversationId: "older",
        title: "Older conversation",
      }),
      registration({
        token: "newer-compatible",
        conversationId: "newer",
        title: "Newer conversation",
      }),
    ];

    expect(
      resolveQuickTicketContext({
        pathname: "/projects/command-center/quick-ticket",
        registrations,
      }),
    ).toEqual({
      projectName: "command-center",
      sessionName: "quick-ticket",
      conversation: {
        projectName: "command-center",
        sessionName: "quick-ticket",
        conversationId: "newer",
        title: "Newer conversation",
      },
    });
  });

  it("ignores newer registrations from a different route scope", () => {
    const registrations = [
      registration({ token: "compatible" }),
      registration({
        token: "wrong-session",
        sessionName: "other-session",
      }),
      registration({ token: "wrong-project", projectName: "other-project" }),
    ];

    expect(
      resolveQuickTicketContext({
        pathname: "/projects/command-center/quick-ticket/diff",
        registrations,
      }).conversation?.conversationId,
    ).toBe("conversation-a");
  });

  it("uses a live registration to supply context on a global route", () => {
    expect(
      resolveQuickTicketContext({
        pathname: "/conversations",
        registrations: [
          registration({ sessionName: null, title: "Project conversation" }),
        ],
      }),
    ).toEqual({
      projectName: "command-center",
      sessionName: null,
      conversation: {
        projectName: "command-center",
        sessionName: null,
        conversationId: "conversation-a",
        title: "Project conversation",
      },
    });
  });
});
