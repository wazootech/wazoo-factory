import { defineSandbox } from "eve/sandbox";
import { vercel } from "eve/sandbox/vercel";

export default defineSandbox({
  // Use the hosted backend locally as well as in production so execution is
  // exercised against the same isolation boundary before deployment.
  backend: vercel({
    resources: { vcpus: 2 },
    networkPolicy: "allow-all",
  }),
});
