import { readFile } from "node:fs/promises";
import { describe, expect, it } from "vitest";
import agent from "../agent/agent.ts";
import sandbox from "../agent/sandbox/sandbox.ts";

describe("agent configuration", () => {
  it("uses the pinned OpenCode Go model", () => {
    expect(agent.model.modelId).toBe("ox-alpha-free");
    expect(agent.modelContextWindowTokens).toBe(128_000);

    const modelConfig = (
      agent.model as unknown as { config: { provider: string } }
    ).config;
    expect(modelConfig.provider).toBe("opencode-go.chat");
  });

  it("uses the Vercel sandbox backend", () => {
    expect(sandbox.backend?.name).toBe("vercel");
  });

  it("documents the native sandbox tools and evidence rules", async () => {
    const instructions = await readFile(
      new URL("../agent/instructions.md", import.meta.url),
      "utf8",
    );

    expect(instructions).toContain("read_file");
    expect(instructions).toContain("write_file");
    expect(instructions).toContain("bash");
    expect(instructions).toContain("sandbox isolation evidence");
    expect(instructions).toContain("including its build");
  });
});
