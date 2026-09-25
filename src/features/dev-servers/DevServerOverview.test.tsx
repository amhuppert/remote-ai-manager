// @vitest-environment jsdom
import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

import type { DevServerOverviewProject } from "@/lib/dev-server/schemas";

import {
  DevServerOverview,
  type DevServerOverviewProps,
} from "./DevServerOverview";

const projects: DevServerOverviewProject[] = [
  {
    projectName: "storefront",
    projectPath: "/repos/storefront",
    configError: null,
    servers: [
      {
        owner: { kind: "project" },
        serverName: "web",
        status: "stopped",
        port: null,
        localUrl: null,
        remoteUrl: null,
        startedAt: null,
        errorMessage: null,
        worktreePath: "/repos/storefront",
      },
      {
        owner: { kind: "session", sessionName: "checkout" },
        serverName: "web",
        status: "running",
        port: 4300,
        localUrl: "http://localhost:4300",
        remoteUrl: null,
        startedAt: "2026-09-24T16:05:00.000Z",
        errorMessage: null,
        worktreePath: "/repos/storefront/.worktrees/checkout-1a2b",
      },
    ],
  },
  {
    projectName: "api-gateway",
    projectPath: "/repos/api-gateway",
    configError: null,
    servers: [],
  },
];

function renderOverview(overrides: Partial<DevServerOverviewProps> = {}) {
  const props: DevServerOverviewProps = {
    projects,
    pendingStopIds: new Set(),
    notices: {},
    isStoppingUnmanaged: false,
    onStart: vi.fn(),
    onStop: vi.fn(),
    onDismissNotice: vi.fn(),
    onStopUnmanagedAndRetry: vi.fn(),
    now: Date.parse("2026-09-24T18:00:00.000Z"),
    ...overrides,
  };
  render(<DevServerOverview {...props} />);
  return props;
}

describe("DevServerOverview", () => {
  it("starts an idle project-root server without a session", () => {
    const props = renderOverview();

    fireEvent.click(
      screen.getByRole("button", { name: "Start web in the project root" }),
    );

    expect(props.onStart).toHaveBeenCalledWith({
      projectName: "storefront",
      serverName: "web",
    });
  });

  it("stops a session server through the identity it was listed with", () => {
    const props = renderOverview();

    fireEvent.click(
      screen.getByRole("button", { name: "Stop web in session checkout" }),
    );

    expect(props.onStop).toHaveBeenCalledWith({
      projectName: "storefront",
      sessionName: "checkout",
      worktreePath: "/repos/storefront/.worktrees/checkout-1a2b",
      serverName: "web",
    });
  });

  it("marks a stop in flight as busy", () => {
    renderOverview({
      pendingStopIds: new Set([
        "storefront::checkout::/repos/storefront/.worktrees/checkout-1a2b::web",
      ]),
    });

    expect(
      screen.getByRole("button", { name: "Stop web in session checkout" }),
    ).toHaveAttribute("aria-busy", "true");
  });

  it("offers to stop an unmanaged listener that blocked a start", () => {
    const props = renderOverview({
      notices: {
        storefront: {
          kind: "conflict",
          serverName: "web",
          port: 4301,
          pid: 777,
          cwd: "/repos/storefront",
        },
      },
    });

    fireEvent.click(
      screen.getByRole("button", { name: "Stop process and start" }),
    );

    expect(props.onStopUnmanagedAndRetry).toHaveBeenCalledWith("storefront");
  });

  it("lists projects without dev servers apart from the configured ones", () => {
    renderOverview();

    expect(
      screen.getByRole("heading", { name: /storefront/ }),
    ).toBeInTheDocument();
    expect(
      screen.queryByRole("heading", { name: /api-gateway/ }),
    ).not.toBeInTheDocument();
    expect(screen.getByRole("link", { name: "api-gateway" })).toHaveAttribute(
      "href",
      "/projects/api-gateway",
    );
  });
});
