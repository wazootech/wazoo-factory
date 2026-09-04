import { defineTool } from "eve/tools";
import {
  reviewImplementation,
  createLazyLiveDeps,
  DEFAULT_REVIEWER_TOOL_DESCRIPTION,
} from "@/factory/reviewer/reviewer.ts";
import { ReviewInput } from "@/factory/reviewer/schema.ts";

// review_implementation Eve tool (#76): accepts an implemented change and
// returns an independent review with structured findings and risk assessment.
// Model credentials stay in the host runtime; the adapter is built lazily on
// first use so `eve dev` still boots without one configured (mirroring the
// classify_issue/analyze_issue wiring).
//
// Default model deepseek-v4-flash via DeepSeek's official API. Set
// REVIEWER_MODEL to escape-hatch onto a different model without code changes.

const liveDeps = createLazyLiveDeps();

export default defineTool({
  description: DEFAULT_REVIEWER_TOOL_DESCRIPTION,
  inputSchema: ReviewInput,
  execute(input) {
    return reviewImplementation(liveDeps, input);
  },
});
