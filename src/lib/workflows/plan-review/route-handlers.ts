import { randomUUID } from "node:crypto";

import { NextResponse } from "next/server";
import { z } from "zod";

import { resolveProjectPath as defaultResolveProjectPath } from "@/lib/projects/resolver";
import {
  jsonError,
  parseJsonBody,
  resolveProjectOr404,
} from "@/lib/shared/route-resolution";
import { defaultPlanReviewService } from "./default-service";
import {
  buildPlanReviewReader,
  defaultReviewerConversationResolver,
  type ReviewerConversationResolver,
} from "./reviewer-conversation";
import { graphPlanReviewVerdictSchema, planDefinitionHash } from "./schemas";
import type { PlanReviewService } from "./service";
import type { PlanReviewStatus } from "./status-schemas";

// ============================================================
// Plan review routes (#69 change 5)
//
// Project-scoped for ADDRESSING only — the record itself is keyed by the plan's
// canonical hash and nothing else, because the same plan text reviewed once is
// the same reviewed revision wherever it is later saved.
//
// Both handlers take the raw plan in the body and hash it HERE. A client that
// computed its own hash would be a second implementation of the canonical
// digest, and the first key-ordering difference between the two would silently
// split one revision into two identities.
// ============================================================

type RouteContext = {
  params: Promise<Record<string, string>>;
};

const recordRequestSchema = z
  .object({
    /** The complete plan document, exactly as `create`/`replace` take it. */
    plan: z.record(z.string(), z.unknown()),
    verdict: graphPlanReviewVerdictSchema,
    findings: z.string().nullable().optional(),
    reviewerConversationId: z.string().min(1),
  })
  .strict();

const statusRequestSchema = z
  .object({ plan: z.record(z.string(), z.unknown()) })
  .strict();

export interface PlanReviewRouteDeps {
  resolveProjectPath(name: string): Promise<string | null>;
  reviews(): PlanReviewService;
  reviewerConversation: ReviewerConversationResolver;
  newReviewId(): string;
  now(): string;
}

const defaultDeps: PlanReviewRouteDeps = {
  resolveProjectPath: defaultResolveProjectPath,
  reviews: defaultPlanReviewService,
  reviewerConversation: defaultReviewerConversationResolver,
  newReviewId: () => randomUUID(),
  now: () => new Date().toISOString(),
};

export function createPlanReviewRouteHandlers(
  deps: PlanReviewRouteDeps = defaultDeps,
) {
  /** POST — record one concluded review of the submitted plan. */
  async function RECORD(
    request: Request,
    context: RouteContext,
  ): Promise<Response> {
    const name = (await context.params)["name"] ?? "";
    const project = await resolveProjectOr404(deps, name);
    if (!project.ok) return project.response;

    const body = await parseJsonBody(
      request,
      recordRequestSchema,
      "Invalid request: plan, verdict, and reviewerConversationId are required",
    );
    if (!body.ok) return body.response;

    const hashed = planDefinitionHash(body.value.plan);
    if (!hashed.ok) {
      return NextResponse.json(
        { error: "Workflow plan is invalid", issues: hashed.issues },
        { status: 400 },
      );
    }

    const findings = body.value.findings ?? null;
    // Refused HERE rather than at the schema so the message names the flag an
    // author is missing, not a JSON path. This is the one thing these routes
    // refuse, and it refuses a malformed REVIEW — never a workflow operation.
    if (
      body.value.verdict === "changes_requested" &&
      (findings === null || findings.trim().length === 0)
    ) {
      return jsonError(
        "A changes_requested review must carry its findings artifact: send the findings text that justifies the verdict",
        400,
      );
    }

    const review = {
      id: deps.newReviewId(),
      definitionHash: hashed.hash,
      reviewerConversationId: body.value.reviewerConversationId,
      verdict: body.value.verdict,
      // Kept on an approved verdict too: a reviewer who approved WITH notes has
      // said something the next author needs, and dropping it here would make
      // the record thinner than the review it claims to preserve.
      findings,
      reviewedAt: deps.now(),
    };
    deps.reviews().recordPlanReview(review);

    return NextResponse.json(
      {
        id: review.id,
        definitionHash: review.definitionHash,
        verdict: review.verdict,
        reviewerConversationId: review.reviewerConversationId,
        reviewedAt: review.reviewedAt,
      },
      { status: 201 },
    );
  }

  /** POST — what is known about the submitted plan's exact revision. */
  async function STATUS(
    request: Request,
    context: RouteContext,
  ): Promise<Response> {
    const name = (await context.params)["name"] ?? "";
    const project = await resolveProjectOr404(deps, name);
    if (!project.ok) return project.response;

    const body = await parseJsonBody(
      request,
      statusRequestSchema,
      "Invalid request: plan is required",
    );
    if (!body.ok) return body.response;

    const hashed = planDefinitionHash(body.value.plan);
    if (!hashed.ok) {
      return NextResponse.json(
        { error: "Workflow plan is invalid", issues: hashed.issues },
        { status: 400 },
      );
    }

    const latest = deps.reviews().findLatestTerminalReview(hashed.hash);
    if (latest === null) {
      const status: PlanReviewStatus = {
        state: "unreviewed",
        definitionHash: hashed.hash,
      };
      return NextResponse.json({ status });
    }

    const status: PlanReviewStatus = {
      state: latest.verdict,
      definitionHash: latest.definitionHash,
      reviewerConversationId: latest.reviewerConversationId,
      reviewedAt: latest.reviewedAt,
      findings: latest.findings,
      reviewer: await buildPlanReviewReader(
        latest.reviewerConversationId,
        deps.reviewerConversation,
      ),
    };
    return NextResponse.json({ status });
  }

  return { RECORD, STATUS };
}
