// @vitest-environment jsdom
import { afterEach, beforeAll, describe, expect, it } from "vitest";
import { cleanup, screen } from "@testing-library/react";
import { composeStories } from "@storybook/react";
import { storybookAnnotations } from "@/test/storybook-setup";
import * as stories from "./Badge.stories";

beforeAll(storybookAnnotations.beforeAll);
afterEach(cleanup);

const { Matrix, TicketMotion } = composeStories(stories);

describe("Badge stories", () => {
  it("Matrix renders all five work-type badges with their kind identity", async () => {
    await Matrix.run();

    for (const kind of [
      "feature",
      "bug",
      "research",
      "tech_debt",
      "performance",
    ]) {
      const badge = document.querySelector(`[data-type="${kind}"]`);
      expect(badge, `missing work-type badge: ${kind}`).not.toBeNull();
    }
  });

  it("TicketMotion demonstrates the theme animation tokens on ticket tiles", async () => {
    await TicketMotion.run();

    expect(screen.getByText(/drag-commit wash/i)).toBeDefined();
    expect(document.querySelector(".animate-tk-card-land")).not.toBeNull();
    expect(document.querySelector(".animate-tk-sse-in")).not.toBeNull();
  });
});
