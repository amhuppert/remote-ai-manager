import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { Decorator, Meta, StoryObj } from "@storybook/nextjs-vite";
import { expect, fn, userEvent, waitFor, within } from "storybook/test";

import { buildArtifactListItem } from "@/components/context-artifacts/fixtures";
import { contextArtifactKeys } from "@/lib/context-artifacts/query-keys";
import type { ContextArtifactListItem } from "@/lib/context-artifacts/queries";
import { sessionStateSchema } from "@/lib/sessions/schemas";
import { alignmentKeys } from "@/lib/session-alignment/query-keys";
import {
  alignmentStateSchema,
  type AlignmentState,
} from "@/lib/session-alignment/schemas";
import { ticketKeys } from "@/lib/tickets/query-keys";
import type { TicketLinkSummary } from "@/lib/tickets/schemas";
import { LAYOUT_OPTIONS } from "./LayoutSwitcher";
import SessionInfoStrip from "./SessionInfoStrip";

const PROJECT_NAME = "command-center";
const LONG_PROJECT_NAME = "command-center-webapp2";
const SESSION_NAME =
  "ticket-conversation-top-bar-needs-to-be-responsive-88bfcd";
const CONVERSATION_ID = "3215d7bf-d7f9-4e05-945a-78621c52f862";

const session = sessionStateSchema.parse({
  sessionName: SESSION_NAME,
  worktreePath:
    "/Users/alex/github/command-center/.worktrees/ticket-conversation-top-bar-needs-to-be-responsive-88bfcd",
  branchName: "csm/ticket-conversation-top-bar-needs-to-be-responsive-88bfcd",
  createdAt: "2026-07-30T20:00:00.000Z",
  lastActivityAt: "2026-07-31T01:00:00.000Z",
  tddEnabled: true,
});

const alignmentState = alignmentStateSchema.parse({
  active: {
    id: "alignment-v5",
    version: 5,
    content: "Keep every conversation control reachable.",
    contentHash: "alignment-v5-hash",
    status: "active",
    source: "ticket",
    authorConversationId: CONVERSATION_ID,
    autoActivate: true,
    linkedDecisionIds: [],
    createdAt: "2026-07-30T20:00:00.000Z",
    activatedAt: "2026-07-30T20:05:00.000Z",
    approver: "Alex",
  },
  draft: null,
  history: [],
  decisions: [],
  pendingProposals: [],
  preview: "Keep every conversation control reachable.",
});

const pendingAlignmentState = alignmentStateSchema.parse({
  ...alignmentState,
  draft: {
    id: "alignment-draft",
    version: null,
    content: "Pending responsive-layout update.",
    contentHash: "alignment-draft-hash",
    status: "draft",
    source: "align_rerun",
    authorConversationId: CONVERSATION_ID,
    autoActivate: false,
    linkedDecisionIds: [],
    createdAt: "2026-07-31T01:05:00.000Z",
    activatedAt: null,
    approver: null,
  },
});

const ticketLinks = {
  [SESSION_NAME]: {
    ticketId: "command-center#35",
    projectName: PROJECT_NAME,
    number: 35,
    title: "conversation top bar needs to be responsive",
    active: true,
    linkedAt: "2026-07-30T20:00:00.000Z",
    endedAt: null,
  },
} satisfies Record<string, TicketLinkSummary>;

const longTicketLinks = {
  [SESSION_NAME]: {
    ...ticketLinks[SESSION_NAME],
    ticketId: `${LONG_PROJECT_NAME}#35`,
    projectName: LONG_PROJECT_NAME,
  },
} satisfies Record<string, TicketLinkSummary>;

const STALE_CONTEXT_ARTIFACTS = [
  buildArtifactListItem({
    kind: "conversation_compaction",
    messageIndex: null,
    messageId: null,
    stale: true,
    staleBehindMessages: 12_345,
  }),
];

