import { isValidElement } from "react";
import { describe, expect, it } from "vitest";

import ProjectDetailPage from "./ProjectDetailPage";

describe("ProjectDetailPage route params", () => {
  it.each([
    ["literal%20project", "literal project"],
    ["literal%2520project", "literal%20project"],
    ["malformed%project", "malformed%project"],
  ])(
    "decodes the framework route param %s exactly once",
    async (routeName, expectedName) => {
      const page = await ProjectDetailPage({
        params: Promise.resolve({ name: routeName }),
      });

      expect(isValidElement<{ projectName: string }>(page)).toBe(true);
      if (!isValidElement<{ projectName: string }>(page)) {
        throw new Error("Project detail page did not return a React element");
      }
      expect(page.props.projectName).toBe(expectedName);
    },
  );
});
