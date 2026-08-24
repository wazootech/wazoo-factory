import { createOpenAICompatible } from "@ai-sdk/openai-compatible";
import { defineAgent } from "eve";

const opencodeGo = createOpenAICompatible({
  name: "opencode-go",
  apiKey: process.env.OPENCODE_GO_API_KEY,
  baseURL: "https://opencode.ai/zen/go/v1",
});

export default defineAgent({
  model: opencodeGo("ox-alpha-free"),
  modelContextWindowTokens: 128_000,
});
