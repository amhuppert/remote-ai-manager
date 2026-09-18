import type { Command, Invocation } from "../commands.js";
import type { Brand } from "../internal/brand.js";
import type { Issue } from "../results.js";
import type { NonEmpty } from "../values.js";
/** Advisory action and registered target; rendering owns quoting and line bounds. */
export type Hint = Brand<"Hint"> & {
    readonly action: string;
    readonly invocation: Invocation;
};
/** Ownership survives until arbitration, so conflicting protocol cannot silently win. */
export type Instruction = Brand<"Instruction"> & {
    /**
     * Stable name of the protocol policy responsible for this instruction, not a request ID.
     * Arbitration uses it for provenance; equal owner IDs do not make conflicting texts safe.
     */
    readonly ownerId: string;
    readonly text: string;
};
export type RuleId = string & Brand<"RuleId">;
/** Minted only by rule evaluation. */
export type Reminder = Brand<"Reminder"> & {
    readonly ruleId: RuleId;
    readonly text: string;
};
export declare function hint(invocation: Invocation, action: string): Hint;
export declare function instruction(ownerId: string, text: string): Instruction;
type GuidanceChoice<H, I> = {
    readonly hint?: H;
    readonly instruction?: never;
} | {
    readonly instruction: I;
    readonly hint?: never;
};
export type ReminderList = readonly [] | readonly [Reminder] | readonly [Reminder, Reminder];
/** A handler cannot author reminders or combine optional advice with required protocol. */
export type HandlerGuidance = GuidanceChoice<Hint, Instruction> & {
    readonly reminders?: never;
};
/** Selected guidance before rendering; instruction suppresses hint, including after spill. */
export type FinalGuidance = GuidanceChoice<Hint, Instruction> & {
    readonly reminders: ReminderList;
};
/** The serialized envelope carries text, without internal ownership or invocation objects. */
export type WireGuidance = GuidanceChoice<string, string> & {
    readonly reminders: readonly [] | readonly [string] | readonly [string, string];
};
type RuleDefinition<State> = {
    /** Stable, greppable identifier; registration rejects duplicates and invalid spelling. */
    readonly id: string;
    readonly appliesTo: NonEmpty<Command>;
    /** Pure and deliberately synchronous; facts must describe the completed operation. */
    readonly when: (state: State) => boolean;
};
export type ReminderRuleDefinition<State> = RuleDefinition<State> & {
    /** Higher priority wins when more than two reminders fire. Ties use stable rule IDs. */
    readonly priority: number;
    /** A keep-true constraint, never an immediate action. Semantic correctness needs review. */
    readonly text: (state: State) => string;
    readonly evidence?: string;
};
export type ReminderRule<State> = Brand<"ReminderRule"> & Omit<ReminderRuleDefinition<State>, "id"> & {
    readonly id: RuleId;
    readonly tier: "reminder";
};
export type SteeringDefinition<State> = RuleDefinition<State> & ({
    readonly tier: "hint";
    readonly render: (state: State) => Hint;
} | {
    readonly tier: "instruction";
    readonly render: (state: State) => Instruction;
});
export type SteeringRule<State> = Brand<"SteeringRule"> & RuleDefinition<State> & ({
    readonly id: RuleId;
    readonly tier: "hint";
    readonly render: (state: State) => Hint;
} | {
    readonly id: RuleId;
    readonly tier: "instruction";
    readonly render: (state: State) => Instruction;
});
export type GuidanceRule<State> = ReminderRule<State> | SteeringRule<State>;
/** Defines a rule, not a reminder; handlers receive no constructor for emitted reminders. */
export declare function defineReminderRule<State>(definition: ReminderRuleDefinition<State>): ReminderRule<State>;
export declare function defineSteering<State>(definition: SteeringDefinition<State>): SteeringRule<State>;
export type ConflictingInstruction = {
    readonly instruction: Instruction;
    readonly provenance: {
        readonly kind: "handler";
        readonly ownerId: string;
    } | ({
        readonly kind: "rule";
    } & GuidanceProvenance);
};
export type GuidanceConflict = {
    readonly instructions: readonly [ConflictingInstruction, ConflictingInstruction, ...ConflictingInstruction[]];
};
export type GuidanceEvent = {
    readonly type: "guidance.rule_fired";
    readonly commandPath: string;
    readonly ruleId: RuleId;
    readonly tier: "hint" | "reminder" | "instruction";
} | {
    readonly type: "guidance.conflict";
    readonly commandPath: string;
    readonly conflict: GuidanceConflict;
};
/** The application owns durable storage; delivery failure must not hide a conflict. */
export type GuidanceEventSink = (event: GuidanceEvent) => void | Promise<void>;
/** Registering even one rule requires observable firings. */
export type RuleRegistration<State> = {
    readonly rules?: readonly [];
    readonly eventSink?: FiringSink;
} | {
    readonly rules: NonEmpty<GuidanceRule<State>>;
    readonly eventSink: FiringSink;
};
export type RuleFiring = Extract<GuidanceEvent, {
    readonly type: "guidance.rule_fired";
}>;
export type ConflictEvent = Extract<GuidanceEvent, {
    readonly type: "guidance.conflict";
}>;
export type FiringSink = (event: RuleFiring) => void | Promise<void>;
export type ConflictSink = (event: ConflictEvent) => void | Promise<void>;
export type GuidanceProvenance = {
    readonly commandPath: string;
    readonly ruleId: RuleId;
    readonly evidence?: string;
};
export type GuidanceCandidate = {
    readonly provenance: GuidanceProvenance;
} & ({
    readonly tier: "hint";
    readonly value: Hint;
} | {
    readonly tier: "instruction";
    readonly value: Instruction;
} | {
    readonly tier: "reminder";
    readonly value: Reminder;
    readonly priority: number;
});
/** Candidates retain rule provenance and firing events. They are never final selected guidance. */
export type EvaluatedGuidance = Brand<"EvaluatedGuidance"> & {
    readonly commandPath: string;
    readonly candidates: readonly GuidanceCandidate[];
    readonly firings: readonly RuleFiring[];
    /** Includes firing-sink failure without suppressing valid required candidates. */
    readonly issues: readonly Issue[];
};
export type GuidanceEvaluation<State> = RuleRegistration<State> & {
    readonly command: Command;
    readonly state: State;
    readonly handler?: never;
};
/** Evaluate rules in the CLI process; response assembly alone selects final tiers/conflicts. */
export declare function evaluateGuidance<State>(input: GuidanceEvaluation<State>): Promise<EvaluatedGuidance>;
export {};
//# sourceMappingURL=index.d.ts.map