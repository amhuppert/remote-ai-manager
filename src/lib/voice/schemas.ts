import { z } from "zod";

export const transcribeResponseSchema = z.object({
  text: z.string(),
});
export type TranscribeResponse = z.infer<typeof transcribeResponseSchema>;

export const voiceHealthResponseSchema = z.object({
  available: z.boolean(),
});
export type VoiceHealthResponse = z.infer<typeof voiceHealthResponseSchema>;
