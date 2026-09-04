import { describe, expect, it, vi } from "vitest";

import {
  analyzeIssue,
  createAnalyzeIssueTool,
  createLazyLiveDeps,
  resolveLiveAnalyzerEnv,
  ANALYZER_DEFAULT_BASE_URL,
  ANALYZER_DEFAULT_MODEL,
  type AnalyzeIssueDeps,
} from "@/factory/analyzer/analyzer.ts";
import { AnalysisResult } from "@/factory/analyzer/schema.ts";
import analyzeIssueTool from "@/agent/tools/analyze_issue.ts";

// Analyzer unit tests (#67): injected generate fakes drive probe generation,
// spec output, and risk assessment. No real model is touched; the live gateway
// seam is exercised nowhere here.

const baseInput = {
  issueNumber: 7,
  title: "Parser crashes on empty input",
  body: "Running the parser against a zero-byte file throws.",
  labels: ["bug"],
  repository: "wazootech/memsdk",
  repositoryDescription: "Parser SDK",
  classification: { category: "bug", confidence: 0.92 },
};

const validAnalysis = {
  category: "bug",
  confidence: 0.9,
  probes: [
    {
      name: "empty input does not throw",
      description:
        "Run the parser on a zero-byte buffer and assert it resolves to an empty frame list.",
      passed: true,
      evidence: "parser.parse(Buffer.alloc(0)) returns []",
    },
  ],
  specification:
    "Guard the frame parser against empty buffers in src/parser.ts by returning an empty frame list before the first read.",
  riskLevel: "low",
  riskFactors: ["Touches the shared parse entry point"],
  affectedFiles: ["src/parser.ts", "src/parser_test.ts"],
  dependencies: [],
  estimatedComplexity: "simple",
  rationale:
    "The crash reproduces on empty input and the fix is a local guard.",
};

type GenerateParams = { system: string; prompt: string };

function okGenerate(value: unknown = validAnalysis) {
  return vi.fn(async (_params: GenerateParams) => value);
}

function makeDeps(
  overrides: Partial<AnalyzeIssueDeps> & {
    generate?: AnalyzeIssueDeps["generate"];
  } = {},
): AnalyzeIssueDeps {
  return {
    generate: overrides.generate ?? okGenerate(),
    model: overrides.model ?? "test-model",
    now: overrides.now ?? (() => new Date("2026-09-03T00:00:00.000Z")),
    delay: overrides.delay ?? (async () => {}),
    attempts: overrides.attempts,
    resolveEnv: overrides.resolveEnv,
  };
}

describe("analyzeIssue (#67)", () => {
  it("parses the classified-issue input, analyzes, and annotates the result", async () => {
    const generate = okGenerate();
    const result = await analyzeIssue(makeDeps({ generate }), baseInput);

    expect(AnalysisResult.parse(result)).toEqual(validAnalysis);
    expect(result.model).toBe("test-model");
    expect(result.analyzedAt).toBe("2026-09-03T00:00:00.000Z");
    expect(result.affectedFiles).toEqual([
      "src/parser.ts",
      "src/parser_test.ts",
    ]);
    // The classifier → analyzer handoff rides on AnalysisInput.classification.
    const call = generate.mock.calls[0]![0] as {
      system: string;
      prompt: string;
    };
    expect(call.prompt).toContain("## Issue");
    expect(call.prompt).toContain("## Classification");
    expect(call.prompt).toContain("Category: bug (confidence: 0.92)");
    expect(call.system).toContain("probes");
  });

  it("fails before any model or env call when the input is not a classified issue", async () => {
    const generate = okGenerate();
    const resolveEnv = vi.fn();
    await expect(
      analyzeIssue(makeDeps({ generate, resolveEnv }), {
        ...baseInput,
        classification: { category: "nonsense", confidence: 1 },
      }),
    ).rejects.toThrow();
    expect(generate).not.toHaveBeenCalled();
    expect(resolveEnv).not.toHaveBeenCalled();
  });

  it("resolves the env seam once, before the first model call", async () => {
    const order: string[] = [];
    const resolveEnv = vi.fn(() => {
      order.push("resolveEnv");
    });
    const generate = vi.fn(async (_params: GenerateParams) => {
      order.push("generate");
      return validAnalysis;
    });
    await analyzeIssue(makeDeps({ generate, resolveEnv }), baseInput);
    expect(order).toEqual(["resolveEnv", "generate"]);
    expect(resolveEnv).toHaveBeenCalledTimes(1);
    expect(generate).toHaveBeenCalledTimes(1);
  });

  it("fails fast on a deterministic env error instead of retrying it", async () => {
    const generate = okGenerate();
    const delays: number[] = [];
    await expect(
      analyzeIssue(
        makeDeps({
          generate,
          attempts: 3,
          delay: async (ms) => {
            delays.push(ms);
          },
          resolveEnv: () => {
            throw new Error(
              "analyzer requires DEEPSEEK_API_KEY in the host runtime",
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

  it("retries an invalid analysis with backoff and throws when it never complies", async () => {
    const delays: number[] = [];
    const generate = vi.fn(async (_params: GenerateParams) => ({
      affectedFiles: "not-an-array",
    }));
    await expect(
      analyzeIssue(
        makeDeps({
          generate,
          attempts: 2,
          delay: async (ms) => {
            delays.push(ms);
          },
        }),
        baseInput,
      ),
    ).rejects.toThrow(/analysis failed after 2 attempts/);
    expect(generate).toHaveBeenCalledTimes(2);
    expect(delays).toEqual([250]);
  });

  it("exports a defineTool-shaped analyze_issue with lazy live deps", () => {
    expect(typeof analyzeIssueTool.description).toBe("string");
    expect(analyzeIssueTool.description.length).toBeGreaterThan(10);
    expect(typeof analyzeIssueTool.execute).toBe("function");
    expect(createAnalyzeIssueTool(makeDeps()).description).toBe(
      analyzeIssueTool.description,
    );
  });
});

describe("live analyzer env resolution", () => {
  it("requires a gateway key at resolution time", () => {
    expect(() => resolveLiveAnalyzerEnv({})).toThrow(
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

  it("defaults the model to DeepSeek direct and honors ANALYZER_MODEL", () => {
    expect(resolveLiveAnalyzerEnv({ DEEPSEEK_API_KEY: "k" })).toMatchObject({
      apiKey: "k",
      model: ANALYZER_DEFAULT_MODEL,
      baseURL: ANALYZER_DEFAULT_BASE_URL,
    });
    expect(ANALYZER_DEFAULT_MODEL).toBe("deepseek-v4-flash");
    expect(ANALYZER_DEFAULT_BASE_URL).toBe("https://api.deepseek.com");
    expect(
      resolveLiveAnalyzerEnv({
        DEEPSEEK_API_KEY: "k",
        ANALYZER_MODEL: "anthropic/claude-haiku-4",
      }).model,
    ).toBe("anthropic/claude-haiku-4");
    // The retired gateway key is no longer part of the env contract (the
    // parameter type admits only DEEPSEEK_API_KEY now).
  });
});
