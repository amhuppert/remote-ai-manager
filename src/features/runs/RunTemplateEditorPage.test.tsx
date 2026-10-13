// @vitest-environment jsdom
import { act, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { TooltipProvider } from "@/components/ui/Tooltip";
import type { RunTemplateRecord } from "@/lib/run-templates/document";
import { runTemplateKeys } from "@/lib/run-templates/query-keys";
import { RUN_SETTING_DEFAULTS } from "@/lib/runs/settings";
import { createTestQueryClient, renderWithQuery } from "@/test/component-mocks";
import { installFetchFixture, type FetchFixture } from "@/test/fetch-fixture";
import RunTemplateEditorPage from "./RunTemplateEditorPage";
import {
  checkoutTemplate,
  modelOptions,
  profileOptions,
  templateList,
} from "./template-fixtures";

const params = vi.hoisted(() => ({
  name: "plc",
  session: "fx",
  tier: "project",
  id: "checkout-rollout",
}));
vi.mock("next/navigation", () => ({
  useParams: () => params,
  usePathname: () => "/projects/plc/fx/runs/templates",
  useRouter: () => ({ push: vi.fn(), replace: vi.fn(), back: vi.fn() }),
  useSearchParams: () => new URLSearchParams(),
}));
vi.mock(
  "next/link",
  async () => (await import("@/test/component-mocks")).nextLinkMock,
);

const failure = { status: 500, json: { error: "The server is restarting" } };

let api: FetchFixture;
let detail: { status?: number; json: unknown };
let models: { status?: number; json: unknown };

function detailUrl(): string {
  return `/api/projects/plc/run-templates/${params.tier}/checkout-rollout`;
}

function stored(record: RunTemplateRecord) {
  return { json: { template: record, globals: RUN_SETTING_DEFAULTS } };
}

beforeEach(() => {
  params.tier = "project";
  detail = stored(checkoutTemplate);
  models = { json: { backends: modelOptions } };
  api = installFetchFixture();
  api.reply(
    "GET",
    /\/api\/projects\/plc\/run-templates\/(project|global)\/checkout-rollout$/,
    () => detail,
  );
  api.json("GET", "/api/projects/plc/run-templates", {
    items: templateList,
    diagnostics: [],
  });
  api.reply("GET", "/api/projects/plc/model-options", () => models);
  const listing = { profiles: profileOptions, diagnostics: [] };
  api.json("GET", "/api/projects/plc/agent-profiles", listing);
  api.json("GET", "/api/agent-profiles", {
    profiles: profileOptions.filter(
      (profile) => profile.ref.tier !== "project",
    ),
    diagnostics: [],
  });
  api.json("GET", "/api/validation-commands", {
    projects: [
      {
        projectName: "plc",
        commands: [
          {
            name: "typecheck",
            cost: 1,
            pathArgs: "forbid",
            changedScope: "native",
          },
        ],
      },
      {
        projectName: "elsewhere",
        commands: [
          {
            name: "elsewhere-only",
            cost: 1,
            pathArgs: "forbid",
            changedScope: "native",
          },
        ],
      },
    ],
  });
});
afterEach(() => api.restore());

function renderPage() {
  const queryClient = createTestQueryClient();
  renderWithQuery(
    <TooltipProvider>
      <RunTemplateEditorPage />
    </TooltipProvider>,
    queryClient,
  );
  return { queryClient };
}

const nameField = () => screen.getByRole("textbox", { name: "Name" });

async function refreshDetail(
  queryClient: ReturnType<typeof renderPage>["queryClient"],
) {
  await act(() =>
    queryClient.invalidateQueries({
      queryKey: runTemplateKeys.detail("plc", "project", "checkout-rollout"),
    }),
  );
}

describe("the run template editor page", () => {
  it("keeps the draft and its base revision through a failed refresh and its retry", async () => {
    const user = userEvent.setup();
    const { queryClient } = renderPage();
    await screen.findByRole("textbox", { name: "Name" });
    await user.clear(nameField());
    await user.type(nameField(), "Local edit");

    detail = failure;
    await refreshDetail(queryClient);

    const refresh = await screen.findByRole("alert", {
      name: /could not refresh/i,
    });
    expect(refresh).toHaveTextContent("The server is restarting");
    expect(nameField()).toHaveValue("Local edit");

    detail = stored(checkoutTemplate);
    await user.click(within(refresh).getByRole("button", { name: "Retry" }));
    await waitFor(() =>
      expect(
        screen.queryByRole("alert", { name: /could not refresh/i }),
      ).toBeNull(),
    );
    expect(nameField()).toHaveValue("Local edit");

    api.json("PUT", detailUrl(), {
      template: { ...checkoutTemplate, revision: 5 },
    });
    await user.click(
      screen.getByRole("button", { name: "Save as revision 5" }),
    );
    await waitFor(() =>
      expect(api.requestsTo("PUT", detailUrl())[0]?.jsonBody).toEqual({
        expectedRevision: 4,
        template: expect.objectContaining({ name: "Local edit" }),
      }),
    );
  });

  it("does not take a failed reload for the latest revision after a conflict", async () => {
    const user = userEvent.setup();
    renderPage();
    await screen.findByRole("textbox", { name: "Name" });
    await user.clear(nameField());
    await user.type(nameField(), "Local edit");
    api.reply("PUT", detailUrl(), {
      status: 409,
      json: {
        error: "Run template project:checkout-rollout is at revision 5, not 4",
        code: "run_template_revision_conflict",
        details: { currentRevision: 5 },
      },
    });
    await user.click(
      screen.getByRole("button", { name: "Save as revision 5" }),
    );
    await screen.findByText("A newer revision was saved while you edited");

    detail = failure;
    await user.click(screen.getByRole("button", { name: "Reload latest" }));
    await user.click(
      screen.getByRole("button", { name: "Discard and reload" }),
    );

    await waitFor(() =>
      expect(
        screen
          .getAllByRole("alert")
          .some((alert) =>
            alert.textContent?.includes("The server is restarting"),
          ),
      ).toBe(true),
    );
    expect(
      screen.getByText("A newer revision was saved while you edited"),
    ).toBeInTheDocument();
    expect(nameField()).toHaveValue("Local edit");

    detail = stored({ ...checkoutTemplate, revision: 5, name: "Reloaded" });
    await user.click(screen.getByRole("button", { name: "Reload latest" }));
    await user.click(
      screen.getByRole("button", { name: "Discard and reload" }),
    );
    await waitFor(() => expect(nameField()).toHaveValue("Reloaded"));
    expect(
      screen.queryByText("A newer revision was saved while you edited"),
    ).toBeNull();
  });

  it("names a failed option read and opens the editor only once the options arrive", async () => {
    const user = userEvent.setup();
    models = failure;
    const { queryClient } = renderPage();

    const message = await screen.findByText(/Could not load the model options/);
    const failed = message.closest<HTMLElement>('[role="alert"]');
    if (failed === null) throw new Error("the failure is not an alert");
    expect(screen.queryByRole("textbox", { name: "Name" })).toBeNull();

    models = { json: { backends: modelOptions } };
    await user.click(within(failed).getByRole("button", { name: "Try again" }));
    await screen.findByRole("textbox", { name: "Name" });

    models = failure;
    await act(() => queryClient.invalidateQueries());
    expect(
      await screen.findByRole("alert", { name: /could not refresh/i }),
    ).toHaveTextContent("model options");
    expect(nameField()).toBeInTheDocument();
  });

  it("offers a global template only global profiles, and this project's checks verified at launch", async () => {
    const user = userEvent.setup();
    params.tier = "global";
    renderPage();
    await screen.findByRole("textbox", { name: "Name" });

    expect(api.requestsTo("GET", "/api/agent-profiles")).toHaveLength(1);
    expect(
      api.requestsTo("GET", "/api/projects/plc/agent-profiles"),
    ).toHaveLength(0);
    const checks = screen.getByRole("region", { name: "Checks" });
    expect(checks).toHaveTextContent("verified when the template is launched");

    await user.click(
      within(checks).getByRole("button", { name: "Remove typecheck" }),
    );
    await user.click(
      within(checks).getByRole("combobox", { name: "Add a check" }),
    );
    const offered = screen
      .getAllByRole("option")
      .map((option) => option.textContent);
    expect(offered).toContain("typecheck");
    expect(offered).not.toContain("elsewhere-only");
  });
});
