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
  phase: { primary: "draft", authoringStage: "plan" },
  linkedTasks: [
    {
      taskElementId: "task-17",
      taskHandle: "T17",
      sourceTaskState: "current",
    },
  ],
} satisfies TicketSpecReadThrough["specs"][number];

describe("LinkedSpecReadThrough", () => {
  it("presents authoring phase and historical linked task references", () => {
    render(
      <LinkedSpecReadThrough projectName="command-center" spec={linkedSpec} />,
    );

    expect(
      screen.getByRole("link", {
        name: /native-sdd.*Draft.*plan/,
      }),
    ).toHaveAttribute("href", "/specs/command-center/native-sdd");
    expect(
      screen.getByRole("link", { name: "native-sdd/T17" }),
    ).toHaveAttribute("href", "/specs/command-center/native-sdd?el=T17");
    expect(
      screen.getByText("Computed at query time — not editable here"),
    ).toBeVisible();
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
    expect(screen.getByText("Source task changed")).toBeInTheDocument();
    expect(
      screen.getByText(
        /materialized from native-sdd\/T17.*re-scoped in rev 5.*never synced/i,
      ),
    ).toBeVisible();
  });
});
