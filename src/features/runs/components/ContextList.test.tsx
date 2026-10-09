// @vitest-environment jsdom
import { afterEach, expect, it, vi } from "vitest";
import { cleanup, render, screen } from "@testing-library/react";
import { checkoutLoopRun } from "../fixtures";
import { ContextList } from "./ContextList";

afterEach(cleanup);

it("keeps loop progress and publication checks visible for a run entirely in lanes", () => {
  render(<ContextList contexts={checkoutLoopRun.contexts.map(context => ({ ...context, placement: { kind: "lane", lane: "ui" } }))}
    lanes={checkoutLoopRun.lanes.filter(lane => lane.key === "ui")} loops={checkoutLoopRun.loops}
    selectedKey={null} onSelect={vi.fn()} onRetryLane={vi.fn()} />);
  expect(screen.getByText("Pass 2 of 3")).toBeTruthy();
  expect(screen.getByText("Publication checks")).toBeTruthy();
});
