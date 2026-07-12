import { isValidElement } from "react";
import { describe, expect, it } from "vitest";

import SessionListPage from "./SessionListPage";

describe("SessionListPage route params", () => {
  it.each([
    ["literal%20project", "literal project"],
    ["literal%2520project", "literal%20project"],
    ["malformed%project", "malformed%project"],
  ])(
    "decodes the framework project param %s exactly once",
    async (routeName, expectedName) => {
      const page = await SessionListPage({
        params: Promise.resolve({ name: routeName, session: "ticket session" }),
      });

      expect(
        isValidElement<{ projectName: string; sessionName: string }>(page),
      ).toBe(true);
      if (!isValidElement<{ projectName: string; sessionName: string }>(page)) {
        throw new Error("Session list page did not return a React element");
      }
      expect(page.props.projectName).toBe(expectedName);
      expect(page.props.sessionName).toBe("ticket session");
    },
  );

  it("decodes the session param exactly once", async () => {
    const page = await SessionListPage({
      params: Promise.resolve({
        name: "project",
        session: "ticket%2520session",
      }),
    });

    if (!isValidElement<{ sessionName: string }>(page)) {
      throw new Error("Session list page did not return a React element");
    }
    expect(page.props.sessionName).toBe("ticket%20session");
  });
});
