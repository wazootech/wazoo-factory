import { describe, expect, expectTypeOf, it, vi } from "vitest";

import {
  Classification,
  ClassificationInput,
  ClassificationResult,
  IssueCategory,
} from "../factory/classifier-schema.ts";
import {
  buildClassifierSystemPrompt,
  buildClassifierUserPrompt,
} from "../factory/classifier-prompt.ts";
import {
  classifyIssue,
  createClassifyIssueTool,
  DEFAULT_BACKOFF_MS,
  type ClassifyIssueDeps,
} from "../factory/classifier.ts";
import type { Classification as ClassificationValue } from "../factory/classifier-schema.ts";
import classifyIssueTool from "../agent/tools/classify_issue.ts";

const validClassification = {
  category: "bug",
  confidence: 0.9,
  rationale:
    "The parser crashes on empty input, which contradicts documented behavior.",
} satisfies ClassificationValue;

const baseInput = {
  issueNumber: 42,
  title: "Parser crashes on empty input",
  body: "Running the parser against a zero-byte file throws an unhandled exception.",
  repository: "wazootech/memsdk",
};

type GenerateParams = { system: string; prompt: string };

function okGenerate(value: unknown = validClassification) {
  return vi.fn(async (_params: GenerateParams) => value);
}

function makeDeps(
  overrides: Partial<ClassifyIssueDeps> & {
    generate?: ClassifyIssueDeps["generate"];
  } = {},
): ClassifyIssueDeps {
  return {
    generate: overrides.generate ?? okGenerate(),
    model: overrides.model ?? "test-model",
    now: overrides.now ?? (() => new Date("2026-08-23T00:00:00.000Z")),
    delay: overrides.delay ?? (async () => {}),
    attempts: overrides.attempts,
  };
}

describe("classifier schema (#39 contract)", () => {
  it("parses a valid strict triple", () => {
    const parsed = Classification.parse(validClassification);
    expect(parsed).toEqual(validClassification);
  });

  it("rejects additional fields", () => {
    expect(() =>
      Classification.parse({ ...validClassification, evidence: ["x"] }),
    ).toThrow();
  });

  it("rejects confidence outside [0,1]", () => {
    expect(() =>
      Classification.parse({ ...validClassification, confidence: 1.5 }),
    ).toThrow();
    expect(() =>
      Classification.parse({ ...validClassification, confidence: -0.1 }),
    ).toThrow();
  });

  it("accepts three sentences containing decimals and abbreviations", () => {
    const rationale =
      "In v1.2 the ingest loop dropped events, e.g. every second batch. The regression started after the retry change. Restoring the ack step fixes it.";
    expect(() =>
      Classification.parse({ ...validClassification, rationale }),
    ).not.toThrow();
  });

  it("rejects a four-sentence rationale", () => {
    const rationale =
      "One clear sentence ends here. A second sentence follows it. Then a third arrives. And a fourth closes the deal.";
    expect(() =>
      Classification.parse({ ...validClassification, rationale }),
    ).toThrow(/three sentences/);
  });

  it("rejects categories outside the taxonomy", () => {
    expect(() =>
      Classification.parse({ ...validClassification, category: "refactor" }),
    ).toThrow();
    expect(IssueCategory.options).toEqual(["bug", "feature", "docs"]);
  });

  it("defaults optional ClassificationInput fields", () => {
    const parsed = ClassificationInput.parse(baseInput);
    expect(parsed.labels).toEqual([]);
    expect(parsed.repositoryDescription).toBe("");
    expect(parsed.body.length).toBeGreaterThan(0);
  });

  it("rejects an empty title", () => {
    expect(() =>
      ClassificationInput.parse({ ...baseInput, title: "" }),
    ).toThrow();
  });

  it("validates a full ClassificationResult record", () => {
    const record = {
      classification: validClassification,
      input: ClassificationInput.parse(baseInput),
      model: "test-model",
      classifiedAt: "2026-08-23T00:00:00.000Z",
      schemaVersion: 1,
    };
    expect(ClassificationResult.parse(record)).toEqual(record);
    expect(() =>
      ClassificationResult.parse({ ...record, schemaVersion: 2 }),
    ).toThrow();
  });
});

describe("classifier prompt", () => {
  it("system prompt states the forced-choice taxonomy and confidence scale", () => {
    const system = buildClassifierSystemPrompt();
    for (const needle of ["bug", "feature", "docs", "confidence"]) {
      expect(system).toContain(needle);
    }
  });

  it("renders repository description when provided", () => {
    const prompt = buildClassifierUserPrompt({
      ...baseInput,
      repositoryDescription: "Persistent memory SDK for agents.",
    });
    expect(prompt).toContain(
      "Repository description: Persistent memory SDK for agents.",
    );
  });

  it("renders existing labels when provided", () => {
    const prompt = buildClassifierUserPrompt({
      ...baseInput,
      labels: ["needs-triage"],
    });
    expect(prompt).toContain("Existing labels: needs-triage");
  });

  it("omits context lines that are absent or empty", () => {
    const prompt = buildClassifierUserPrompt(baseInput);
    expect(prompt).not.toContain("Repository description:");
    expect(prompt).not.toContain("Existing labels:");
  });

  it("keeps the placeholder for an empty body", () => {
    const prompt = buildClassifierUserPrompt({ ...baseInput, body: "" });
    expect(prompt).toContain("(no body provided)");
  });
});

