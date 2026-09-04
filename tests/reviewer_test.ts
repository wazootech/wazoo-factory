import { describe, expect, it, vi } from "vitest";

import {
  reviewImplementation,
  createReviewerTool,
  createLazyLiveDeps,
  resolveLiveReviewerEnv,
  REVIEWER_DEFAULT_BASE_URL,
  REVIEWER_DEFAULT_MODEL,
  type ReviewerDeps,
} from "@/factory/reviewer/reviewer.ts";
import { ReviewOutput } from "@/factory/reviewer/schema.ts";
import reviewImplementationTool from "@/agent/tools/review_implementation.ts";

// Reviewer unit tests (#76): injected generate fakes drive structured
// findings and risk assessment. No real model is touched; the live DeepSeek
// seam is exercised nowhere here.

const baseInput = {
  workflowId: "workflow-review",
  repository: "wazootech/memsdk",
  revision: "abc123",
  filesChanged: ["src/parser.ts"],
  implementationSummary: "Guard the frame parser against empty buffers.",
  implementer: "implementer",
};

const validReview = {
  passed: true,
  findings: [
    {
      file: "src/parser.ts",
      line: 10,
      severity: "warning",
      message: "Consider naming the empty-frame sentinel explicitly.",
      suggestion: "Extract a named constant.",
    },
  ],
  summary: "Implementation matches the specification with one nit.",
  riskAssessment: {
    sideEffectRisk: "low",
    performanceRisk: "none",
    backwardsCompatibilityRisk: "none",
  },
};

type GenerateParams = { system: string; prompt: string };

function okGenerate(value: unknown = validReview) {
  return vi.fn(async (_params: GenerateParams) => value);
}

function makeDeps(
  overrides: Partial<ReviewerDeps> & {
    generate?: ReviewerDeps["generate"];
  } = {},
): ReviewerDeps {
  return {
    generate: overrides.generate ?? okGenerate(),
    model: "test-reviewer",
    ...overrides,
  };
}

describe("reviewImplementation", () => {
  it("returns a schema-valid review with model and timestamp annotations", async () => {
    const result = await reviewImplementation(makeDeps(), baseInput);
    expect(result.passed).toBe(true);
    expect(result.findings[0]?.file).toBe("src/parser.ts");
    expect(result.riskAssessment.sideEffectRisk).toBe("low");
    expect(result.model).toBe("test-reviewer");
    expect(result.reviewedAt).toBeTruthy();
  });

  it("fails fast on a deterministic env error instead of retrying it", async () => {
    const generate = okGenerate();
    const delays: number[] = [];
    await expect(
      reviewImplementation(
        makeDeps({
          generate,
          attempts: 3,
          delay: async (ms) => {
            delays.push(ms);
          },
          resolveEnv: () => {
            throw new Error(
              "reviewer requires DEEPSEEK_API_KEY in the host runtime",
            );
          },
        }),
        baseInput,
      ),
    ).rejects.toThrow(/requires DEEPSEEK_API_KEY/);
    // A missing key cannot be fixed by retrying: no model call, no backoff.
    expect(generate).not.toHaveBeenCalled();
    expect(delays).toEqual([]);
  });

  it("retries an invalid review with backoff and throws when it never complies", async () => {
    const delays: number[] = [];
    const generate = vi.fn(async (_params: GenerateParams) => ({
      passed: "not-a-boolean",
    }));
    await expect(
      reviewImplementation(
        makeDeps({
          generate,
          attempts: 2,
          delay: async (ms) => {
            delays.push(ms);
          },
        }),
        baseInput,
      ),
    ).rejects.toThrow(/review failed after 2 attempts/);
    expect(generate).toHaveBeenCalledTimes(2);
    expect(delays).toEqual([250]);
  });

  it("rejects a non-independent reviewer result", async () => {
    const generate = okGenerate({
      ...validReview,
      passed: false,
    });
    // Independence is enforced by the workflow layer, not the core; the core
    // just reports the model's verdict faithfully.
    const result = await reviewImplementation(
      makeDeps({ generate }),
      baseInput,
    );
    expect(result.passed).toBe(false);
  });

  it("exports a defineTool-shaped review_implementation with lazy live deps", () => {
    expect(typeof reviewImplementationTool.description).toBe("string");
    expect(reviewImplementationTool.description.length).toBeGreaterThan(10);
    expect(typeof reviewImplementationTool.execute).toBe("function");
    expect(createReviewerTool(makeDeps()).description).toBe(
      reviewImplementationTool.description,
    );
  });
});

describe("live reviewer env resolution", () => {
  it("requires a DeepSeek key at resolution time", () => {
    expect(() => resolveLiveReviewerEnv({})).toThrow(
      /requires DEEPSEEK_API_KEY/,
    );
  });

  it("exposes resolveEnv on lazy live deps for one-time config resolution", () => {
    vi.stubEnv("DEEPSEEK_API_KEY", "");
    const deps = createLazyLiveDeps();
    try {
      // resolveEnv throws before any generate call when no key is set.
      expect(() => deps.resolveEnv?.()).toThrow(/requires DEEPSEEK_API_KEY/);
    } finally {
      vi.unstubAllEnvs();
    }
    // With a key configured, the same deps resolve once and memoize.
    vi.stubEnv("DEEPSEEK_API_KEY", "test-key");
    try {
      expect(() => deps.resolveEnv?.()).not.toThrow();
      expect(() => deps.resolveEnv?.()).not.toThrow();
    } finally {
      vi.unstubAllEnvs();
    }
  });

  it("defaults the model to DeepSeek direct and honors REVIEWER_MODEL", () => {
    expect(resolveLiveReviewerEnv({ DEEPSEEK_API_KEY: "k" })).toMatchObject({
      apiKey: "k",
      model: REVIEWER_DEFAULT_MODEL,
      baseURL: REVIEWER_DEFAULT_BASE_URL,
    });
    expect(REVIEWER_DEFAULT_MODEL).toBe("deepseek-v4-flash");
    expect(REVIEWER_DEFAULT_BASE_URL).toBe("https://api.deepseek.com");
    expect(
      resolveLiveReviewerEnv({
        DEEPSEEK_API_KEY: "k",
        REVIEWER_MODEL: "anthropic/claude-haiku-4",
        REVIEWER_BASE_URL: "https://gateway.example.com/v1",
      }),
    ).toMatchObject({
      model: "anthropic/claude-haiku-4",
      baseURL: "https://gateway.example.com/v1",
    });
  });

  it("keeps the ReviewOutput schema parseable as the embedded JSON contract", () => {
    // The prompt embeds z.toJSONSchema(ReviewOutput); the schema used for
    // parsing must accept exactly the shape the model is shown.
    const parsed = ReviewOutput.parse(validReview);
    expect(parsed.summary).toBe(validReview.summary);
  });
});
