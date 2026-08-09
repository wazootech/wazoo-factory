import { describe, expect, it } from "vitest";
import { evaluateExecutor } from "../benchmark/scoring.ts";
import { buildReport } from "../benchmark/report.ts";
import {
  parseModelReference,
  parseStructuredJson,
  type ExecutorRun,
} from "../benchmark/executor.ts";

function run(
  executor: "opencode" | "eve-native",
  overrides: Partial<ExecutorRun["result"]> = {},
): ExecutorRun {
  return {
    executor,
    taskId: "01-hello-world",
    durationMs: 1000,
    result: {
      success: true,
      filesChanged: ["main.ts"],
      checksRun: [],
      interrupted: false,
      resumed: false,
      ...overrides,
    },
  };
}

describe("evaluateExecutor", () => {
  it("passes both gates and scores 1.0 for a clean full run", () => {
    const evaluation = evaluateExecutor([
      run("opencode", {
        structuredOutput: { success: true },
        tokenUsage: { input: 10, output: 5, total: 15 },
      }),
    ]);
    expect(evaluation.gates.security).toBe(true);
    expect(evaluation.gates.reliability).toBe(true);
    // repositoryAccess, structuredResults, tokenUsage = 1.0 each; resumeBehavior
    // scores 0 until an interrupt/resume cycle is exercised.
    expect(evaluation.comparativeScore).toBeCloseTo(0.75);
    expect(evaluation.passed).toBe(true);
  });

  it("fails the security gate when observations are reported", () => {
    const evaluation = evaluateExecutor([
      run("opencode", { securityObservations: ["credential exposed"] }),
    ]);
    expect(evaluation.gates.security).toBe(false);
    expect(evaluation.passed).toBe(false);
  });

  it("fails the reliability gate when a run does not succeed", () => {
    const evaluation = evaluateExecutor([run("opencode", { success: false })]);
    expect(evaluation.gates.reliability).toBe(false);
    expect(evaluation.passed).toBe(false);
  });

  it("fails the reliability gate with no runs", () => {
    const evaluation = evaluateExecutor([]);
    expect(evaluation.gates.reliability).toBe(false);
    expect(evaluation.gates.security).toBe(true);
    expect(evaluation.passed).toBe(false);
  });

  it("scores repository access by files changed", () => {
    const evaluation = evaluateExecutor([
      run("opencode", { filesChanged: ["main.ts"] }),
      run("opencode", { filesChanged: [] }),
    ]);
    const access = evaluation.dimensions.find(
      (d) => d.dimension === "repositoryAccess",
    );
    expect(access!.score).toBeCloseTo(0.5);
  });

  it("scores structured results by structured output presence", () => {
    const evaluation = evaluateExecutor([
      run("opencode", { structuredOutput: { success: true } }),
      run("opencode", {}),
    ]);
    const structured = evaluation.dimensions.find(
      (d) => d.dimension === "structuredResults",
    );
    expect(structured!.score).toBeCloseTo(0.5);
  });

  it("scores resume behavior only when interrupted", () => {
    const evaluation = evaluateExecutor([
      run("opencode", { interrupted: true, resumed: true }),
    ]);
    const resume = evaluation.dimensions.find(
      (d) => d.dimension === "resumeBehavior",
    );
    expect(resume!.score).toBeCloseTo(1.0);
  });

  it("gives zero resume score when no interrupt occurred", () => {
    const evaluation = evaluateExecutor([run("opencode")]);
    const resume = evaluation.dimensions.find(
      (d) => d.dimension === "resumeBehavior",
    );
    expect(resume!.score).toBe(0);
  });
});

describe("parseModelReference", () => {
  it("splits provider and model ids", () => {
    expect(parseModelReference("opencode-go/deepseek-v4-flash")).toEqual({
      providerID: "opencode-go",
      modelID: "deepseek-v4-flash",
    });
  });

  it("rejects malformed model ids", () => {
    expect(() => parseModelReference("deepseek-v4-flash")).toThrow(
      /provider\/model format/,
    );
  });
});

describe("parseStructuredJson", () => {
  it("extracts JSON after a natural-language response", () => {
    expect(
      parseStructuredJson(
        'The task is complete. {"filesChanged": [], "success": true}',
      ),
    ).toEqual({ filesChanged: [], success: true });
  });
});

describe("buildReport", () => {
  it("recommends the highest-scoring passing executor", () => {
    const winner = evaluateExecutor([
      run("opencode", { structuredOutput: { success: true } }),
    ]);
    const loser = evaluateExecutor([run("eve-native", { filesChanged: [] })]);
    const report = buildReport(
      [run("opencode"), run("eve-native")],
      [winner, loser],
    );
    expect(report.recommendation).toContain("opencode");
  });

  it("recommends not proceeding when no executor passes", () => {
    const evaluations = [
      evaluateExecutor([run("opencode", { success: false })]),
      evaluateExecutor([run("eve-native", { securityObservations: ["x"] })]),
    ];
    const report = buildReport(
      [run("opencode"), run("eve-native")],
      evaluations,
    );
    expect(report.recommendation).toContain("Do not proceed");
  });
});
