import { z } from "zod";

// Implementer agent schema: defines the contract for bounded coding tasks
// executed in isolated sandboxes with deterministic verification.

export const ImplementationTask = z.object({
  id: z.string().min(1).max(200),
  prompt: z.string().min(1).max(20_000),
  modelContext: z
    .object({
      model: z.string().min(1),
    })
    .optional(),
  permissions: z
    .object({
      shell: z.boolean(),
      read: z.boolean(),
      write: z.boolean(),
    })
    .optional(),
  affectedFiles: z.array(z.string().min(1).max(500)).max(100).optional(),
});
export type ImplementationTask = z.infer<typeof ImplementationTask>;

export const CheckResult = z.object({
  name: z.string().min(1).max(200),
  exitCode: z.number().int(),
  output: z.string().max(20_000).optional(),
});
export type CheckResult = z.infer<typeof CheckResult>;

export const ImplementationOutput = z.object({
  success: z.boolean(),
  filesChanged: z.array(z.string().min(1)),
  checksRun: z.array(CheckResult),
  summary: z.string().max(5_000).optional(),
  interrupted: z.boolean().optional(),
  resumed: z.boolean().optional(),
});
export type ImplementationOutput = z.infer<typeof ImplementationOutput>;
