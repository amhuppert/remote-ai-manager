/**
 * Typed graph values consumed by native SDD after a launch has crossed the
 * graph-owned admission boundary. Keeping these exports behind one module
 * prevents spec code from depending on individual authored graph fields.
 */
export {
  graphWorkflowStatusSchema,
  graphWorkflowTaskStatusSchema,
  type GraphWorkflowStatus,
} from "./definition-schemas";
export {
  graphWorkflowTaskStatusEventSchema,
  type GraphWorkflowExecutionEvent,
} from "./event-schemas";
export {
  graphWorkflowExecutionOriginSchema,
  type GraphWorkflowAbandonment,
  type GraphWorkflowExecutionOrigin,
} from "./schemas";
export { isTerminalStatus } from "./lifecycle-classifier";
export type { AuthoredAccountabilityCoverageGroup } from "./authored-accountability-coverage-core";
export type { GraphWorkflowExecution } from "./schemas";
export type { SeededWorkflowDocument } from "./shared-documents";
// The resolved semantic definition and the two pure derivations native SDD
// runs over it (criterion records, stable accountability owners). Exported
// here so spec code consumes them as graph-owned values rather than reaching
// into the modules that compute them.
export type { WorkflowSemanticDefinition } from "./definition-schemas";
export { criterionRecordsOf } from "./criteria/criterion-records";
export { collectStableAccountabilityContextIds } from "./authored-accountability";
// The ONE start-input refusal class — owned by the pure start-input-service
// module (client-safe), which the manager itself now throws, so a spec-side
// `instanceof` matches the gauntlet's refusal without dragging the server-side
// manager into client bundles.
export { WorkflowStartInputError } from "./start-input-service";
