import { describe, expect, it } from "vitest";
import {
  formatClassificationComment,
  classificationLabel,
  formatClassificationAudit,
} from "@/factory/classifier/classifier.ts";
import type { ClassificationResult } from "@/factory/classifier/schema.ts";

const baseResult: ClassificationResult = {
  classification: {
    category: "bug",
    confidence: 0.92,
    rationale: "The parser crashes on empty input, contradicting docs.",
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

describe("formatClassificationComment", () => {
  it("renders a readable GitHub comment with icon, category, confidence, and rationale", () => {
    const comment = formatClassificationComment(baseResult);
    expect(comment).toContain("> **Issue Classification** 🐛");
    expect(comment).toContain("> **Category**: Bug");
    expect(comment).toContain("> **Confidence**: high (92%)");
    expect(comment).toContain("> **Rationale**: The parser crashes");
    expect(comment).toContain("> _Classified by test-model");
  });

  it("uses ✨ icon for features and 📝 for docs", () => {
    const feature = formatClassificationComment({
      ...baseResult,
      classification: { ...baseResult.classification, category: "feature", confidence: 0.7 },
    });
    expect(feature).toContain("✨");
    expect(feature).toContain("> **Category**: Feature");

    const docs = formatClassificationComment({
      ...baseResult,
      classification: { ...baseResult.classification, category: "docs", confidence: 0.4 },
    });
    expect(docs).toContain("📝");
    expect(docs).toContain("> **Category**: Docs");
  });

  it("maps confidence to low/medium/high labels", () => {
    const low = formatClassificationComment({
      ...baseResult,
      classification: { ...baseResult.classification, confidence: 0.3 },
    });
    expect(low).toContain("> **Confidence**: low (30%)");

    const medium = formatClassificationComment({
      ...baseResult,
      classification: { ...baseResult.classification, confidence: 0.6 },
    });
    expect(medium).toContain("> **Confidence**: medium (60%)");
  });
});

describe("classificationLabel", () => {
  it("returns prefixed labels with correct colors", () => {
    expect(classificationLabel("bug")).toEqual({
      label: "factory:bug",
      color: "d73a4a",
      description: "Classified as a bug by the Wazoo factory",
    });
    expect(classificationLabel("feature")).toEqual({
      label: "factory:feature",
      color: "a2eeef",
      description: "Classified as a feature by the Wazoo factory",
    });
    expect(classificationLabel("docs")).toEqual({
      label: "factory:docs",
      color: "0075ca",
      description: "Classified as documentation by the Wazoo factory",
    });
  });

  it("returns unclassified for unknown categories", () => {
    expect(classificationLabel("unknown")).toEqual({
      label: "factory:unclassified",
      color: "ededed",
      description: "Classification pending",
    });
  });
});

describe("formatClassificationAudit", () => {
  it("serializes the full result as JSON", () => {
    const audit = formatClassificationAudit(baseResult);
    const parsed = JSON.parse(audit);
    expect(parsed.classification.category).toBe("bug");
    expect(parsed.model).toBe("test-model");
    expect(parsed.schemaVersion).toBe(1);
  });
});
