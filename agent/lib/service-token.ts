import { createHash, timingSafeEqual } from "node:crypto";
import { extractBearerToken, withAuthChallenges } from "eve/channels/auth";
import type { AuthFn } from "eve/channels/auth";

/**
 * Machine-to-machine authentication for the HTTP channel. All functional
 * routes gate behind a shared bearer token; only Eve's built-in liveness
 * route stays unauthenticated. `localDev()` remains available for `eve dev`.
 */
export function serviceTokenAuth(): AuthFn<Request> {
  const expected = process.env.FACTORY_SERVICE_TOKEN;
  return withAuthChallenges(
    (request) => {
      if (!expected) return null;
      const token = extractBearerToken(request.headers.get("authorization"));
      if (!token) return null;
      const actual = createHash("sha256").update(token).digest();
      const want = createHash("sha256").update(expected).digest();
      if (actual.length !== want.length || !timingSafeEqual(actual, want))
        return null;
      return {
        attributes: {},
        authenticator: "service-token",
        principalId: "factory-service",
        principalType: "service",
        subject: "factory-service",
        issuer: "factory",
      };
    },
    [{ scheme: "Bearer" }],
  );
}
