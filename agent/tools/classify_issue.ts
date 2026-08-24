import { defineTool } from "eve/tools";
import {
  createLiveGenerate,
  DEFAULT_ATTEMPTS,
  DEFAULT_CLASSIFIER_TOOL_DESCRIPTION,
  classifyIssue,
  type ClassifyIssueDeps,
} from "../../factory/classifier.ts";
import { ClassificationInput } from "../../factory/classifier-schema.ts";

// classify_issue Eve tool (#37): accepts issue data, returns the #39 strict
// triple wrapped in an audit record. Model credentials stay in the host
// runtime (OPENCODE_GO_API_KEY); the adapter is built lazily on first use so
// `eve dev` still boots without one configured.

let liveGeneratePromise: Promise<ClassifyIssueDeps["generate"]> | undefined;

function getLiveDeps(): ClassifyIssueDeps {
  const apiKey = process.env.OPENCODE_GO_API_KEY;
  if (!apiKey) {
    throw new Error(
      "classify_issue requires OPENCODE_GO_API_KEY in the host runtime",
    );
  }
  const model = process.env.CLASSIFIER_MODEL ?? "deepseek-v4-flash";
  if (!liveGeneratePromise) {
    // OpenCode Go is the production inference path; temperature defaults to 0
    // per the #33 resolution's low-temperature directive.
    liveGeneratePromise = createLiveGenerate({
      baseURL: "https://opencode.ai/zen/go/v1",
      apiKey,
      model,
    });
  }
  const pendingGenerate = liveGeneratePromise;
  return {
    generate: (params) => pendingGenerate.then((g) => g(params)),
    model,
    attempts: DEFAULT_ATTEMPTS,
    delay: (ms) => new Promise((r) => setTimeout(r, ms)),
  };
}

export default defineTool({
  description: DEFAULT_CLASSIFIER_TOOL_DESCRIPTION,
  inputSchema: ClassificationInput,
  execute(input) {
    return classifyIssue(getLiveDeps(), input);
  },
});
