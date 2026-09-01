import { defineTool } from "eve/tools";
import {
  classifyIssue,
  createLazyLiveDeps,
  DEFAULT_CLASSIFIER_TOOL_DESCRIPTION,
} from "../../factory/classifier/classifier.ts";
import { ClassificationInput } from "../../factory/classifier/schema.ts";

// classify_issue Eve tool (#37): accepts issue data, returns the #39 strict
// triple wrapped in an audit record. Model credentials stay in the host
// runtime; the adapter is built lazily on first use so `eve dev` still boots
// without one configured.
//
// Default model openai/gpt-4.1-nano via Vercel AI Gateway: expect occasional
// 429/503 saturation spikes on the free tier; the classifier's attempt/backoff
// loop absorbs them. Set CLASSIFIER_MODEL to escape-hatch onto a different
// model without code changes.

const liveDeps = createLazyLiveDeps();

export default defineTool({
  description: DEFAULT_CLASSIFIER_TOOL_DESCRIPTION,
  inputSchema: ClassificationInput,
  execute(input) {
    return classifyIssue(liveDeps, input);
  },
});