const withStripQueries: Decorator = (Story, context) => {
  const contextArtifacts = (context.parameters.contextArtifacts ??
    []) as ContextArtifactListItem[];
  const storyAlignmentState = (context.parameters.alignmentState ??
    alignmentState) as AlignmentState;
  const storyTicketLinks = (context.parameters.ticketLinks ??
    ticketLinks) as Record<string, TicketLinkSummary>;
  const storyProjectName = context.args.projectName as string;
  const storySessionName = context.args.sessionName as string;
  const storyConversationId = context.args.conversationId as string;
  const queryClient = new QueryClient({
    defaultOptions: {
      queries: {
        retry: false,
        staleTime: Infinity,
        refetchOnMount: false,
        refetchOnWindowFocus: false,
        refetchOnReconnect: false,
      },
    },
  });
  queryClient.setQueryData(
    alignmentKeys.state(storyProjectName, storySessionName),
    storyAlignmentState,
  );
  queryClient.setQueryData(
    contextArtifactKeys.list({
      scope: "session",
      projectName: storyProjectName,
      sessionName: storySessionName,
      conversationId: storyConversationId,
    }),
    contextArtifacts,
  );
  queryClient.setQueryData(
    ticketKeys.sessionLinks(storyProjectName),
    storyTicketLinks,
  );

  return (
    <QueryClientProvider client={queryClient}>
      <Story />
    </QueryClientProvider>
  );
};

function atWidth(width: number): Decorator {
  return function StripAtWidth(Story) {
    return (
      <div
        data-strip-host
        style={{
          width,
          maxWidth: "100%",
          background: "var(--bg-void)",
        }}
      >
        <Story />
      </div>
    );
  };
}

interface StripExpectations {
  inlineCompaction: boolean;
  inlineLayout: boolean;
  mobile?: boolean;
  status?: string;
  ticketName?: string;
  width: number;
  worktree: boolean;
}

async function settleLayout(canvasElement: HTMLElement): Promise<void> {
  await canvasElement.ownerDocument.fonts.ready;
  await new Promise<void>((resolve) => {
    const view = canvasElement.ownerDocument.defaultView;
    if (!view) {
      resolve();
      return;
    }
    view.requestAnimationFrame(() => resolve());
  });
}

async function expectStripFits(
  canvasElement: HTMLElement,
  {
    inlineCompaction,
    inlineLayout,
    mobile = false,
    status = "running",
    ticketName = "command-center#35",
    width,
    worktree,
  }: StripExpectations,
): Promise<void> {
  await settleLayout(canvasElement);

  const host = canvasElement.querySelector<HTMLElement>("[data-strip-host]");
  if (!host) {
    throw new Error("strip host not rendered");
  }
  await expect(host.getBoundingClientRect().width).toBeCloseTo(width, 0);

  const strip = canvasElement.querySelector<HTMLElement>(
    "[data-session-info-strip]",
  );
  if (!strip) {
    throw new Error("session info strip not rendered");
  }

  const canvas = within(strip);
  const ticket = canvas.getByRole("link", { name: ticketName });
  await expect(ticket).toBeVisible();

  if (mobile) {
    await expect(
      canvas.queryByRole("button", { name: "Actions" }),
    ).not.toBeInTheDocument();
  } else {
    await expect(
      canvas.getByRole("button", { name: "Dev servers" }),
    ).toBeVisible();
    await expect(canvas.getByRole("button", { name: "Actions" })).toBeVisible();
    await expect(
      canvas.getByRole("button", { name: "Session details" }),
    ).toBeVisible();
    await expect(
      canvas.getByRole("switch", { name: "Toggle red-green TDD" }),
    ).toBeVisible();
    await expect(canvas.getByText("Context")).toBeVisible();
    await expect(canvas.getByText("30%")).toBeVisible();
    await expect(canvas.getByText("Alignment")).toBeVisible();
    await expect(canvas.getByText("v5")).toBeVisible();
    await expect(canvas.getByText(status)).toBeVisible();
  }

  const compactionControl = canvas.queryByRole("button", {
    name: /^Context artifact:/,
  });
  if (inlineCompaction) {
    await expect(compactionControl).toBeVisible();
  } else {
    await expect(compactionControl).not.toBeInTheDocument();
  }

  const layoutGroup = canvas.queryByRole("group", {
    name: "Conversation layout",
  });
  if (inlineLayout) {
    await expect(layoutGroup).toBeVisible();
  } else {
    await expect(layoutGroup).not.toBeInTheDocument();
  }

  const worktreeControl = canvas.queryByRole("button", { name: /worktree/i });
  if (worktree) {
    await expect(worktreeControl).toBeVisible();
    const worktreeRect = worktreeControl!.getBoundingClientRect();
    for (const child of worktreeControl!.children) {
      const childRect = child.getBoundingClientRect();
      if (childRect.width === 0 || childRect.height === 0) continue;
      await expect(childRect.left).toBeGreaterThanOrEqual(
        worktreeRect.left - 1,
      );
      await expect(childRect.right).toBeLessThanOrEqual(worktreeRect.right + 1);
    }
  } else {
    await expect(worktreeControl).not.toBeInTheDocument();
  }

  await expect(strip.scrollWidth).toBeLessThanOrEqual(strip.clientWidth + 1);
  const stripRect = strip.getBoundingClientRect();
  const controls = strip.querySelectorAll<HTMLElement>(
    'button, a[href], [role="button"], [role="switch"]',
  );
  for (const control of controls) {
    const rect = control.getBoundingClientRect();
    if (rect.width === 0 || rect.height === 0) continue;
    await expect(rect.left).toBeGreaterThanOrEqual(stripRect.left - 1);
    await expect(rect.right).toBeLessThanOrEqual(stripRect.right + 1);
  }

  const ticketRegion = ticket.closest<HTMLElement>(
    "[data-session-ticket-region]",
  );
  if (!ticketRegion) {
    throw new Error("ticket region not rendered");
  }
  const ticketRect = ticket.getBoundingClientRect();
  const ticketRegionRect = ticketRegion.getBoundingClientRect();
  await expect(ticketRect.left).toBeGreaterThanOrEqual(
    ticketRegionRect.left - 1,
  );
  await expect(ticketRect.right).toBeLessThanOrEqual(
    ticketRegionRect.right + 1,
  );

  const contextRegion = strip.querySelector<HTMLElement>(
    "[data-session-context-region]",
  );
  if (contextRegion) {
    const nextRect = contextRegion.getBoundingClientRect();
    if (nextRect.width > 0 && nextRect.height > 0) {
      await expect(ticketRect.right).toBeLessThanOrEqual(nextRect.left + 1);
    }
  }
}