describe("classifyIssue", () => {
  const bugCase = {
    ...baseInput,
    title: "Teardown segfaults on Linux",
    body: "Process dies with a segfault during engine close.",
  };
  const featureCase = {
    ...baseInput,
    title: "Self-service signup",
    body: "Users need a way to create their own workspace without emailing Sandra.",
  };
  const docsCase = {
    ...baseInput,
    title: "README quickstart is stale",
    body: "The quickstart references removed flags; refresh the guide.",
  };

  it("classifies a bug-shaped issue end to end", async () => {
    const generate = okGenerate({
      category: "bug",
      confidence: 0.92,
      rationale: "A segfault during teardown is broken runtime behavior.",
    });
    const result = await classifyIssue(makeDeps({ generate }), bugCase);

    expect(generate).toHaveBeenCalledTimes(1);
    expect(result.classification.category).toBe("bug");
    expect(result.model).toBe("test-model");
    expect(result.schemaVersion).toBe(1);
    expect(result.classifiedAt).toBe("2026-08-23T00:00:00.000Z");
    expect(result.input.issueNumber).toBe(bugCase.issueNumber);
    expectTypeOf(result).toExtend<{ schemaVersion: 1 }>();
  });

  it("classifies feature- and docs-shaped issues", async () => {
    const deps = makeDeps({
      generate: okGenerate({
        category: "feature",
        confidence: 0.85,
        rationale: "Signup expands capability to new users.",
      }),
    });
    const feature = await classifyIssue(deps, featureCase);
    expect(feature.classification.category).toBe("feature");

    const docs = await classifyIssue(
      makeDeps({
        generate: okGenerate({
          category: "docs",
          confidence: 0.8,
          rationale: "The request asks for a documentation refresh.",
        }),
      }),
      docsCase,
    );
    expect(docs.classification.category).toBe("docs");
  });

  it("passes the rendered prompts to generate", async () => {
    const generate = okGenerate();
    await classifyIssue(makeDeps({ generate }), {
      ...bugCase,
      labels: ["crash"],
      repositoryDescription: "Memory SDK",
    });
    const call = generate.mock.calls[0]![0];
    expect(call.system).toContain("Forced choice");
    expect(call.prompt).toContain("Existing labels: crash");
    expect(call.prompt).toContain("Repository description: Memory SDK");
  });

  it("rejects invalid input before calling the model", async () => {
    const generate = okGenerate();
    await expect(
      classifyIssue(makeDeps({ generate }), { ...baseInput, title: "" }),
    ).rejects.toThrow(/title/i);
    expect(generate).not.toHaveBeenCalled();
  });

  it("retries flaky generations until one succeeds", async () => {
    const delays: number[] = [];
    let call = 0;
    const generate = vi.fn(async (_params: GenerateParams) => {
      call += 1;
      if (call < 3) {
        throw new Error("upstream unavailable");
      }
      return validClassification;
    });
    const result = await classifyIssue(
      makeDeps({
        generate,
        delay: async (ms) => {
          delays.push(ms);
        },
      }),
      bugCase,
    );

    expect(result.classification.category).toBe("bug");
    expect(generate).toHaveBeenCalledTimes(3);
    expect(delays).toEqual(DEFAULT_BACKOFF_MS.slice(0, 2));
  });

  it("throws after exhausting attempts with the last error attached", async () => {
    const generate = vi.fn(async (_params: GenerateParams) => {
      throw new Error("schema mismatch");
    });
    await expect(
      classifyIssue(makeDeps({ generate, attempts: 2 }), bugCase),
    ).rejects.toThrow(/after 2 attempts.*schema mismatch/s);
    expect(generate).toHaveBeenCalledTimes(2);
  });
});

describe("classify_issue Eve tool wiring", () => {
  it("exports a defineTool-shaped definition with executor access", () => {
    expect(typeof classifyIssueTool.description).toBe("string");
    expect(classifyIssueTool.description.length).toBeGreaterThan(10);
    expect(typeof classifyIssueTool.execute).toBe("function");

    const custom = createClassifyIssueTool({
      generate: okGenerate(),
      model: "wired-model",
    });
    expect(custom.description).toMatch(/classif/i);
  });

  it("tool execute returns a structured classification", async () => {
    const tool = createClassifyIssueTool({
      generate: okGenerate({
        category: "docs",
        confidence: 0.7,
        rationale: "The request asks for a documentation refresh.",
      }),
      model: "wired-model",
    });
    const output = await tool.execute(baseInput, undefined as never);
    expect(output.classification.category).toBe("docs");
    expect(output.model).toBe("wired-model");
  });
});
