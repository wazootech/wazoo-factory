import { defineTool } from "eve/tools";
import {
  analyzeIssue,
  createLazyLiveDeps,
  DEFAULT_ANALYZER_TOOL_DESCRIPTION,
} from "@/factory/analyzer/analyzer.ts";
import { AnalysisInput } from "@/factory/analyzer/schema.ts";

// analyze_issue Eve tool (#67): accepts a classified issue and produces an
// AnalysisResult — probes, technical specification, risk assessment, and the
// affected files the change is expected to touch. Model credentials stay in
// the host runtime; the adapter is built lazily on first use so `eve dev`
// still boots without one configured (mirroring classify_issue wiring).
//
// Default model anthropic/claude-sonnet-5 via Vercel AI Gateway. Set
// ANALYZER_MODEL to escape-hatch onto a different model without code changes.

const liveDeps = createLazyLiveDeps();

export default defineTool({
  description: DEFAULT_ANALYZER_TOOL_DESCRIPTION,
  inputSchema: AnalysisInput,
  execute(input) {
    return analyzeIssue(liveDeps, input);
  },
});