async function expectLayoutOptionsInMenu(
  canvasElement: HTMLElement,
): Promise<ReturnType<typeof within>> {
  const canvas = within(canvasElement);
  await userEvent.click(canvas.getByRole("button", { name: "Actions" }));
  const body = within(canvasElement.ownerDocument.body);

  await waitFor(() => {
    for (const { tooltip } of LAYOUT_OPTIONS) {
      expect(body.getByRole("menuitemradio", { name: tooltip })).toBeVisible();
    }
  });

  const menu = body.getByRole("menu");
  const host = canvasElement.querySelector<HTMLElement>("[data-strip-host]");
  if (!host) {
    throw new Error("strip host not rendered");
  }
  const menuRect = menu.getBoundingClientRect();
  const hostRect = host.getBoundingClientRect();
  expect(menuRect.left).toBeGreaterThanOrEqual(hostRect.left - 1);
  expect(menuRect.right).toBeLessThanOrEqual(hostRect.right + 1);

  return body;
}

function wideViewport(width: number) {
  return {
    viewport: {
      defaultViewport: `strip-${width}`,
      viewports: {
        [`strip-${width}`]: {
          name: `${width}px strip`,
          styles: { width: `${width + 80}px`, height: "800px" },
          type: "desktop",
        },
      },
    },
  };
}

const meta = {
  title: "Session/InfoStrip",
  component: SessionInfoStrip,
  decorators: [withStripQueries],
  parameters: {
    a11y: { test: "error" },
    layout: "fullscreen",
  },
  args: {
    session,
    activeConversation: undefined,
    projectName: PROJECT_NAME,
    sessionName: SESSION_NAME,
    conversationId: CONVERSATION_ID,
    statusDotClass: "status-dot-cyan",
    displayStatus: "running",
    contextPercent: 30,
    buildContext: () => "Responsive top bar context",
    tddEnabled: true,
    onTddChange: fn(),
    tddDisabled: false,
    layout: "split",
    onLayoutChange: fn(),
    dsOpen: false,
    dsServers: [],
    dsClose: fn(),
    dsToggle: fn(),
    dsStartServer: fn(),
    dsStopServer: fn(),
    dsStartAll: fn(),
    dsStopAll: fn(),
    targetBranch: "main",
    onDelete: fn(),
    onRebase: fn(),
    onActivateAlignment: fn(),
  },
} satisfies Meta<typeof SessionInfoStrip>;

