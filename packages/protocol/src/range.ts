import { z } from "zod";

export const FileRange = z.object({
  startLine: z.number().int().nonnegative(),
  endLine: z.number().int().nonnegative(),
});
export type FileRange = z.infer<typeof FileRange>;
