import { createOpenAICompatible } from "@ai-sdk/openai-compatible";
import { defineAgent } from "eve";

const vercelGateway = createOpenAICompatible({
  name: "vercel-ai-gateway",
  apiKey: process.env.AI_GATEWAY_API_KEY,
  baseURL: "https://ai-gateway.vercel.sh/v1",
});

export default defineAgent({
  model: vercelGateway("openai/gpt-4.1-nano"),
  modelContextWindowTokens: 128_000,
});
