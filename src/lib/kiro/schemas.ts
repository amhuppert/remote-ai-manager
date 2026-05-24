import { z } from "zod";

export const kiroDocTreeSchema = z.object({
  steering: z.array(z.string()),
  specs: z.record(z.string(), z.array(z.string())),
});
