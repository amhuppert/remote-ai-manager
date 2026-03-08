// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, fireEvent, act } from "@testing-library/react";
import { KiroCommandButton } from "./KiroCommandButton";
import { KiroCommandProvider } from "./KiroCommandContext";
import type { KiroCommandContextValue } from "./KiroCommandContext";

// Mock next/navigation
vi.mock("next/navigation", () => ({
  useRouter: () => ({
    push: vi.fn(),
  }),
}));

// Mock mutations
vi.mock("@/lib/mutations", () => ({
  useCreateConversationMutation: () => ({
    mutateAsync: vi.fn().mockResolvedValue({ id: "new-conv-id" }),
    isPending: false,
  }),
}));

// Mock Zustand store
const mockSetPendingForkPrompt = vi.fn();
vi.mock("@/stores/session-detail.store", () => ({
  useSetPendingForkPrompt: () => mockSetPendingForkPrompt,
}));

function createContextValue(
  overrides?: Partial<KiroCommandContextValue>,
): KiroCommandContextValue {
  return {
    projectName: "test-project",
    sessionName: "test-session",
    conversationId: "conv-123",
    sendPrompt: vi.fn().mockResolvedValue(undefined),
    messageCount: 5,
    isBusy: false,
    selectedModel: undefined,
    ...overrides,
  };
}

function renderWithContext(
  ui: React.ReactElement,
  contextOverrides?: Partial<KiroCommandContextValue>,
) {
  const ctx = createContextValue(contextOverrides);
  return {
    ctx,
    ...render(<KiroCommandProvider {...ctx}>{ui}</KiroCommandProvider>),
  };
}

describe("KiroCommandButton", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("renders children text and a run button", () => {
    renderWithContext(
      <KiroCommandButton commandName="/kiro:spec-design" args="my-feat">
        /kiro:spec-design my-feat
      </KiroCommandButton>,
    );

    expect(screen.getByText("/kiro:spec-design my-feat")).toBeInTheDocument();
    expect(
      screen.getByRole("button", { name: /run.*command/i }),
    ).toBeInTheDocument();
  });

  it("disables button when session is busy", () => {
    renderWithContext(
      <KiroCommandButton commandName="/kiro:spec-design" args="my-feat">
        /kiro:spec-design
      </KiroCommandButton>,
      { isBusy: true },
    );

    expect(
      screen.getByRole("button", { name: /run.*command/i }),
    ).toBeDisabled();
  });

  it("opens popover on click", () => {
    renderWithContext(
      <KiroCommandButton commandName="/kiro:spec-design" args="my-feat">
        /kiro:spec-design
      </KiroCommandButton>,
    );

    fireEvent.click(screen.getByRole("button", { name: /run.*command/i }));
    expect(screen.getByText("Run Command")).toBeInTheDocument();
  });

  it("shows auto-approve toggle for applicable commands", () => {
    renderWithContext(
      <KiroCommandButton commandName="/kiro:spec-design" args="my-feat">
        /kiro:spec-design
      </KiroCommandButton>,
    );

    fireEvent.click(screen.getByRole("button", { name: /run.*command/i }));
    expect(screen.getByLabelText(/auto-approve/i)).toBeInTheDocument();
  });

  it("hides auto-approve toggle for non-applicable commands", () => {
    renderWithContext(
      <KiroCommandButton commandName="/kiro:spec-requirements" args="my-feat">
        /kiro:spec-requirements
      </KiroCommandButton>,
    );

    fireEvent.click(screen.getByRole("button", { name: /run.*command/i }));
    expect(screen.queryByLabelText(/auto-approve/i)).not.toBeInTheDocument();
  });

  it('"Run Here" sends correct prompt text', async () => {
    const sendPrompt = vi.fn().mockResolvedValue(undefined);
    renderWithContext(
      <KiroCommandButton commandName="/kiro:spec-design" args="my-feat">
        /kiro:spec-design
      </KiroCommandButton>,
      { sendPrompt, messageCount: 10 },
    );

    fireEvent.click(screen.getByRole("button", { name: /run.*command/i }));
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: /run here/i }));
    });

    expect(sendPrompt).toHaveBeenCalledWith(
      "/kiro:spec-design my-feat",
      10,
      undefined,
    );
  });

  it('"Run Here" with auto-approve sends prompt with -y', async () => {
    const sendPrompt = vi.fn().mockResolvedValue(undefined);
    renderWithContext(
      <KiroCommandButton commandName="/kiro:spec-design" args="my-feat">
        /kiro:spec-design
      </KiroCommandButton>,
      { sendPrompt, messageCount: 10 },
    );

    fireEvent.click(screen.getByRole("button", { name: /run.*command/i }));
    // Toggle auto-approve on
    fireEvent.click(screen.getByLabelText(/auto-approve/i));
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: /run here/i }));
    });

    expect(sendPrompt).toHaveBeenCalledWith(
      "/kiro:spec-design my-feat -y",
      10,
      undefined,
    );
  });

  it("closes popover on Escape", () => {
    renderWithContext(
      <KiroCommandButton commandName="/kiro:spec-design" args="my-feat">
        /kiro:spec-design
      </KiroCommandButton>,
    );

    fireEvent.click(screen.getByRole("button", { name: /run.*command/i }));
    expect(screen.getByText("Run Command")).toBeInTheDocument();

    fireEvent.keyDown(document, { key: "Escape" });
    expect(screen.queryByText("Run Command")).not.toBeInTheDocument();
  });

  it("renders plain text without button when outside context", () => {
    render(
      <KiroCommandButton commandName="/kiro:spec-design" args="my-feat">
        /kiro:spec-design
      </KiroCommandButton>,
    );

    expect(screen.getByText("/kiro:spec-design")).toBeInTheDocument();
    expect(
      screen.queryByRole("button", { name: /run.*command/i }),
    ).not.toBeInTheDocument();
  });
});