export default meta;
type Story = StoryObj<typeof meta>;

export const Wide: Story = {
  decorators: [atWidth(1440)],
  parameters: {
    ...wideViewport(1440),
    alignmentState: pendingAlignmentState,
    contextArtifacts: STALE_CONTEXT_ARTIFACTS,
    ticketLinks: longTicketLinks,
  },
  args: {
    displayStatus: "waiting_for_input",
    projectName: LONG_PROJECT_NAME,
  },
  play: async ({ canvasElement }) => {
    await expectStripFits(canvasElement, {
      inlineCompaction: true,
      inlineLayout: true,
      status: "waiting_for_input",
      ticketName: `${LONG_PROJECT_NAME}#35`,
      width: 1440,
      worktree: true,
    });
    const canvas = within(canvasElement);
    const ticketRect = canvas
      .getByRole("link", { name: `${LONG_PROJECT_NAME}#35` })
      .getBoundingClientRect();
    const actionsRect = canvas
      .getByRole("button", { name: "Actions" })
      .getBoundingClientRect();
    await expect(actionsRect.top).toBeLessThan(ticketRect.bottom - 1);
  },
};

export const ActionStackBoundary: Story = {
  decorators: [atWidth(1439)],
  parameters: {
    ...wideViewport(1439),
    alignmentState: pendingAlignmentState,
    contextArtifacts: STALE_CONTEXT_ARTIFACTS,
    ticketLinks: longTicketLinks,
  },
  args: {
    displayStatus: "waiting_for_input",
    projectName: LONG_PROJECT_NAME,
  },
  play: async ({ canvasElement }) => {
    await expectStripFits(canvasElement, {
      inlineCompaction: true,
      inlineLayout: true,
      status: "waiting_for_input",
      ticketName: `${LONG_PROJECT_NAME}#35`,
      width: 1439,
      worktree: true,
    });
    const canvas = within(canvasElement);
    const ticketRect = canvas
      .getByRole("link", { name: `${LONG_PROJECT_NAME}#35` })
      .getBoundingClientRect();
    const actionsRect = canvas
      .getByRole("button", { name: "Actions" })
      .getBoundingClientRect();
    await expect(actionsRect.top).toBeGreaterThan(ticketRect.bottom - 1);
  },
};

export const PendingAlignmentPressure: Story = {
  decorators: [atWidth(1320)],
  parameters: {
    ...wideViewport(1320),
    alignmentState: pendingAlignmentState,
    contextArtifacts: STALE_CONTEXT_ARTIFACTS,
  },
  args: { displayStatus: "waiting_for_input" },
  play: ({ canvasElement }) =>
    expectStripFits(canvasElement, {
      inlineCompaction: true,
      inlineLayout: true,
      status: "waiting_for_input",
      width: 1320,
      worktree: true,
    }),
};

export const WorktreeVisibleBoundary: Story = {
  decorators: [atWidth(1100)],
  parameters: { contextArtifacts: STALE_CONTEXT_ARTIFACTS },
  args: { displayStatus: "waiting_for_input" },
  play: async ({ canvasElement }) => {
    await expectStripFits(canvasElement, {
      inlineCompaction: true,
      inlineLayout: true,
      status: "waiting_for_input",
      width: 1100,
      worktree: true,
    });
  },
};

export const WorktreeHiddenBoundary: Story = {
  decorators: [atWidth(1099)],
  parameters: { contextArtifacts: STALE_CONTEXT_ARTIFACTS },
  args: { displayStatus: "waiting_for_input" },
  play: async ({ canvasElement }) => {
    await expectStripFits(canvasElement, {
      inlineCompaction: true,
      inlineLayout: true,
      status: "waiting_for_input",
      width: 1099,
      worktree: false,
    });
    const canvas = within(canvasElement);
    await userEvent.click(
      canvas.getByRole("button", { name: "Session details" }),
    );
    const details = canvas.getByRole("dialog", { name: "Session details" });
    await waitFor(() => {
      expect(
        within(details).getByRole("button", { name: "Copy Worktree" }),
      ).toBeVisible();
    });
  },
};

export const CapturedWidth: Story = {
  decorators: [atWidth(1012)],
  play: ({ canvasElement }) =>
    expectStripFits(canvasElement, {
      inlineCompaction: true,
      inlineLayout: true,
      width: 1012,
      worktree: false,
    }),
};

