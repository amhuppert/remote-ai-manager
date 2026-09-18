import { useState } from "react";
import type { Meta, StoryObj } from "@storybook/nextjs-vite";
import { expect, userEvent, within } from "storybook/test";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import TicketDependencyMap, {
  type DependencyTicket,
} from "../components/TicketDependencyMap";
import { ticketKeys } from "@/lib/tickets/query-keys";
import type { TicketRelationshipView } from "@/lib/tickets/schemas";

const focus: DependencyTicket = {
  id: "ticket-42",
  projectName: "command-center",
  number: 42,
  title: "Ship the ticket workspace",
  status: "in_progress",
};

function relationship(
  number: number,
  title: string,
  role: "depends_on" | "blocks",
  status: DependencyTicket["status"],
  projectName = "command-center",
): TicketRelationshipView {
  return {
    id: `edge-${number}`,
    role,
    otherTicket: { id: `ticket-${number}`, projectName, number, title, status },
    description: "",
    createdAt: "2026-09-18T10:00:00Z",
    updatedAt: "2026-09-18T10:00:00Z",
  };
}

function makeClient(empty: boolean): QueryClient {
  const client = new QueryClient({
    defaultOptions: {
      queries: {
        retry: false,
        staleTime: Infinity,
        refetchOnWindowFocus: false,
      },
    },
  });
  function seed(
    number: number,
    role: "depends_on" | "blocks",
    items: TicketRelationshipView[],
    projectName = "command-center",
  ) {
    client.setQueryData(ticketKeys.relationships(projectName, number, role), {
      pages: [
        {
          items: empty ? [] : items,
          total: empty ? 0 : items.length,
          nextCursor: null,
        },
      ],
      pageParams: [null],
    });
  }
  seed(42, "depends_on", [
    relationship(
      31,
      "Define ticket relationship semantics",
      "depends_on",
      "done",
    ),
    relationship(
      35,
      "Finish keyboard navigation across board lanes",
      "depends_on",
      "in_progress",
    ),
    relationship(
      38,
      "Expose the relationship index",
      "depends_on",
      "blocked",
      "platform",
    ),
  ]);
  seed(42, "blocks", [
    relationship(
      51,
      "Roll out the workspace to existing projects",
      "blocks",
      "not_started",
    ),
    relationship(
      53,
      "Publish ticket workflow documentation",
      "blocks",
      "blocked",
    ),
  ]);
  seed(31, "depends_on", [
    relationship(
      21,
      "Migrate persisted relationship records",
      "depends_on",
      "done",
    ),
  ]);
  seed(35, "depends_on", []);
  seed(
    38,
    "depends_on",
    [
      relationship(
        18,
        "Review query performance on large projects",
        "depends_on",
        "in_progress",
        "platform",
      ),
    ],
    "platform",
  );
  seed(21, "depends_on", []);
  seed(18, "depends_on", [], "platform");
  seed(51, "blocks", [
    relationship(
      61,
      "Measure adoption and follow-up issues",
      "blocks",
      "not_started",
    ),
  ]);
  seed(53, "blocks", []);
  seed(61, "blocks", []);
  return client;
}

function Harness({
  empty = false,
  fetchPrerequisites = false,
}: {
  empty?: boolean;
  fetchPrerequisites?: boolean;
}) {
  const [client] = useState(() => {
    const next = makeClient(empty);
    if (fetchPrerequisites)
      next.removeQueries({
        queryKey: ticketKeys.relationships("command-center", 42, "depends_on"),
        exact: true,
      });
    return next;
  });
  return (
    <QueryClientProvider client={client}>
      <div className="min-h-screen bg-bg-void p-xl max-768:p-md">
        <div className="mx-auto flex max-w-[1440px] flex-col gap-xl">
          <div className="flex flex-col gap-sm">
            <h1 className="m-0 font-display text-[1.35rem] text-text-primary">
              Ticket dependencies
            </h1>
            <p className="m-0 font-mono text-[0.78rem] text-text-secondary">
              command-center#42 · Ship the ticket workspace
            </p>
          </div>
          <TicketDependencyMap ticket={focus} />
        </div>
      </div>
    </QueryClientProvider>
  );
}

const meta = {
  title: "Tickets/Dependency map",
  component: TicketDependencyMap,
  parameters: { layout: "fullscreen", nextjs: { appDirectory: true } },
  args: { ticket: focus },
} satisfies Meta<typeof TicketDependencyMap>;
export default meta;
type Story = StoryObj<typeof meta>;

export const BothDirections: Story = { render: () => <Harness /> };
export const ExpandedChains: Story = {
  render: () => <Harness />,
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await userEvent.click(
      await canvas.findByRole("button", {
        name: "Expand prerequisites for command-center#31",
      }),
    );
    await userEvent.click(
      canvas.getByRole("button", {
        name: "Expand dependents for command-center#51",
      }),
    );
    await expect(
      canvas.findByText("Migrate persisted relationship records"),
    ).resolves.toBeVisible();
    await expect(
      canvas.findByText("Measure adoption and follow-up issues"),
    ).resolves.toBeVisible();
  },
};
export const NoDependencies: Story = { render: () => <Harness empty /> };
export const Narrow: Story = {
  render: () => <Harness />,
  globals: { viewport: { value: "mobile1", isRotated: false } },
};

function mockPrerequisiteRequest(mode: "loading" | "error") {
  const original = globalThis.fetch;
  let attempts = 0;
  globalThis.fetch = async (input, init) => {
    const url = new URL(
      typeof input === "string"
        ? input
        : input instanceof URL
          ? input.href
          : input.url,
      window.location.origin,
    );
    if (
      url.pathname !==
        "/api/projects/command-center/tickets/42/relationships" ||
      url.searchParams.get("role") !== "depends_on"
    )
      return original(input, init);
    if (mode === "loading") return new Promise<Response>(() => {});
    attempts += 1;
    if (attempts === 1)
      return Response.json(
        { error: "Relationship index temporarily unavailable." },
        { status: 503 },
      );
    return Response.json({
      items: [
        relationship(
          31,
          "Define ticket relationship semantics",
          "depends_on",
          "done",
        ),
      ],
      total: 1,
      nextCursor: null,
    });
  };
  return () => {
    globalThis.fetch = original;
  };
}

export const LoadingDirection: Story = {
  beforeEach: () => mockPrerequisiteRequest("loading"),
  render: () => <Harness fetchPrerequisites />,
};

export const FailedDirection: Story = {
  beforeEach: () => mockPrerequisiteRequest("error"),
  render: () => <Harness fetchPrerequisites />,
};

export const RetryDirection: Story = {
  ...FailedDirection,
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await userEvent.click(
      await canvas.findByRole("button", { name: "Retry prerequisites" }),
    );
    await expect(
      canvas.findByText("Define ticket relationship semantics"),
    ).resolves.toBeVisible();
    await expect(
      canvas.getByText("Roll out the workspace to existing projects"),
    ).toBeVisible();
  },
};
