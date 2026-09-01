import { defineTool } from "eve/tools";
import {
  classifyIssue,
  createLazyLiveDeps,
  formatClassificationComment,
  classificationLabel,
} from "../../factory/classifier/classifier.ts";
import { ClassificationInput } from "../../factory/classifier/schema.ts";

// classify_and_post Eve tool: classifies an issue, posts a comment with the
// result, and applies the appropriate label. Errors in comment/label posting
// are logged but do not crash the workflow (#38).

const liveDeps = createLazyLiveDeps();

export default defineTool({
  description:
    "Classify a repository issue as bug, feature, or docs, then post a comment and apply the classification label.",
  inputSchema: ClassificationInput,
  async execute(input, ctx) {
    const result = await classifyIssue(liveDeps, input);

    // Post comment and apply label; failures are non-fatal per #38 scope.
    const sandbox = await ctx.getSandbox();
    const { category } = result.classification;
    const { label, color, description } = classificationLabel(category);

    try {
      const comment = formatClassificationComment(result);
      await sandbox.run({
        command: `gh issue comment ${input.issueNumber} --repo ${input.repository} --body "${comment.replace(/"/g, '\\"')}"`,
      });
    } catch (error) {
      console.error(
        `[classify_and_post] failed to post comment on ${input.repository}#${input.issueNumber}: ${error instanceof Error ? error.message : String(error)}`,
      );
    }

    try {
      // Ensure label exists, then apply it.
      await sandbox.run({
        command: `gh label create "${label}" --repo ${input.repository} --color "${color}" --description "${description}" 2>/dev/null || true`,
      });
      await sandbox.run({
        command: `gh issue edit ${input.issueNumber} --repo ${input.repository} --add-label "${label}"`,
      });
    } catch (error) {
      console.error(
        `[classify_and_post] failed to add label on ${input.repository}#${input.issueNumber}: ${error instanceof Error ? error.message : String(error)}`,
      );
    }

    return result;
  },
});
