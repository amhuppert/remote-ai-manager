// @vitest-environment jsdom
import { render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { ButtonLink } from "./Button";

vi.mock(
  "next/link",
  async () => (await import("@/test/component-mocks")).nextLinkMock,
);

describe("ButtonLink", () => {
  it("is a link to its destination, so it opens in a new tab like any link", () => {
    render(
      <ButtonLink href="/projects/plc/fx/runs?run=run-1" variant="ghost">
        Open run
      </ButtonLink>,
    );

    expect(screen.getByRole("link", { name: "Open run" })).toHaveAttribute(
      "href",
      "/projects/plc/fx/runs?run=run-1",
    );
  });
});
