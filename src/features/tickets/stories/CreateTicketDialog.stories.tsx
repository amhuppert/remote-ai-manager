import type { Meta, StoryObj } from "@storybook/nextjs-vite";
import { useState } from "react";
import { userEvent, within } from "storybook/test";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";

import { Button } from "@/components/ui/Button";
import type { DiscoveredProject } from "@/lib/projects/schemas";
import CreateTicketDialog from "@/features/tickets/components/CreateTicketDialog";

// ---------------------------------------------------------------------------
// Sample data
// ---------------------------------------------------------------------------

const PROJECTS: DiscoveredProject[] = [
  {
    name: "command-center",
    path: "/home/alex/github/command-center",
    activeSessions: 1,
    hasRunningSession: true,
  },
  {
    name: "aerotrainer",
    path: "/home/alex/github/aerotrainer",
    activeSessions: 0,
    hasRunningSession: false,
  },
];

// ---------------------------------------------------------------------------
// Fetch mocking — serves the projects list and the create endpoint. `fail`
// rejects every POST (nothing persists, the dialog must preserve input);
// `hang` never settles (the pending state).
// ---------------------------------------------------------------------------

type CreateBehavior = "success" | "fail" | "hang";
type ProjectDiscoveryBehavior = "success" | "hang" | "fail-once";

function mockCreateFetch(
  behavior: CreateBehavior,
  projectDiscovery: ProjectDiscoveryBehavior,
) {
  const original = globalThis.fetch;
  let projectRequestCount = 0;
  globalThis.fetch = async (input, init) => {
    const url = typeof input === "string" ? input : input.toString();
    const method = init?.method?.toUpperCase() ?? "GET";
    const parsed = new URL(url, window.location.origin);

    if (method === "GET" && parsed.pathname === "/api/projects") {
      projectRequestCount += 1;
      if (projectDiscovery === "hang") return new Promise(() => {});
      if (projectDiscovery === "fail-once" && projectRequestCount === 1) {
        return Response.json(
          { error: "Project discovery is unavailable." },
          { status: 500 },
        );
      }
      return Response.json(PROJECTS);
    }

    const createMatch = parsed.pathname.match(
      /^\/api\/projects\/([^/]+)\/tickets$/,
    );
    if (createMatch && method === "POST") {
      if (behavior === "hang") return new Promise(() => {});
      if (behavior === "fail") {
        return Response.json(
          { error: "Ticket creation failed — nothing was saved." },
          { status: 500 },
        );
      }
      const projectName = decodeURIComponent(createMatch[1]!);
      const body = typeof init?.body === "string" ? JSON.parse(init.body) : {};
      const createdAt = new Date().toISOString();
      return Response.json({
        id: "t-new",
        projectPath: `/home/alex/github/${projectName}`,
        projectName,
        number: 13,
        title: body.title,
        description: body.description ?? "",
        workType: body.workType,
        status: "not_started",
        createdAt,
        updatedAt: createdAt,
        attachments: [],
        sessions: [],
      });
    }
    if (method === "GET" && parsed.pathname === "/api/tickets") {
      return Response.json([]);
    }
    return original(input, init);
  };
  return () => {
    globalThis.fetch = original;
  };
}

function DialogHarness({
  behavior,
  projectDiscovery = "success",
  initialProjectName = null,
}: {
  behavior: CreateBehavior;
  projectDiscovery?: ProjectDiscoveryBehavior;
  initialProjectName?: string | null;
}): React.JSX.Element {
  const cleanup = mockCreateFetch(behavior, projectDiscovery);
  if (typeof window !== "undefined") {
    window.addEventListener("beforeunload", cleanup, { once: true });
  }
  const [queryClient] = useState(
    () =>
      new QueryClient({
        defaultOptions: { queries: { retry: false, refetchInterval: false } },
      }),
  );
  const [open, setOpen] = useState(true);
  return (
    <QueryClientProvider client={queryClient}>
      <Button variant="primary" onClick={() => setOpen(true)}>
        New ticket
      </Button>
      <CreateTicketDialog
        open={open}
        onOpenChange={setOpen}
        initialProjectName={initialProjectName}
      />
    </QueryClientProvider>
  );
}

// ---------------------------------------------------------------------------
// Meta
// ---------------------------------------------------------------------------

const meta = {
  title: "Tickets/CreateTicketDialog",
  component: CreateTicketDialog,
  // Stories render through DialogHarness (open state + mocked fetch); the
  // meta-level args only satisfy the component's required-prop contract.
  args: { open: true, onOpenChange: () => {} },
  parameters: {
    layout: "fullscreen",
    nextjs: {
      appDirectory: true,
      navigation: { pathname: "/tickets" },
    },
  },
} satisfies Meta<typeof CreateTicketDialog>;

export default meta;
type Story = StoryObj<typeof meta>;

async function fillTitle(title: string): Promise<void> {
  const body = within(document.body);
  const input = await body.findByLabelText("Title");
  await userEvent.type(input, title);
}

async function submit(): Promise<void> {
  const body = within(document.body);
  await userEvent.click(body.getByRole("button", { name: "Create ticket" }));
}

// ---------------------------------------------------------------------------
// Stories
// ---------------------------------------------------------------------------

/**
 * Opened from a project-prefiltered entry: the project select is pre-filled
 * and the work type defaults to Feature. Only the title is required.
 */
export const Default: Story = {
  render: () => (
    <DialogHarness behavior="success" initialProjectName="command-center" />
  ),
};

/**
 * Submitting with no title and no project runs validation on submit — the
 * issues render as FormErrors and nothing is sent.
 */
export const ValidationError: Story = {
  render: () => <DialogHarness behavior="success" />,
  play: async () => {
    await submit();
  },
};

export const ProjectsPending: Story = {
  render: () => <DialogHarness behavior="success" projectDiscovery="hang" />,
};

export const ProjectsFailure: Story = {
  render: () => (
    <DialogHarness behavior="success" projectDiscovery="fail-once" />
  ),
};

/**
 * While the create request is in flight the inputs lock, the confirm shows a
 * spinner, and Cancel stays enabled.
 */
export const Pending: Story = {
  render: () => (
    <DialogHarness behavior="hang" initialProjectName="command-center" />
  ),
  play: async () => {
    await fillTitle("SSE reconnect drops ticket deltas");
    await submit();
  },
};

/**
 * The server rejects the create: nothing persists (the per-project counter
 * only moves on commit), the error surfaces inline, and every input keeps
 * its value for another attempt.
 */
export const FailurePreservesInput: Story = {
  render: () => (
    <DialogHarness behavior="fail" initialProjectName="command-center" />
  ),
  play: async () => {
    await fillTitle("SSE reconnect drops ticket deltas");
    await submit();
  },
};

/**
 * Success reports the new identifier and nudges adding context on the new
 * dossier — the primary action leads there.
 */
export const Success: Story = {
  render: () => (
    <DialogHarness behavior="success" initialProjectName="command-center" />
  ),
  play: async () => {
    await fillTitle("SSE reconnect drops ticket deltas");
    await submit();
  },
};
