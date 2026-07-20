// @vitest-environment jsdom
import { render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { VoiceRecordButton } from "./VoiceRecordButton";

describe("VoiceRecordButton", () => {
  it("keeps an action-oriented accessible name in every rendered state", () => {
    const props = {
      isRecording: false,
      isProcessing: false,
      elapsedTime: 0,
      isAvailable: true,
      toggleRecording: vi.fn(),
    };
    const { rerender } = render(<VoiceRecordButton {...props} />);
    expect(
      screen.getByRole("button", { name: "Voice input" }),
    ).toBeInTheDocument();

    rerender(<VoiceRecordButton {...props} isRecording elapsedTime={1} />);
    const recordingButton = screen.getByRole("button", {
      name: "Stop recording",
    });
    expect(recordingButton).toBeInTheDocument();
    expect(recordingButton.className).toContain(
      "motion-safe:data-[recording=true]:animate-[voice-recording-pulse_1.5s_ease-in-out_infinite]",
    );

    rerender(<VoiceRecordButton {...props} isProcessing />);
    expect(
      screen.getByRole("button", { name: "Processing voice input" }),
    ).toBeDisabled();

    rerender(
      <VoiceRecordButton
        {...props}
        isAvailable={false}
        unavailableReason="Voice input requires a project"
      />,
    );
    expect(
      screen.getByRole("button", {
        name: "Voice input requires a project",
      }),
    ).toBeDisabled();
  });
});
