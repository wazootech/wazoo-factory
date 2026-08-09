/**
 * The progressive benchmark ladder. Task complexity increases only when the
 * current task stops exercising a comparison dimension. The spike stops once
 * both adapters produce comparable evidence across all mandatory gates and
 * scored dimensions.
 */

import type { TaskSpec } from "./executor.ts";

const SHARED_MODEL_CONTEXT = {
  model: "openai/gpt-5.5",
  temperature: 0,
  maxTokens: 8192,
} as const;

const READ_WRITE = { shell: true, read: true, write: true } as const;

/**
 * Ladder stages. Each stage's prompt is the exact text handed to both
 * executors. Stages build on one another; running a stage implies the
 * fixture starts from a clean baseline snapshot.
 */
export const LADDER: TaskSpec[] = [
  {
    id: "01-hello-world",
    prompt:
      "In this repository, create a file `main.ts` whose entire contents are exactly:\n" +
      '```ts\nconsole.log("Hello world!");\n```\n' +
      "Do not create anything else.",
    modelContext: SHARED_MODEL_CONTEXT,
    permissions: READ_WRITE,
  },
  {
    id: "02-add-check-command",
    prompt:
      "Add a `deno.json` with a task named `check` that runs `deno check main.ts` and a " +
      "`deno task check`-compatible script. Verify the check command runs successfully.",
    modelContext: SHARED_MODEL_CONTEXT,
    permissions: READ_WRITE,
  },
  {
    id: "03-small-behavior-change",
    prompt:
      "Change `main.ts` so it prints the program's first argument if one is provided, " +
      'otherwise prints "Hello world!". Keep the `check` task passing.',
    modelContext: SHARED_MODEL_CONTEXT,
    permissions: READ_WRITE,
  },
  {
    id: "04-structured-evidence",
    prompt:
      "Complete the previous behavior and then report a structured JSON summary with " +
      "`filesChanged` (list), `checksRun` (list of {name, exitCode}), and `success` (boolean).",
    modelContext: SHARED_MODEL_CONTEXT,
    permissions: READ_WRITE,
  },
];
