import { z } from "zod";

/** `open` admits effects; `closed` is paused and may reopen; `revoked` is final. */
export const permitStateSchema = z.enum(["open", "closed", "revoked"]);
export type PermitState = z.infer<typeof permitStateSchema>;

/** Authorization carried by a controlled request and checked at actual admission. */
export const permitRefSchema = z
  .object({
    controllerId: z.string().min(1),
    generation: z.number().int().min(1),
  })
  .strict();
export type PermitRef = z.infer<typeof permitRefSchema>;

export const controlPermitRecordSchema = z
  .object({
    controllerId: z.string().min(1),
    parentControllerId: z.string().min(1).nullable(),
    generation: z.number().int().min(1),
    state: permitStateSchema,
    updatedAt: z.string().min(1),
  })
  .strict();
export type ControlPermitRecord = z.infer<typeof controlPermitRecordSchema>;
