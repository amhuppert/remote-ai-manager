// @vitest-environment jsdom
import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";

import type { TicketSpecReadThrough } from "@/lib/specs/queries";

import { LinkedSpecReadThrough } from "./TicketSpecsCard";

const linkedSpec = {
  specId: "spec-native-sdd",
  slug: "native-sdd",
  name: "Native spec-driven development",
  revision: 4,
  phase: { primary: "executing", authoringFacet: "draft" },
  criteriaProgress: { proven: 7, total: 12 },
  linkedTasks: [
    {
      taskElementId: "task-17",
      taskHandle: "T17",
      sourceTaskState: "current",
      workStatus: "running",
    },
  ],
} satisfies TicketSpecReadThrough["specs"][number];

describe("LinkedSpecReadThrough", () => {
  it("presents live phase, linked task chips, and criterion progress", () => {
    render(
      <LinkedSpecReadThrough projectName="command-center" spec={linkedSpec} />,
    );

    expect(
      screen.getByRole("link", {
        name: /native-sdd.*Executing.*Draft/,
      }),
    ).toHaveAttribute("href", "/specs/command-center/native-sdd");
    expect(screen.getByText("7/12 criteria proven")).toBeInTheDocument();
    expect(
      screen.getByRole("progressbar", {
        name: "7 of 12 criteria proven",
      }),
    ).toHaveAttribute("aria-valuenow", "7");
    expect(
      screen.getByRole("link", { name: "native-sdd/T17" }),
    ).toHaveAttribute("href", "/specs/command-center/native-sdd?el=T17");
    expect(
      screen.getByText("Computed at query time — not editable here"),
    ).toBeVisible();
    expect(screen.getByText("7/12 in-scope criteria proven")).toBeVisible();
    expect(screen.getByText(/ticket persists only the link/i)).toBeVisible();
  });

  it("surfaces source-task drift without implying ticket/spec synchronization", () => {
    render(
      <LinkedSpecReadThrough
        projectName="command-center"
        spec={{
          ...linkedSpec,
          revision: 5,
          linkedTasks: [
            {
              ...linkedSpec.linkedTasks[0]!,
              sourceTaskState: "changed",
            },
          ],
        }}
      />,
    );

    expect(screen.getByText("source task removed/changed")).toBeVisible();
    expect(screen.getByText("Source task changed")).toHaveClass("sr-only");
    expect(
      screen.getByText(
        /materialized from native-sdd\/T17.*re-scoped in rev 5.*never synced/i,
      ),
    ).toBeVisible();
  });
});
