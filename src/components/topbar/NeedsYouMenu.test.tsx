// @vitest-environment jsdom
import { render, screen, within } from "@testing-library/react";
import { describe, expect, it } from "vitest";

import { NeedsYouMenu, type NeedsYouItem } from "./NeedsYouMenu";

const NOW_MS = Date.parse("2026-07-17T16:00:00.000Z");

const items: NeedsYouItem[] = [
  {
    id: "signoff",
    source: "active-work",
    kind: "spec",
    label: "Sign-off blocked",
    title: "native-sdd rev 4",
    detail:
      "Precondition unmet: blocking thread on R6 unresolved · A2 rejected, cited by D4",
    occurredAt: "2026-07-17T15:58:00.000Z",
    href: "/specs/command-center/native-sdd?el=R6",
  },
  {
    id: "waiver",
    source: "active-work",
    kind: "spec",
    label: "Waiver requested",
    title: "native-sdd/R3.2",
    detail: "EX-7 agent requests a waiver — only you can grant it",
    occurredAt: "2026-07-17T15:54:00.000Z",
    href: "/specs/command-center/native-sdd?el=R3.2",
  },
];

describe("NeedsYouMenu", () => {
  it("keeps the menu trigger free of native button styling", () => {
    render(<NeedsYouMenu items={items} nowMs={NOW_MS} />);

    expect(
      screen.getByRole("button", {
        name: "Needs you: 2 items need your decision",
      }),
    ).toHaveClass("appearance-none", "border-0", "bg-transparent", "p-0");
  });

  it("routes phase, detail, time, and the exact decision through compact attention rows", () => {
    render(<NeedsYouMenu items={items} nowMs={NOW_MS} defaultOpen />);

    expect(
      screen.getByRole("button", {
        name: "Needs you: 2 items need your decision",
      }),
    ).toHaveTextContent("2need you· sign-off blocked");

    const menu = screen.getByRole("menu", { name: "Needs you, 2 items" });
    expect(within(menu).getByText("Needs you")).toBeVisible();
    const rows = within(menu).getAllByRole("menuitem");
    expect(rows).toHaveLength(2);
    expect(rows[0]).toHaveAccessibleName(
      "Sign-off blocked: native-sdd rev 4. Precondition unmet: blocking thread on R6 unresolved · A2 rejected, cited by D4. 2m",
    );
    expect(rows[0]).toHaveAttribute(
      "href",
      "/specs/command-center/native-sdd?el=R6",
    );
    expect(within(rows[0]!).getByText("2m").closest("time")).toHaveAttribute(
      "dateTime",
      "2026-07-17T15:58:00.000Z",
    );
  });

  it("supports controlled opening for command invocation", () => {
    const { rerender } = render(
      <NeedsYouMenu items={items} nowMs={NOW_MS} open={false} />,
    );

    expect(screen.queryByRole("menu", { name: /Needs you/i })).toBeNull();

    rerender(<NeedsYouMenu items={items} nowMs={NOW_MS} open />);

    expect(
      screen.getByRole("menu", { name: "Needs you, 2 items" }),
    ).toBeVisible();
  });
});
