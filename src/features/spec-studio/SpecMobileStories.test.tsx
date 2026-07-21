// @vitest-environment jsdom
import { render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";

import detailMeta from "./SpecDetailPage.stories";
import evidenceMeta from "./SpecEvidenceLintTrace.stories";
import reviewMeta from "./SpecReviewMode.stories";

describe("Spec Studio mobile stories", () => {
  afterEach(() => {
    document.body.innerHTML = "";
  });

  it.each([
    ["detail", detailMeta.decorators[0]!],
    ["review", reviewMeta.decorators[0]!],
    ["evidence", evidenceMeta.decorators[0]!],
  ])("keeps the tall %s surface vertically reachable", (_name, decorate) => {
    render(decorate(() => <div />));

    expect(screen.getByRole("main")).toHaveClass("h-screen", "overflow-y-auto");
  });
});
