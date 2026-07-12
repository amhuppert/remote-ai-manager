import { describe, expect, it, vi } from "vitest";
import { isValidElement } from "react";

const notFoundMock = vi.hoisted(() =>
  vi.fn(() => {
    throw new Error("NEXT_NOT_FOUND");
  }),
);

vi.mock("next/navigation", () => ({
  notFound: notFoundMock,
}));

import TicketDetailPage from "./TicketDetailPage";

describe("TicketDetailPage route params", () => {
  it.each([
    ["literal%20project", "literal project"],
    ["literal%2520project", "literal%20project"],
    ["malformed%project", "malformed%project"],
  ])(
    "decodes the framework project param %s exactly once",
    async (routeProjectName, expectedProjectName) => {
      const page = await TicketDetailPage({
        params: Promise.resolve({
          projectName: routeProjectName,
          number: "12",
        }),
      });

      expect(
        isValidElement<{ projectName: string; number: number }>(page),
      ).toBe(true);
      if (!isValidElement<{ projectName: string; number: number }>(page)) {
        throw new Error("Ticket detail page did not return a React element");
      }
      expect(page.props.projectName).toBe(expectedProjectName);
      expect(page.props.number).toBe(12);
    },
  );

  it.each(["0xC", "1e2", " 12 ", "+12", "012", "9007199254740992"])(
    "rejects the noncanonical ticket segment %j",
    async (number) => {
      await expect(
        TicketDetailPage({
          params: Promise.resolve({ projectName: "alpha", number }),
        }),
      ).rejects.toThrow("NEXT_NOT_FOUND");
    },
  );
});
