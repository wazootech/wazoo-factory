import { eveChannel } from "eve/channels/eve";
import { localDev } from "eve/channels/auth";
import { serviceTokenAuth } from "@/agent/lib/service-token.ts";

/**
 * Production routes authenticate with a shared service token
 * (`FACTORY_SERVICE_TOKEN`); Eve's built-in liveness route stays
 * unauthenticated. `localDev()` is deliberately retained only for `eve dev`;
 * it never authenticates production traffic.
 */
export default eveChannel({
  auth: [serviceTokenAuth(), localDev()],
});
