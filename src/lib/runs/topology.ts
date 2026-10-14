import type { RunDefinitionContext, RunLoop } from "./schemas";

/**
 * Static relations of a frozen definition that the scheduler, amendment and
 * view all read. The compiler checks the authored form with its own located
 * analysis; these read what it compiled.
 */

/** The contexts that work in a lane. */
export function laneMembers(
  contexts: readonly RunDefinitionContext[],
  lane: string,
): RunDefinitionContext[] {
  return contexts.filter((c) => c.lane === lane);
}

/**
 * Lanes whose code a lane's contexts need: the lanes its worktree must start
 * from. An output-only dependency needs the result, not the code.
 */
export function laneCodePrerequisites(
  contexts: readonly RunDefinitionContext[],
  lane: string,
): Set<string> {
  const laneOf = new Map(contexts.map((c) => [c.key, c.lane]));
  return new Set(
    laneMembers(contexts, lane).flatMap((c) =>
      c.dependsOn.flatMap((source) => {
        const from = laneOf.get(source);
        return from !== undefined &&
          from !== lane &&
          !(c.outputOnly ?? []).includes(source)
          ? [from]
          : [];
      }),
    ),
  );
}

/** A lane every context of which a route skipped contributes no code. */
export function laneSkipped(
  contexts: readonly RunDefinitionContext[],
  lane: string,
  isSkipped: (key: string) => boolean,
): boolean {
  return laneMembers(contexts, lane).every((c) => isSkipped(c.key));
}

/** The loop whose body a context belongs to. */
export function loopOf(
  loops: readonly RunLoop[] | undefined,
  key: string,
): RunLoop | undefined {
  return (loops ?? []).find((loop) => loop.body.includes(key));
}
