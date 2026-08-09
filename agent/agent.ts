import { createOpenAICompatible } from "@ai-sdk/openai-compatible";
import { defineAgent } from "eve";

const opencodeGo = createOpenAICompatible({
  name: "opencode-go",
  apiKey: process.env.OPENCODE_GO_API_KEY,
  baseURL: "https://opencode.ai/zen/go/v1",
});

export default defineAgent({
  model: opencodeGo("deepseek-v4-flash"),
  modelContextWindowTokens: 128_000,
});
