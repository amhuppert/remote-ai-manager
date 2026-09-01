/**
 * Notepad capture surfaces: the transcript clip affordances, the combined
 * comment/clip pill on the annotated-markdown hosts, and the voice
 * quick-capture host. They land in this directory, which is registered in the
 * three mirrored utility-first allowlists (the tailwind-utility-collisions
 * path list, eslint.config.mjs, and .prettierrc) so every surface is authored
 * utility-first without touching a guard file again.
 *
 * Until the first surface lands, this module holds the one thing they all
 * share: what a clip affordance calls itself, so the floating trigger, the
 * message action bar, and the annotated-host pill cannot drift apart.
 */

/** The verb every clip affordance shows, wherever it is offered. */
export const CLIP_AFFORDANCE_LABEL = "Clip";
