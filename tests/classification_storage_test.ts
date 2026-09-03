import { describe, expect, it } from "vitest";
import { classificationDigest } from "@/factory/classifier/classifier.ts";
import type { ClassificationResult } from "@/factory/classifier/schema.ts";
import { MemoryWorkflowStore } from "@/factory/core/storage.ts";

const baseResult: ClassificationResult = {
  classification: {
    category: "bug",
    confidence: 0.92,
    rationale: "The parser crashes on empty input.",
  },
  input: {
    issueNumber: 42,
    title: "Parser crashes on empty input",
    body: "Stack trace attached.",
    labels: ["needs-triage"],
    repository: "wazootech/example",
    repositoryDescription: "Example repo",
  },
  model: "test-model",
  classifiedAt: "2026-08-23T00:00:00.000Z",
  schemaVersion: 1 as const,
};

describe("classificationDigest", () => {
  it("produces a deterministic 64-char hex digest", () => {
    const a = classificationDigest(baseResult);
    const b = classificationDigest(baseResult);
    expect(a).toBe(b);
    expect(a).toMatch(/^[a-f0-9]{64}$/);
  });

  it("changes when the issue number changes", () => {
    const different = classificationDigest({
      ...baseResult,
      input: { ...baseResult.input, issueNumber: 99 },
    });
    expect(different).not.toBe(classificationDigest(baseResult));
  });

  it("changes when the classifiedAt timestamp changes", () => {
    const different = classificationDigest({
      ...baseResult,
      classifiedAt: "2026-08-24T00:00:00.000Z",
    });
    expect(different).not.toBe(classificationDigest(baseResult));
  });

  it("changes when the repository changes", () => {
    const different = classificationDigest({
      ...baseResult,
      input: { ...baseResult.input, repository: "wazootech/other" },
    });
    expect(different).not.toBe(classificationDigest(baseResult));
  });
});

describe("classification storage through WorkflowStore", () => {
  it("persists and retrieves a classification result by digest", async () => {
    const store = new MemoryWorkflowStore();
    const digest = classificationDigest(baseResult);

    await store.put(digest, baseResult);
    const retrieved = await store.get<ClassificationResult>(digest);

    expect(retrieved).toEqual(baseResult);
  });

  it("is idempotent: putting the same digest twice does not overwrite", async () => {
    const store = new MemoryWorkflowStore();
    const digest = classificationDigest(baseResult);

    await store.put(digest, baseResult);
    // Second put with different data should be a no-op
    await store.put(digest, {
      ...baseResult,
      classification: { ...baseResult.classification, category: "docs" },
    });

    const retrieved = await store.get<ClassificationResult>(digest);
    expect(retrieved?.classification.category).toBe("bug");
  });

  it("stores different classifications for the same issue at different times", async () => {
    const store = new MemoryWorkflowStore();

    const first = baseResult;
    const second: ClassificationResult = {
      ...baseResult,
      classifiedAt: "2026-08-24T00:00:00.000Z",
    };

    const digest1 = classificationDigest(first);
    const digest2 = classificationDigest(second);

    expect(digest1).not.toBe(digest2);

    await store.put(digest1, first);
    await store.put(digest2, second);

    expect(await store.get<ClassificationResult>(digest1)).toEqual(first);
    expect(await store.get<ClassificationResult>(digest2)).toEqual(second);
  });

  it("returns undefined for a missing digest", async () => {
    const store = new MemoryWorkflowStore();
    expect(
      await store.get<ClassificationResult>("a".repeat(64)),
    ).toBeUndefined();
  });
});
