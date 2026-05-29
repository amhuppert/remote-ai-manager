// @vitest-environment jsdom
import { render, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import ReactScanInstrumentation from "./ReactScanInstrumentation";

const scanMock = vi.fn();

vi.mock("react-scan", () => ({
  scan: scanMock,
}));

describe("ReactScanInstrumentation", () => {
  beforeEach(() => {
    scanMock.mockReset();
    delete window.__reactScanReport;
    delete window.__reactScanReset;
    window.history.pushState({}, "", "/projects/example/session");
  });

  it("does not enable render overlays unless scan is requested", async () => {
    render(<ReactScanInstrumentation />);
    await new Promise((resolve) => window.setTimeout(resolve, 20));
    expect(scanMock).not.toHaveBeenCalled();
    expect(window.__reactScanReport).toBeUndefined();
  });

  it("enables the render report when scan=1 is present", async () => {
    window.history.pushState({}, "", "/projects/example/session?scan=1");

    render(<ReactScanInstrumentation />);

    await waitFor(() => expect(scanMock).toHaveBeenCalledTimes(1));
    expect(window.__reactScanReport).toEqual([]);
    expect(window.__reactScanReset).toBeTypeOf("function");
  });
});
