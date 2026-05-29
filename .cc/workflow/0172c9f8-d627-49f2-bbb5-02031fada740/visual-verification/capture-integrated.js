async (page) => {
  const appUrl =
    "http://localhost:3002/projects/command-center/Peek%20%26%20Replay/73ea91d1-b84f-4361-b2ab-3992bcfd65d5";
  const outputDir =
    ".cc/workflow/0172c9f8-d627-49f2-bbb5-02031fada740/visual-verification/integrated";
  const widths = [1180, 1080, 960, 760];
  const now = new Date("2026-05-28T20:42:00.000Z");
  const minutesAgo = (minutes) =>
    new Date(now.getTime() - minutes * 60_000).toISOString();
  const currentConversationId = "73ea91d1-b84f-4361-b2ab-3992bcfd65d5";
  const baseConversation = {
    projectName: "command-center",
    projectPath: "/Users/alex/github/command-center",
    sessionName: "Peek & Replay",
    agentBackend: "claude",
    summary: null,
    pendingQuestion: null,
    pendingQuestionId: null,
    pendingQuestions: null,
    forkedFrom: null,
    debugActive: false,
    role: "iteration",
    branchName: "csm/peek-replay-02e449",
    worktreePath:
      "/Users/alex/github/command-center/.worktrees/peek-replay-02e449.schema-and-deps-foundation",
    lastActivitySummary: null,
  };
  const singleQuestion = [
    {
      question: "Should I keep the popover open after sending?",
      header: "Popover behavior",
      options: [
        {
          label: "Keep it open",
          description: "Continue watching the transcript tail after reply.",
        },
        {
          label: "Close it",
          description: "Return immediately to sidebar triage.",
        },
        {
          label: "Ask again later",
          description: "Defer until visual verification is complete.",
        },
      ],
    },
  ];
  const multiQuestion = [
    {
      question: "Which verification passes should I run next?",
      header: "Verification",
      options: [
        {
          label: "Typecheck",
          description: "Confirm the component and stories satisfy TypeScript.",
        },
        {
          label: "Storybook render",
          description: "Load every status story in the browser.",
        },
      ],
      multiSelect: true,
    },
  ];
  const states = [
    {
      slug: "new",
      id: "visual-new",
      name: "Visual new",
      status: "new",
      lastActivityAt: minutesAgo(1),
      lastActivitySummary: "Conversation created.",
    },
    {
      slug: "running",
      id: "visual-running",
      name: "Visual running",
      status: "running",
      lastActivityAt: minutesAgo(2),
      lastActivitySummary: "Streaming component work.",
    },
    {
      slug: "awaiting",
      id: "visual-awaiting",
      name: "Visual awaiting",
      status: "awaiting",
      lastActivityAt: minutesAgo(11),
      lastActivitySummary: "Waiting for the next instruction.",
    },
    {
      slug: "waiting_for_input-structured-single",
      id: "visual-wfi-single",
      name: "Visual structured single",
      status: "waiting_for_input",
      lastActivityAt: minutesAgo(4),
      pendingQuestion: "Should I keep the popover open after sending?",
      pendingQuestionId: "question-single",
      pendingQuestions: singleQuestion,
      lastActivitySummary: "Agent asked for a popover behavior decision.",
    },
    {
      slug: "waiting_for_input-structured-multi-other",
      id: "visual-wfi-multi",
      name: "Visual structured multi other",
      status: "waiting_for_input",
      lastActivityAt: minutesAgo(5),
      pendingQuestion: "Which verification passes should I run next?",
      pendingQuestionId: "question-multi",
      pendingQuestions: multiQuestion,
      lastActivitySummary: "Agent asked which verification passes to run.",
    },
    {
      slug: "waiting_for_input-fallback-banner",
      id: "visual-wfi-banner",
      name: "Visual fallback banner",
      status: "waiting_for_input",
      lastActivityAt: minutesAgo(9),
      pendingQuestion: "Should I run the migration before updating docs?",
      pendingQuestionId: null,
      pendingQuestions: null,
      lastActivitySummary: "Agent asked a legacy free-text question.",
    },
  ];
  const conversations = [
    {
      ...baseConversation,
      id: currentConversationId,
      name: "Peek & Replay 1",
      status: "awaiting",
      lastActivityAt: minutesAgo(60),
    },
    ...states.map((state) => ({ ...baseConversation, ...state })),
  ];
  const transcript = [
    {
      role: "user",
      content: [
        {
          type: "text",
          text: "Run through the schema and dependency foundation tasks.",
        },
      ],
      timestamp: minutesAgo(12),
      seq: 0,
    },
    {
      role: "assistant",
      content: [
        {
          type: "text",
          text: "Reading active-conversation schemas and story patterns.",
        },
      ],
      timestamp: minutesAgo(10),
      seq: 1,
    },
    {
      role: "assistant",
      content: [
        {
          type: "text",
          text: "Adding the component test, then the FloatingUI panel.",
        },
      ],
      timestamp: minutesAgo(6),
      seq: 2,
    },
  ];

  await page.route("**/api/conversations/active", async (route) => {
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({
        conversations,
        graphWorkflowExecutions: [],
        activeCollaborationExecutions: [],
      }),
    });
  });

  await page.route(
    "**/api/projects/**/conversations/*/messages",
    async (route) => {
      const requestUrl = route.request().url();
      const conversationId = decodeURIComponent(
        requestUrl.split("/conversations/")[1].split("/messages")[0],
      );
      if (conversationId.startsWith("visual-")) {
        await route.fulfill({
          status: 200,
          contentType: "application/json",
          body: JSON.stringify(transcript),
        });
        return;
      }
      await route.fallback();
    },
  );

  const waitForSidebar = async () => {
    await page.waitForSelector(".conversation-sidebar-row", {
      state: "visible",
      timeout: 30000,
    });
    await page.evaluate(
      () =>
        document.fonts?.ready ??
        new Promise((resolve) => window.setTimeout(resolve, 250)),
    );
  };

  for (const width of widths) {
    await page.setViewportSize({ width, height: 800 });
    for (const state of states) {
      await page.goto(appUrl, { waitUntil: "domcontentloaded" });
      await waitForSidebar();
      if (width <= 760) {
        await page.locator(".convo-sidebar-mobile-toggle").click();
        await page.waitForTimeout(200);
      }
      const row = page
        .locator(".conversation-sidebar-row")
        .filter({ hasText: state.name })
        .first();
      await row.click();
      await page.waitForSelector(".peek", { state: "visible", timeout: 15000 });
      if (state.slug === "waiting_for_input-structured-multi-other") {
        const other = page
          .locator(".ask-question-option")
          .filter({ hasText: "Other" })
          .locator("input")
          .first();
        await other.evaluate((input) => input.click());
        await page.getByPlaceholder("Type your answer...").focus();
      }
      await page.waitForTimeout(250);
      await page.screenshot({
        path: `${outputDir}/${state.slug}-${width}.png`,
        fullPage: true,
      });
    }
  }
};
