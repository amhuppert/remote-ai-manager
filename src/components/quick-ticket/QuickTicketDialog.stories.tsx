import type { Meta, StoryObj } from "@storybook/nextjs-vite";
import { useEffect, useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { userEvent, within } from "storybook/test";

import { listBackendCatalogEntries } from "@/lib/agent-backends/catalog";
import { useQuickTicketStore } from "@/stores/quick-ticket.store";
import QuickTicketDialog from "./QuickTicketDialog";

type CreateBehavior = "success" | "pending" | "failure";

const PROJECTS = [
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

function installStoryFetch(behavior: CreateBehavior): () => void {
  const original = globalThis.fetch;
  globalThis.fetch = async (input, init) => {
    const url = new URL(
      typeof input === "string" ? input : input.toString(),
      window.location.origin,
    );
    const method = init?.method ?? "GET";
    if (method === "GET" && url.pathname === "/api/projects") {
      return Response.json(PROJECTS);
    }
    if (method === "GET" && url.pathname === "/api/command-center-project") {
      return Response.json({ projectName: "command-center" });
    }
    if (method === "GET" && url.pathname === "/api/voice/health") {
      return Response.json({ available: false });
    }
    if (method === "GET" && url.pathname === "/api/config") {
      return Response.json({
        config: {
          baseDir: "/home/alex/github",
          ignorePatterns: [],
          agentBackends: {
            claude: {
              model: "opus",
              reasoningEffort: "medium",
              timeoutMs: null,
            },
            codex: {
              model: "gpt-5.6-sol",
              reasoningEffort: "ultra",
              timeoutMs: null,
            },
          },
          defaultAgentBackend: "claude",
        },
        raw: {},
      });
    }
    if (method === "GET" && url.pathname === "/api/agent-backends") {
      return Response.json({ backends: listBackendCatalogEntries() });
    }
    if (
      method === "POST" &&
      /^\/api\/projects\/[^/]+\/tickets$/.test(url.pathname)
    ) {
      if (behavior === "pending") return new Promise(() => {});
      if (behavior === "failure") {
        return Response.json(
          { error: "Ticket creation failed — nothing was saved." },
          { status: 500 },
        );
      }
      const body =
        typeof init?.body === "string"
          ? (JSON.parse(init.body) as {
              title: string;
              description: string;
              workType: string;
            })
          : { title: "Untitled", description: "", workType: "feature" };
      const createdAt = new Date().toISOString();
      return Response.json({
        ticket: {
          id: "ticket-story",
          projectPath: "/home/alex/github/command-center",
          projectName: "command-center",
          number: 14,
          title: body.title,
          description: body.description,
          workType: body.workType,
          status: "not_started",
          createdAt,
          updatedAt: createdAt,
          attachments: [],
          sessions: [],
        },
        warnings: [],
      });
    }
    return original(input, init);
  };
  return () => {
    globalThis.fetch = original;
  };
}

function StoryHarness({
  behavior = "success",
  restored = false,
}: {
  behavior?: CreateBehavior;
  restored?: boolean;
}): React.JSX.Element {
  const queryClient = useQueryClient();
  const [ready, setReady] = useState(false);

  useEffect(() => {
    let active = true;
    const restoreFetch = installStoryFetch(behavior);
    queryClient.removeQueries({ queryKey: ["projects"] });
    useQuickTicketStore.getState().clearQuickTicket();
    useQuickTicketStore.getState().openQuickTicket({
      pathname: "/projects/command-center",
    });
    if (restored) {
      useQuickTicketStore
        .getState()
        .updateQuickTicketDraft({ title: "Preserved investigation draft" });
      useQuickTicketStore.getState().closeQuickTicket({ stashDraft: true });
      useQuickTicketStore.getState().openQuickTicket({ pathname: "/tickets" });
    }
    queueMicrotask(() => {
      if (active) setReady(true);
    });
    return () => {
      active = false;
      restoreFetch();
      useQuickTicketStore.getState().clearQuickTicket();
      queryClient.removeQueries({ queryKey: ["projects"] });
    };
  }, [behavior, queryClient, restored]);

  if (!ready) return <div className="app min-h-screen bg-bg-void" />;
  return (
    <div className="app min-h-screen bg-bg-void">
      <QuickTicketDialog
        captureScreenshot={async () => ({
          mediaType: "image/png",
          base64:
            "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=",
          width: 1200,
          height: 800,
        })}
      />
    </div>
  );
}

const meta = {
  title: "Components/Quick ticket/QuickTicketDialog",
  component: QuickTicketDialog,
  parameters: {
    layout: "fullscreen",
    nextjs: {
      appDirectory: true,
      navigation: { pathname: "/projects/command-center" },
    },
  },
} satisfies Meta<typeof QuickTicketDialog>;

export default meta;
type Story = StoryObj<typeof meta>;

export const Default: Story = {
  render: () => <StoryHarness />,
};

export const BugReport: Story = {
  render: () => <StoryHarness />,
  play: async () => {
    const canvas = within(document.body);
    const mode = await canvas.findByRole("switch", {
      name: "Command Center bug report mode",
    });
    await userEvent.click(mode);
  },
};

export const RestoredDraft: Story = {
  render: () => <StoryHarness restored />,
};

export const AutoStartAgent: Story = {
  render: () => <StoryHarness />,
  play: async () => {
    const canvas = within(document.body);
    const autoStart = await canvas.findByRole("checkbox", {
      name: "Start agent after create",
    });
    await userEvent.click(autoStart);
    await canvas.findByTestId("model-selector-trigger");
  },
};

export const Pending: Story = {
  render: () => <StoryHarness behavior="pending" />,
  play: async () => {
    const canvas = within(document.body);
    await userEvent.type(
      await canvas.findByLabelText("Title"),
      "Capture SSE gap",
    );
    await userEvent.click(
      canvas.getByRole("button", { name: "Create ticket" }),
    );
  },
};

export const FailurePreservesInput: Story = {
  render: () => <StoryHarness behavior="failure" />,
  play: async () => {
    const canvas = within(document.body);
    await userEvent.type(
      await canvas.findByLabelText("Title"),
      "Capture SSE gap",
    );
    await userEvent.click(
      canvas.getByRole("button", { name: "Create ticket" }),
    );
  },
};
