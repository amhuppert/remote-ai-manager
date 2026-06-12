// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act } from "react";
import { fireEvent, render, screen } from "@testing-library/react";
import { useNotificationStore } from "@/stores/notification.store";
import InputNeededToastContainer from "./InputNeededToastContainer";

const pushMock = vi.fn();

vi.mock("next/navigation", () => ({
  useRouter: () => ({ push: pushMock }),
}));

function resetStore() {
  useNotificationStore.setState({
    jobs: new Map(),
    toastQueue: [],
    inputToastQueue: [],
    promptErrorQueue: [],
  });
}

describe("InputNeededToastContainer", () => {
  beforeEach(() => {
    pushMock.mockClear();
    resetStore();
  });

  afterEach(() => {
    resetStore();
  });

  it("routes project-scoped input-needed toasts to the cockpit focus URL", async () => {
    act(() => {
      useNotificationStore.getState().enqueueInputToast({
        scope: "project",
        projectName: "my-project",
        conversationId: "project-convo-1",
        displayContext: "main",
        href: "/projects/my-project?focus=project-convo-1",
      });
    });

    render(<InputNeededToastContainer />);

    expect(screen.getByText("my-project / main")).toBeInTheDocument();

    act(() => {
      fireEvent.click(screen.getByRole("button", { name: "View" }));
    });

    expect(pushMock).toHaveBeenCalledWith(
      "/projects/my-project?focus=project-convo-1",
    );
    expect(useNotificationStore.getState().inputToastQueue).toEqual([]);
  });

  it("routes session input-needed toasts to the conversations page", async () => {
    act(() => {
      useNotificationStore.getState().enqueueInputToast({
        projectName: "my-project",
        sessionName: "my-session",
        conversationId: "conv-1",
      });
    });

    render(<InputNeededToastContainer />);

    expect(screen.getByText("my-project / my-session")).toBeInTheDocument();
    expect(screen.getByText("Needs input")).toBeInTheDocument();

    act(() => {
      fireEvent.click(screen.getByRole("button", { name: "View" }));
    });

    expect(pushMock).toHaveBeenCalledWith("/conversations?c=conv-1");
  });

  it("renders a custom toast title when the item carries one", async () => {
    act(() => {
      useNotificationStore.getState().enqueueInputToast({
        projectName: "my-project",
        sessionName: "my-session",
        conversationId: "conv-1",
        title: "Awaiting your approval",
      });
    });

    render(<InputNeededToastContainer />);

    expect(screen.getByText("Awaiting your approval")).toBeInTheDocument();
    expect(screen.queryByText("Needs input")).toBeNull();
  });

  it("renders the approval variant with context detail and a Review action", async () => {
    act(() => {
      useNotificationStore.getState().enqueueInputToast({
        projectName: "my-project",
        sessionName: "my-session",
        conversationId: "conv-1",
        title: "Approval required",
        variant: "approval",
        contextTitle: "api-hardening",
      });
    });

    render(<InputNeededToastContainer />);

    expect(screen.getByText("Approval required")).toBeInTheDocument();
    expect(
      screen.getByText("api-hardening · my-project / my-session"),
    ).toBeInTheDocument();

    act(() => {
      fireEvent.click(screen.getByRole("button", { name: "Review" }));
    });

    expect(pushMock).toHaveBeenCalledWith("/conversations?c=conv-1");
  });
});
