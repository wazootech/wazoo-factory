import { readFile } from "node:fs/promises";
import { describe, expect, it } from "vitest";

describe("agent configuration", () => {
  it("documents the native sandbox tools used for coding", async () => {
    const instructions = await readFile(
      new URL("../agent/instructions.md", import.meta.url),
      "utf8",
    );

    expect(instructions).toContain("read_file");
    expect(instructions).toContain("write_file");
    expect(instructions).toContain("bash");
  });
});
