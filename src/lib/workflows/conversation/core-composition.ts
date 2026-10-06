/**
 * The actor's production container, for the modules that compose the shared
 * conversation core's production engine while both engines run side by side
 * (design r2 §15). Kept apart from `core-coexistence`, so a core module that
 * imports only the actor's pure primitives does not load the actor. Removed
 * when the core composes its production engine from domain services.
 */
export { loadProductionActorDependencies as loadConversationTurnDependencies } from "./production";
