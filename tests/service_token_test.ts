import { describe, expect, it } from "vitest";
import { serviceTokenAuth } from "@/agent/lib/service-token.ts";

function requestWith(token: string | null): Request {
  return new Request("http://localhost/eve/v1/session", {
    method: "POST",
    headers: token ? { authorization: `Bearer ${token}` } : {},
  });
}

describe("service token auth", () => {
  it("authenticates a bearer request with the configured token", async () => {
    process.env.FACTORY_SERVICE_TOKEN = "factory-token";
    try {
      const auth = serviceTokenAuth();
      const sessionAuth = await auth(requestWith("factory-token"));
      expect(sessionAuth).toMatchObject({
        authenticator: "service-token",
        principalId: "factory-service",
        principalType: "service",
      });
    } finally {
      delete process.env.FACTORY_SERVICE_TOKEN;
    }
  });

  it("returns null for a missing or wrong token", async () => {
    process.env.FACTORY_SERVICE_TOKEN = "factory-token";
    try {
      const auth = serviceTokenAuth();
      expect(await auth(requestWith("wrong-token"))).toBeNull();
      expect(await auth(requestWith(null))).toBeNull();
    } finally {
      delete process.env.FACTORY_SERVICE_TOKEN;
    }
  });

  it("refuses every request when the token is not configured", async () => {
    delete process.env.FACTORY_SERVICE_TOKEN;
    const auth = serviceTokenAuth();
    expect(await auth(requestWith("factory-token"))).toBeNull();
  });
});
