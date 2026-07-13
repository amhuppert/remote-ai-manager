// @vitest-environment jsdom
import { describe, it, expect, beforeAll, vi } from "vitest";
import { screen } from "@testing-library/react";
import { composeStories } from "@storybook/react";
import { storybookAnnotations } from "@/test/storybook-setup";
import * as stories from "./CreateSessionModal.stories";

vi.mock("next/navigation", () => ({
  useRouter: () => ({ push: vi.fn(), replace: vi.fn(), back: vi.fn() }),
  usePathname: () => "/",
  useSearchParams: () => new URLSearchParams(),
}));

vi.mock("@/lib/sessions/mutations", () => ({
  useCreateSessionMutation: () => ({ mutate: vi.fn(), isPending: false }),
}));

vi.mock("@/hooks/useVoiceRecorder", () => ({
  useVoiceRecorder: () => ({
    isRecording: false,
    isProcessing: false,
    elapsedTime: 0,
    isAvailable: false,
    toggleRecording: vi.fn(),
    stopRecording: vi.fn(),
    cancelRecording: vi.fn(),
  }),
}));

vi.mock("@/components/VoiceRecordButton", () => ({
  VoiceRecordButton: () => null,
}));

beforeAll(storybookAnnotations.beforeAll);

const { Default, Closed } = composeStories(stories);

describe("CreateSessionModal stories", () => {
  it("Default renders form with session name input", async () => {
    await Default.run();
    expect(screen.getByText("New Session")).toBeInTheDocument();
    expect(screen.getByLabelText("Session name")).toBeInTheDocument();
    expect(
      screen.getByRole("button", { name: "Create Session" }),
    ).toBeInTheDocument();
    expect(screen.getByText("Cancel")).toBeInTheDocument();
  });

  it("Closed renders nothing when open=false", async () => {
    await Closed.run();
    expect(screen.queryByText("New Session")).toBeNull();
  });
});
