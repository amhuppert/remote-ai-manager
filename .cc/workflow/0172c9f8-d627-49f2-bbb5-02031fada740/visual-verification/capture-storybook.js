async (page) => {
  const baseUrl = "http://localhost:6007";
  const outputDir =
    ".cc/workflow/peek-replay-visual-verification/visual-verification/storybook";
  const widths = [1180, 1080, 960, 760];
  const stories = [
    {
      id: "session-peekpopover--new",
      slug: "new",
    },
    {
      id: "session-peekpopover--running",
      slug: "running",
    },
    {
      id: "session-peekpopover--awaiting",
      slug: "awaiting",
    },
    {
      id: "session-peekpopover--waiting-for-input-structured-single-select",
      slug: "waiting_for_input-structured-single",
    },
    {
      id: "session-peekpopover--waiting-for-input-structured-multi-select-other",
      slug: "waiting_for_input-structured-multi-other",
    },
    {
      id: "session-peekpopover--waiting-for-input-fallback-banner",
      slug: "waiting_for_input-fallback-banner",
    },
  ];

  const waitForPeek = async () => {
    await page.waitForSelector(".peek", { state: "visible", timeout: 15000 });
    await page.evaluate(
      () =>
        document.fonts?.ready ??
        new Promise((resolve) => window.setTimeout(resolve, 250)),
    );
    await page.waitForTimeout(250);
  };

  for (const width of widths) {
    await page.setViewportSize({ width, height: 800 });

    for (const story of stories) {
      await page.goto(`${baseUrl}/iframe.html?id=${story.id}`, {
        waitUntil: "networkidle",
      });
      await waitForPeek();
      await page.screenshot({
        path: `${outputDir}/${story.slug}-${width}.png`,
        fullPage: true,
      });

      if (story.slug === "waiting_for_input-structured-multi-other") {
        const other = page
          .locator(".ask-question-option")
          .filter({ hasText: "Other" })
          .locator("input")
          .first();
        await other.check();
        const textbox = page.getByPlaceholder("Type your answer...");
        await textbox.fill("");
        await textbox.focus();
        await page.waitForTimeout(150);
        await page.screenshot({
          path: `${outputDir}/waiting_for_input-structured-multi-other-focused-${width}.png`,
          fullPage: true,
        });
      }
    }
  }
};
