// @vitest-environment jsdom
import { describe, it, expect, vi } from "vitest";
import { render, screen, fireEvent } from "@testing-library/react";
import { ConfigSaveBar } from "./ConfigSaveBar";

describe("ConfigSaveBar", () => {
  it("shows clean message and disables both buttons when no changes", () => {
    render(
      <ConfigSaveBar
        dirtyCount={0}
        invalidCount={0}
        saving={false}
        onRevert={() => {}}
        onSave={() => {}}
      />,
    );
    expect(screen.getByText(/All changes saved/i)).toBeVisible();
    expect(screen.getByRole("button", { name: /Revert/i })).toBeDisabled();
    expect(
      screen.getByRole("button", { name: /Save changes/i }),
    ).toBeDisabled();
  });

  it("singularizes unsaved-change copy", () => {
    render(
      <ConfigSaveBar
        dirtyCount={1}
        invalidCount={0}
        saving={false}
        onRevert={() => {}}
        onSave={() => {}}
      />,
    );
    expect(screen.getByText(/unsaved change$/i)).toBeVisible();
  });

  it("pluralizes unsaved-changes copy", () => {
    render(
      <ConfigSaveBar
        dirtyCount={3}
        invalidCount={0}
        saving={false}
        onRevert={() => {}}
        onSave={() => {}}
      />,
    );
    expect(screen.getByText(/unsaved changes$/i)).toBeVisible();
    expect(screen.getByText("3")).toBeVisible();
  });

  it("calls onRevert and onSave when clicking the action buttons", () => {
    const onRevert = vi.fn();
    const onSave = vi.fn();
    render(
      <ConfigSaveBar
        dirtyCount={2}
        invalidCount={0}
        saving={false}
        onRevert={onRevert}
        onSave={onSave}
      />,
    );
    fireEvent.click(screen.getByRole("button", { name: /Revert/i }));
    fireEvent.click(screen.getByRole("button", { name: /Save changes/i }));
    expect(onRevert).toHaveBeenCalledTimes(1);
    expect(onSave).toHaveBeenCalledTimes(1);
  });

  it("renders Saving... and disables buttons while saving", () => {
    render(
      <ConfigSaveBar
        dirtyCount={1}
        invalidCount={0}
        saving={true}
        onRevert={() => {}}
        onSave={() => {}}
      />,
    );
    expect(
      screen.getByRole("button", { name: /Saving\.\.\./i }),
    ).toBeDisabled();
    expect(screen.getByRole("button", { name: /Revert/i })).toBeDisabled();
  });

  it("blocks saving invalid local input while keeping Revert available", () => {
    render(
      <ConfigSaveBar
        dirtyCount={0}
        invalidCount={1}
        saving={false}
        onRevert={() => {}}
        onSave={() => {}}
      />,
    );

    expect(screen.getByText(/1 invalid field/i)).toBeVisible();
    expect(
      screen.getByRole("button", { name: /Save changes/i }),
    ).toBeDisabled();
    expect(screen.getByRole("button", { name: /Revert/i })).toBeEnabled();
  });
});
