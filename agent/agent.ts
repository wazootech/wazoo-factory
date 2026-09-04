import { createOpenAICompatible } from "@ai-sdk/openai-compatible";
import { defineAgent } from "eve";

const deepseek = createOpenAICompatible({
  name: "deepseek",
  apiKey: process.env.DEEPSEEK_API_KEY,
  baseURL: "https://api.deepseek.com",
});

export default defineAgent({
  model: deepseek("deepseek-v4-flash"),
  modelContextWindowTokens: 128_000,
});
