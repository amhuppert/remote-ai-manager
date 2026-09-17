export interface MergeAssociationInput {
  projectPath: string;
  projectName: string;
  sessionName: string;
  /** Requested merge target; undefined means the session's default target. */
  targetBranch?: string;
}

export type MergeAssociationResolution =
  | { kind: "none" }
  | ({ kind: "linked"; finalPublish: boolean } & (
      | { executionId: string; specExecutionId?: never }
      | { specExecutionId: string; executionId?: never }
    ))
  | {
      kind: "refused";
      reason: string;
      instruction: string;
      specExecutionId?: string;
    };

export interface MergeAssociationResolver {
  resolve(input: MergeAssociationInput): MergeAssociationResolution;
}
