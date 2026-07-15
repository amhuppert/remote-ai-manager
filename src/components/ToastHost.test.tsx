// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act } from "react";
import { fireEvent, render, screen } from "@testing-library/react";
import { useNotificationStore } from "@/stores/notification.store";
import { useToastStoreForTesting } from "@/stores/toast.store";
import ToastHost from "./ToastHost";

const pushMock = vi.fn();

vi.mock("next/navigation", () => ({
  useRouter: () => ({ push: pushMock }),
}));

function resetStores() {
  useNotificationStore.setState({
    jobs: new Map(),
    toastQueue: [],
    inputToastQueue: [],
    promptErrorQueue: [],
  });
  useToastStoreForTesting.setState({ toasts: [] });
}

describe("ToastHost", () => {
  beforeEach(() => {
    pushMock.mockClear();
    resetStores();
  });

  afterEach(() => {
    resetStores();
  });

  it("renders a merge toast from the merge queue and routes on action", () => {
    act(() => {
      useNotificationStore.setState({
        toastQueue: [
          {
            id: "n1",
            source: "job",
            type: "merge-completed",
            projectName: "my-project",
            sessionName: "my-session",
            branchName: "csm/feature",
            targetBranch: "main",
            jobId: "job-1",
            jobType: "merge",
            read: false,
            createdAt: new Date().toISOString(),
            title: "Merge complete",
            message: "csm/feature merged into main",
          },
        ],
      });
    });

    render(<ToastHost />);

    expect(screen.getByText("Merge complete")).toBeInTheDocument();

    act(() => {
      fireEvent.click(screen.getByRole("button", { name: "View" }));
    });

    expect(pushMock).toHaveBeenCalledWith("/projects/my-project/my-session");
  });

  it("renders a session input-needed toast and routes to the conversations page", () => {
    act(() => {
      useNotificationStore.getState().enqueueInputToast({
        projectName: "my-project",
        sessionName: "my-session",
        conversationId: "conv-1",
      });
    });

    render(<ToastHost />);

    expect(screen.getByText("my-project / my-session")).toBeInTheDocument();

    act(() => {
      fireEvent.click(screen.getByRole("button", { name: "View" }));
    });

    expect(pushMock).toHaveBeenCalledWith("/conversations?c=conv-1");
  });

  it("renders a project-scoped prompt-error toast and routes to the focus URL", () => {
    act(() => {
      useNotificationStore.getState().enqueuePromptErrorToast({
        scope: "project",
        projectName: "my-project",
        conversationId: "project-convo-1",
        displayContext: "main",
        href: "/projects/my-project?focus=project-convo-1",
        error: "Tool failed",
      });
    });

    render(<ToastHost />);

    expect(
      screen.getByText("my-project / main: Tool failed"),
    ).toBeInTheDocument();

    act(() => {
      fireEvent.click(screen.getByRole("button", { name: "View" }));
    });

    expect(pushMock).toHaveBeenCalledWith(
      "/projects/my-project?focus=project-convo-1",
    );
    expect(useNotificationStore.getState().promptErrorQueue).toEqual([]);
  });

  it("renders generic status toasts from the toast store", () => {
    act(() => {
      useToastStoreForTesting.setState({
        toasts: [{ id: "t1", message: "Archived 3 sessions", createdAt: 0 }],
      });
    });

    render(<ToastHost />);

    expect(screen.getByText("Archived 3 sessions")).toBeInTheDocument();
  });

  it("mounts every toast source simultaneously through one host", () => {
    act(() => {
      useNotificationStore.getState().enqueueInputToast({
        projectName: "my-project",
        sessionName: "my-session",
        conversationId: "conv-1",
      });
      useToastStoreForTesting.setState({
        toasts: [{ id: "t1", message: "Archived 3 sessions", createdAt: 0 }],
      });
    });

    render(<ToastHost />);

    expect(screen.getByText("my-project / my-session")).toBeInTheDocument();
    expect(screen.getByText("Archived 3 sessions")).toBeInTheDocument();
  });
});
