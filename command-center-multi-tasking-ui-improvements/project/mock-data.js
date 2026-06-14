// Mock data for the Command Center prototype.
// Twelve active conversations across four projects.

window.MOCK = (function () {
  const NOW = Date.now();
  const ago = (mins) => NOW - mins * 60 * 1000;

  const projects = {
    "creative-ai": { repo: "~/code/creative-ai" },
    "remote-ai-manager": { repo: "~/code/remote-ai-manager" },
    "kafka-ingest": { repo: "~/work/kafka-ingest" },
    "ground-control-ui": { repo: "~/code/ground-control-ui" },
  };

  // session: a worktree on a branch. May have multiple conversations.
  // status (mirrors prod): "new" | "awaiting" | "running" | "waiting_for_input"
  //   new                — session created, hasn't kicked off yet
  //   awaiting            — Claude finished or is paused, ready for the next prompt
  //   running             — Claude is actively working
  //   waiting_for_input   — Claude asked the user a question and is blocked on the answer
  // statusLine is the "what it's doing right now" one-liner
  const conversations = [
    {
      id: "gc-multitasking",
      project: "ground-control-ui",
      session: "multitasking-ui",
      branch: "csm/multitasking-ui",
      title: "Multi-tasking UI improvements",
      status: "running",
      statusLine: "Drafting peek popover layout · written ~140 lines",
      currentTool: "Edit",
      lastUpdated: ago(0),
      timeLabel: "now",
      diff: { add: 312, del: 48, files: 9 },
      siblings: { total: 1, merged: 1 },
      activity: [
        3, 4, 6, 5, 7, 8, 6, 4, 5, 7, 9, 6, 5, 4, 6, 7, 5, 6, 8, 7, 6, 5, 7, 6,
        8, 7, 9, 8, 7, 8,
      ],
      isCurrent: true,
    },
    {
      id: "gc-notifications",
      project: "ground-control-ui",
      session: "notif-polish",
      branch: "csm/notif-polish",
      title: "Notifications panel polish",
      status: "running",
      statusLine: "Running `pnpm test notifications/*` · 4 of 17",
      currentTool: "Bash",
      lastUpdated: ago(22),
      timeLabel: "22m",
      diff: { add: 184, del: 92, files: 6 },
      siblings: { total: 2, merged: 2 },
      activity: [
        0, 0, 0, 1, 2, 3, 4, 6, 5, 7, 6, 5, 7, 6, 4, 5, 6, 7, 4, 3, 2, 4, 5, 6,
        7, 5, 4, 3, 5, 4,
      ],
    },

    // creative-ai / streaming-chat session has TWO conversations.
    {
      id: "ca-streaming",
      project: "creative-ai",
      session: "streaming-chat",
      branch: "csm/streaming-chat",
      title: "Add streaming to chat",
      status: "running",
      statusLine: "Writing tests for /api/queue-route",
      currentTool: "Write",
      lastUpdated: ago(4),
      timeLabel: "4m",
      diff: { add: 142, del: 18, files: 7 },
      siblings: { total: 3, merged: 2 },
      activity: [
        2, 3, 5, 4, 6, 8, 7, 9, 8, 6, 7, 9, 8, 7, 6, 5, 7, 8, 9, 8, 7, 6, 7, 8,
        9, 8, 7, 6, 8, 7,
      ],
    },
    {
      id: "ca-streaming-perf",
      project: "creative-ai",
      session: "streaming-chat",
      branch: "csm/streaming-chat",
      title: "Benchmark SSE keepalive intervals",
      status: "running",
      statusLine: "Running k6 load test · 1,200 req/sec sustained",
      currentTool: "Bash",
      lastUpdated: ago(2),
      timeLabel: "2m",
      diff: { add: 38, del: 4, files: 2 },
      siblings: { total: 1, merged: 0 },
      activity: [
        0, 0, 1, 3, 5, 6, 7, 8, 7, 6, 7, 8, 9, 8, 7, 8, 9, 8, 7, 6, 7, 8, 9, 7,
        8, 9, 8, 7, 8, 9,
      ],
    },
    {
      id: "ca-posthog",
      project: "creative-ai",
      session: "posthog-migrate",
      branch: "csm/posthog-migrate",
      title: "Migrate analytics to Posthog",
      status: "waiting_for_input",
      statusLine:
        'Asks: "Should I delete the legacy mixpanel events, or leave them as a fallback for 30 days?"',
      awaitingQuestion:
        "Should I delete the legacy mixpanel events, or leave them as a fallback for 30 days?",
      // Structured Ask-User-Question payload (matches prod AskQuestionItem[] + questionId).
      pendingQuestionId: "q-posthog-legacy",
      pendingQuestion: [
        {
          header: "Legacy mixpanel events",
          question:
            "Should I delete the legacy mixpanel events, or leave them firing as a fallback?",
          multiSelect: false,
          options: [
            {
              label: "Delete them now",
              description: "Remove all 12 untouched legacy events in this pass",
            },
            {
              label: "Keep as fallback (30 days)",
              description:
                "Leave them firing in parallel, remove after rollout settles",
            },
            {
              label: "Keep indefinitely",
              description:
                "Don't touch them — some dashboards may still depend on them",
            },
          ],
        },
      ],
      lastUpdated: ago(12),
      timeLabel: "12m",
      diff: { add: 87, del: 61, files: 11 },
      siblings: { total: 2, merged: 2 },
      activity: [
        4, 6, 7, 5, 6, 8, 7, 5, 4, 6, 7, 8, 6, 5, 4, 3, 2, 1, 0, 0, 0, 0, 0, 0,
        0, 0, 0, 0, 0, 0,
      ],
    },
    {
      id: "ca-login",
      project: "creative-ai",
      session: "login-redirect",
      branch: "csm/login-redirect",
      title: "Fix login redirect bug",
      status: "running",
      statusLine: "Ran 4 bash commands · inspecting `next-auth` callback",
      currentTool: "Bash",
      lastUpdated: ago(1),
      timeLabel: "1m",
      diff: { add: 12, del: 8, files: 2 },
      siblings: { total: 1, merged: 0 },
      activity: [
        0, 1, 2, 3, 4, 5, 4, 3, 4, 5, 6, 5, 4, 5, 6, 7, 6, 5, 4, 5, 6, 7, 8, 7,
        6, 7, 8, 7, 6, 8,
      ],
    },

    // remote-ai-manager / autoscale-pool session has TWO conversations.
    {
      id: "ram-autoscale",
      project: "remote-ai-manager",
      session: "autoscale-pool",
      branch: "csm/autoscale-pool",
      title: "Worker pool auto-scaling",
      status: "running",
      statusLine: "Implementing back-pressure logic in `Scheduler.tick()`",
      currentTool: "Edit",
      lastUpdated: ago(8),
      timeLabel: "8m",
      diff: { add: 220, del: 14, files: 5 },
      siblings: { total: 4, merged: 2 },
      activity: [
        3, 4, 5, 6, 7, 8, 7, 6, 5, 7, 8, 9, 8, 7, 6, 7, 8, 9, 8, 7, 8, 9, 8, 7,
        6, 7, 8, 9, 8, 7,
      ],
    },
    {
      id: "ram-scale-metrics",
      project: "remote-ai-manager",
      session: "autoscale-pool",
      branch: "csm/autoscale-pool",
      title: "Add metrics for scale-up / scale-down events",
      status: "awaiting",
      statusLine: "Paused mid-implementation · ready for next prompt",
      lastUpdated: ago(40),
      timeLabel: "40m",
      diff: { add: 22, del: 0, files: 1 },
      siblings: { total: 1, merged: 0 },
      activity: [
        3, 4, 5, 6, 5, 4, 5, 4, 3, 2, 1, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0,
        0, 0, 0, 0, 0, 0,
      ],
    },
    {
      id: "ram-tests",
      project: "remote-ai-manager",
      session: "scheduler-tests",
      branch: "csm/scheduler-tests",
      title: "Refactor scheduler tests",
      status: "awaiting",
      statusLine: "Finished · 12 commits ahead · ready for next prompt",
      lastUpdated: ago(0.4),
      timeLabel: "just now",
      diff: { add: 412, del: 188, files: 22 },
      siblings: { total: 1, merged: 1 },
      activity: [
        5, 6, 7, 8, 7, 6, 7, 8, 9, 8, 7, 8, 9, 7, 8, 9, 8, 7, 6, 5, 4, 3, 2, 1,
        1, 0, 0, 0, 0, 0,
      ],
    },
    {
      id: "ram-sentry",
      project: "remote-ai-manager",
      session: "sentry-crumbs",
      branch: "csm/sentry-crumbs",
      title: "Add Sentry breadcrumbs",
      status: "running",
      statusLine: "Ran `pnpm typecheck` · 0 errors",
      currentTool: "Bash",
      lastUpdated: ago(0.5),
      timeLabel: "32s",
      diff: { add: 58, del: 4, files: 3 },
      siblings: { total: 1, merged: 0 },
      activity: [
        1, 2, 3, 4, 5, 5, 6, 7, 6, 5, 6, 7, 8, 7, 6, 7, 8, 7, 6, 5, 6, 7, 8, 7,
        8, 9, 8, 7, 8, 9,
      ],
    },
    {
      id: "ki-backfill",
      project: "kafka-ingest",
      session: "backfill-jul",
      branch: "csm/backfill-jul",
      title: "Backfill July events",
      status: "running",
      statusLine: "Processed 47,210 / ~120k events · ETA 18m",
      currentTool: "Bash",
      lastUpdated: ago(15),
      timeLabel: "15m",
      diff: { add: 34, del: 6, files: 2 },
      siblings: { total: 1, merged: 0 },
      activity: [
        5, 5, 6, 5, 6, 5, 6, 5, 6, 5, 6, 5, 6, 5, 6, 5, 6, 5, 6, 5, 6, 5, 6, 5,
        6, 5, 6, 5, 6, 5,
      ],
    },
    {
      id: "ki-schema",
      project: "kafka-ingest",
      session: "orders-schema",
      branch: "csm/orders-schema",
      title: "Schema migration for orders",
      status: "waiting_for_input",
      statusLine:
        'Asks: "Bump my fields to 42\u201345 and retry, or rebase on main first?"',
      awaitingQuestion:
        "Hit a merge conflict in `orders/v3.avsc` line 41 \u2014 someone added `tax_rate` on main that overlaps my ordinals. Bump mine to 42\u201345 and retry, or rebase first?",
      pendingQuestionId: "q-orders-conflict",
      pendingQuestion: [
        {
          header: "Merge conflict \u00b7 orders/v3.avsc:41",
          question:
            "`tax_rate` was added on main and overlaps my ordinals. How should I resolve it?",
          multiSelect: false,
          options: [
            {
              label: "Bump mine to 42\u201345 and retry",
              description: "Keep my schema, shift ordinals past the new field",
            },
            {
              label: "Rebase on main first",
              description:
                "Pull in `tax_rate`, then replay my migration on top",
            },
            {
              label: "Show me the conflict",
              description: "Open the diff before I decide",
            },
          ],
        },
      ],
      lastUpdated: ago(3),
      timeLabel: "3m",
      diff: { add: 92, del: 47, files: 4 },
      siblings: { total: 2, merged: 1 },
      activity: [
        4, 5, 6, 7, 8, 7, 6, 5, 4, 5, 6, 5, 4, 3, 2, 1, 0, 0, 0, 0, 0, 0, 0, 0,
        0, 0, 0, 0, 0, 0,
      ],
    },
    {
      id: "ki-ratelimit",
      project: "kafka-ingest",
      session: "consumer-ratelimit",
      branch: "csm/consumer-ratelimit",
      title: "Rate limit on consumer",
      status: "awaiting",
      statusLine: "Awaiting your call \u2014 token bucket vs sliding window",
      lastUpdated: ago(312),
      timeLabel: "5h",
      diff: { add: 0, del: 0, files: 0 },
      siblings: { total: 0, merged: 0 },
      activity: new Array(30).fill(0),
    },
    {
      id: "gc-row-density",
      project: "ground-control-ui",
      session: "row-density",
      branch: "csm/row-density",
      title: "Tighter row density experiments",
      status: "new",
      statusLine: "Session created · worktree spinning up",
      lastUpdated: ago(0.1),
      timeLabel: "just now",
      diff: { add: 0, del: 0, files: 0 },
      siblings: { total: 1, merged: 0 },
      activity: new Array(30).fill(0),
    },
  ];

  // For the current conversation, render real messages.
  const currentTranscript = [
    {
      role: "user",
      text: "Attached is a screenshot of the current conversation page in command center. I want to overhaul some of the UI to make it easier to manage multiple agents working on different things — possibly across different projects — at the same time.\n\nThe core goal is to keep the cost of human context switching low: make it very quick for the user to respond to an agent, or become aware of events happening in another conversation, while barely having to leave what they're currently working on.",
    },
    {
      role: "assistant",
      text: "Quick read first — current panel is a list-of-titles, so all the rich signal an agent generates (what it's doing right now, what it's about to ask, what's queued behind it) gets compressed into one colored dot.\n\nThe throughline I'm working with: the user is the bottleneck, not the agents. Whatever we build should be optimized for minimizing how many seconds it takes the human to triage what just happened across the fleet, not for showing more of the fleet.",
      tool: null,
    },
    {
      role: "user",
      text: "How do you envision the bridge mode being different from split conversations, beyond split conversations being like a version of bridge mode restricted to two conversations?",
    },
    {
      role: "assistant",
      text: "Being honest: they largely collapse. The size axis (N=2 vs N=6) on its own doesn't justify two separate features.\n\nMy recommendation: one Panes mode with adaptive density. At N=2 each tile is a full cockpit; at N=6 tiles degrade to monitor/quick-reply variants. One concept, one keyboard shortcut, but the experience tracks density.",
    },
    {
      role: "user",
      text: "Yes, one panes mode. Yes to tabs. Treat as a single agent. Yes to one prototype with tweaks. Yes to ~12 conversations.\n\nprototype the peek, tabs, and enriched sidebar",
    },
    {
      role: "assistant",
      text: "On it. Building three things into a single prototype:\n\n1. Enriched sidebar — every row carries what-it's-doing-now, diff stat, sparkline, and a Needs-You section at the top.\n2. Tabs above the conversation — currently-juggling conversations live in a browser-tab strip with Cmd+1/2/3 to swap.\n3. Peek-and-reply popover — click any sidebar row to open a 460-wide popover with the last few messages and a prompt input. Esc to dismiss.\n\nEverything is toggleable from the Tweaks panel so you can see them combined or in isolation.",
      tool: {
        name: "Read",
        detail: ".kiro/specs/dashboard-ui/requirements.md",
      },
    },
    {
      role: "assistant",
      text: "Wiring everything up now.",
      tool: {
        name: "Edit",
        detail: "src/sidebar.jsx · added EnrichedRow component",
      },
    },
  ];

  // For peek popover transcripts on each non-current conversation.
  // Just enough to look real: 3-5 short messages.
  const peekTranscripts = {
    "gc-notifications": [
      {
        role: "user",
        text: "Make the toast position-able. Top-right by default, but configurable.",
      },
      {
        role: "assistant",
        text: "Configurable via the global `Toaster` props, or per-toast?",
      },
      { role: "user", text: "Global default, per-toast override." },
      {
        role: "assistant",
        text: "Got it. Adding `position` to `ToasterConfig` and `toast.show({ position })`. Running tests now.",
        tool: { name: "Bash", detail: "pnpm test notifications/*" },
      },
    ],
    "ca-streaming": [
      {
        role: "user",
        text: "We need to stream tokens from /api/chat. The buffering on the queue route is killing UX.",
      },
      {
        role: "assistant",
        text: "Switching `queue-route` to a streaming response. I'll add tests for the chunked transfer path.",
      },
      {
        role: "assistant",
        text: "Wrote 4 test cases covering: clean stream, abort mid-response, server error mid-stream, and back-pressure.",
        tool: { name: "Write", detail: "src/api/queue-route.test.ts" },
      },
      {
        role: "assistant",
        text: "Running them now…",
        tool: { name: "Bash", detail: "pnpm test queue-route" },
      },
    ],
    "ca-streaming-perf": [
      {
        role: "user",
        text: "Spawn a side conversation in this worktree — benchmark SSE keepalive intervals (5s, 15s, 30s) so we can pick a default.",
      },
      {
        role: "assistant",
        text: "Spinning up a k6 script targeting the dev SSE endpoint with 1,200 concurrent streams. Will record p50/p95/p99 reconnect rate per interval.",
      },
      {
        role: "assistant",
        text: "Sustained 1,200 req/sec for 5 minutes per interval. Compiling the numbers.",
        tool: { name: "Bash", detail: "k6 run scripts/sse-keepalive-bench.js" },
      },
    ],
    "ca-posthog": [
      {
        role: "user",
        text: "Replace the mixpanel `track()` calls with the equivalent Posthog ones.",
      },
      {
        role: "assistant",
        text: "Going through `analytics/` — I'll preserve event names so dashboards don't break.",
        tool: { name: "Grep", detail: "mixpanel\\.track" },
      },
      {
        role: "assistant",
        text: "Done with the main pass — 47 call sites updated. Before I finish, one decision: there are 12 events in `legacy/` that haven't been touched in a year.",
      },
      {
        role: "assistant",
        text: "Should I delete the legacy mixpanel events, or leave them as a fallback for 30 days?",
      },
    ],
    "ca-login": [
      {
        role: "user",
        text: "Users on Safari are getting redirected to /login instead of /dashboard after a successful login.",
      },
      {
        role: "assistant",
        text: "Reproduced. The `next-auth` callback isn't setting the session cookie before redirecting on Safari due to SameSite=Lax behavior on top-level navigations.",
      },
      {
        role: "assistant",
        text: "Inspecting callback flow…",
        tool: {
          name: "Bash",
          detail: "curl -v https://creative-ai.app/api/auth/callback",
        },
      },
    ],
    "ca-ssr": [
      {
        role: "user",
        text: "Look at whether SSR would help marketing page LCP.",
      },
      {
        role: "assistant",
        text: "Read 18 files in `src/marketing/`. Verdict: yes, but only for the 4 pages with above-the-fold dynamic content. The others should stay static.",
      },
      {
        role: "assistant",
        text: "Want me to draft the migration plan, or do you want to discuss the tradeoffs first?",
      },
    ],
    "ram-autoscale": [
      {
        role: "user",
        text: "Add auto-scaling for the worker pool based on queue depth.",
      },
      {
        role: "assistant",
        text: "Implementing in `Scheduler.tick()`. Target: scale up when depth > 100 for 30s, scale down when < 20 for 5m.",
      },
      {
        role: "assistant",
        text: "Adding back-pressure so we don't thrash on bursty traffic.",
        tool: { name: "Edit", detail: "src/scheduler.ts" },
      },
    ],
    "ram-scale-metrics": [
      {
        role: "user",
        text: "Side convo on this same worktree — wire up Prometheus counters for scale-up / scale-down events.",
      },
      {
        role: "assistant",
        text: "Added `worker_pool_scale_up_total` and `worker_pool_scale_down_total` to the metrics registry. Hooked into `Scheduler.scale()`.",
        tool: { name: "Edit", detail: "src/metrics.ts" },
      },
      {
        role: "assistant",
        text: "Pausing here — want to verify the scale logic in the sibling convo lands cleanly before I add tests on top.",
      },
    ],
    "ram-tests": [
      {
        role: "user",
        text: "The scheduler tests are a mess. Refactor them into describe blocks per behavior, factor out the setup.",
      },
      {
        role: "assistant",
        text: "Done. 22 files reorganized into 6 describe blocks. All 184 tests still pass. Added a `SchedulerHarness` helper that replaces the 47 lines of duplicate setup.",
        tool: { name: "Bash", detail: "pnpm test scheduler" },
      },
      {
        role: "assistant",
        text: "Branch is 12 commits ahead of `main`. Ready for your review.",
      },
    ],
    "ram-sentry": [
      {
        role: "user",
        text: "Add Sentry breadcrumbs for all outbound HTTP requests in the worker.",
      },
      {
        role: "assistant",
        text: "Wrapping the `httpClient` with a breadcrumb interceptor. Will tag with `category: 'http'` and include method, url, status, duration.",
        tool: { name: "Edit", detail: "src/http-client.ts" },
      },
      {
        role: "assistant",
        text: "Done. Running typecheck.",
        tool: { name: "Bash", detail: "pnpm typecheck" },
      },
    ],
    "ki-backfill": [
      {
        role: "user",
        text: "Run the backfill for July. Should be ~120k events.",
      },
      {
        role: "assistant",
        text: "Started. Processing at ~2.6k events/sec.",
        tool: { name: "Bash", detail: "scripts/backfill.ts --month=2026-07" },
      },
      {
        role: "assistant",
        text: "47,210 events processed so far. ETA 18m. I'll ping when it's done.",
      },
    ],
    "ki-schema": [
      {
        role: "user",
        text: "Migrate `orders` Avro schema to v3 (add `discount_code`, deprecate `coupon`).",
      },
      {
        role: "assistant",
        text: "Wrote the v3 schema and the migration runner. Running it on the dev cluster first.",
        tool: { name: "Bash", detail: "kafka-migrate orders/v3.avsc" },
      },
      {
        role: "assistant",
        text: "Aborted — merge conflict in `orders/v3.avsc` line 41. Someone else added a `tax_rate` field on `main` that overlaps the ordinal range I picked.",
      },
      {
        role: "assistant",
        text: "Want me to bump my fields to 42–45 and retry, or rebase first?",
      },
    ],
    "ki-ratelimit": [
      {
        role: "user",
        text: "Add rate limiting on the consumer side. We're getting hammered.",
      },
      {
        role: "assistant",
        text: "Two reasonable approaches: token bucket (smoother), or sliding window (more accurate).",
      },
      {
        role: "assistant",
        text: "Token bucket is probably what you want here — sliding window adds memory pressure on the consumer.",
      },
      { role: "user", text: "Let me think on it." },
    ],
    "gc-row-density": [
      {
        role: "user",
        text: "Spin up a worktree to try denser sidebar rows — 28px row height, no sparkline, mono-only.",
      },
    ],
    "gc-multitasking": [], // current, handled separately
  };

  return { projects, conversations, currentTranscript, peekTranscripts };
})();
