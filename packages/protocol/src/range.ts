import { z } from "zod";

export const FileRange = z.object({
  startLine: z.number().int().nonnegative(),
  endLine: z.number().int().nonnegative(),
});
export type FileRange = z.infer<typeof FileRange>;

// Which side of a split diff a comment anchors to: "old" = deleted lines (left,
// old line numbers), "new" = added/context lines (right, new line numbers).
export const Side = z.enum(["old", "new"]);
export type Side = z.infer<typeof Side>;