export const Intermediate: Story = {
  decorators: [atWidth(840)],
  play: ({ canvasElement }) =>
    expectStripFits(canvasElement, {
      inlineCompaction: true,
      inlineLayout: true,
      width: 840,
      worktree: false,
    }),
};

export const InlineLayoutBoundary: Story = {
  decorators: [atWidth(760)],
  parameters: { contextArtifacts: STALE_CONTEXT_ARTIFACTS },
  args: { displayStatus: "waiting_for_input" },
  play: ({ canvasElement }) =>
    expectStripFits(canvasElement, {
      inlineCompaction: true,
      inlineLayout: true,
      status: "waiting_for_input",
      width: 760,
      worktree: false,
    }),
};

export const FallbackBoundary: Story = {
  decorators: [atWidth(759)],
  parameters: {
    contextArtifacts: STALE_CONTEXT_ARTIFACTS,
  },
  args: { displayStatus: "waiting_for_input" },
  play: async ({ canvasElement }) => {
    await expectStripFits(canvasElement, {
      inlineCompaction: false,
      inlineLayout: false,
      status: "waiting_for_input",
      width: 759,
      worktree: false,
    });
    const body = await expectLayoutOptionsInMenu(canvasElement);
    await expect(
      body.getByRole("menuitem", { name: /View context artifact/ }),
    ).toBeVisible();
    await expect(
      body.getByRole("menuitem", { name: /Refresh context artifact/ }),
    ).toBeVisible();
    await expect(body.getByText("Behind 12345 messages")).toBeVisible();
    await expect(
      body.getByRole("menuitem", { name: /Copy reference/ }),
    ).toBeVisible();
  },
};

export const CompactFallback: Story = {
  decorators: [atWidth(620)],
  play: ({ canvasElement }) =>
    expectStripFits(canvasElement, {
      inlineCompaction: false,
      inlineLayout: false,
      width: 620,
      worktree: false,
    }),
};

export const ContextTrackBoundary: Story = {
  decorators: [atWidth(520)],
  args: { displayStatus: "waiting_for_input" },
  play: async ({ canvasElement }) => {
    await expectStripFits(canvasElement, {
      inlineCompaction: false,
      inlineLayout: false,
      status: "waiting_for_input",
      width: 520,
      worktree: false,
    });
    await expect(
      within(canvasElement).getByRole("progressbar", {
        name: "Context window 30% full",
      }),
    ).toBeVisible();
  },
};

export const CondensedContextBoundary: Story = {
  decorators: [atWidth(519)],
  args: { displayStatus: "waiting_for_input" },
  play: async ({ canvasElement }) => {
    await expectStripFits(canvasElement, {
      inlineCompaction: false,
      inlineLayout: false,
      status: "waiting_for_input",
      width: 519,
      worktree: false,
    });
    await expect(
      within(canvasElement).queryByRole("progressbar", {
        name: "Context window 30% full",
      }),
    ).not.toBeInTheDocument();
  },
};

export const NarrowDesktop: Story = {
  decorators: [atWidth(429)],
  parameters: { ticketLinks: longTicketLinks },
  args: {
    displayStatus: "waiting_for_input",
    projectName: LONG_PROJECT_NAME,
  },
  play: async ({ canvasElement }) => {
    await expectStripFits(canvasElement, {
      inlineCompaction: false,
      inlineLayout: false,
      status: "waiting_for_input",
      ticketName: `${LONG_PROJECT_NAME}#35`,
      width: 429,
      worktree: false,
    });
    const ticket = within(canvasElement).getByRole("link", {
      name: `${LONG_PROJECT_NAME}#35`,
    });
    await expect(within(ticket).getByText("#35")).toBeVisible();
    await expectLayoutOptionsInMenu(canvasElement);
  },
};

export const Mobile: Story = {
  decorators: [atWidth(390)],
  parameters: {
    viewport: {
      defaultViewport: "strip-mobile",
      viewports: {
        "strip-mobile": {
          name: "390px mobile strip",
          styles: { width: "390px", height: "844px" },
          type: "mobile",
        },
      },
    },
  },
  play: async ({ canvasElement }) => {
    await expectStripFits(canvasElement, {
      inlineCompaction: false,
      inlineLayout: false,
      mobile: true,
      width: 390,
      worktree: false,
    });
  },
};
