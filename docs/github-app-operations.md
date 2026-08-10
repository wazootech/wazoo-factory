# GitHub App Operations

The production GitHub App is a server-side credential. Never put its private
key, webhook secret, installation token, or Vercel environment values in a
repository, issue comment, workflow artifact, executor input, or log.

## Private-Key Rotation

1. Create a new private key in the GitHub App settings and download it directly
   to the operator's protected temporary location.
2. Update the Vercel/Eve server-side `GITHUB_APP_PRIVATE_KEY` secret without
   changing `GITHUB_APP_ID`, `GITHUB_APP_INSTALLATION_ID`, or the repository
   allowlist.
3. Redeploy the hosted service so new instances load the replacement key.
4. Exercise a non-mutating installation-token request and confirm the service
   can read the configured staging repository.
5. Exercise the approval-gated dry-run path and confirm no repository mutation
   occurs without a factory approval.
6. Delete the previous private key in GitHub after the replacement is verified.
7. Record only the timestamp, operator, App id, installation id, and result.
   Do not record key material or tokens.

The old key must remain available only until the replacement has been verified.
The hosted runtime accepts literal newlines or `\\n` escapes in the configured
private-key value.

## Installation Revocation

1. Disable or uninstall the production App from the GitHub organization when
   access must stop immediately.
2. Remove the hosted GitHub App environment values from the deployment secret
   store, or replace them with an explicitly unavailable configuration.
3. Redeploy and confirm GitHub requests fail closed without falling back to a
   user `gh` session.
4. Confirm existing factory workflows remain auditable but cannot create issues,
   branches, or pull requests.
5. Reinstall only after the repository selection, permissions, and events have
   been reviewed by an organization owner.

## Installation Review

Before enabling production mutations, an organization owner must verify in the
GitHub App installation UI:

- repository selection is `All repositories`, as approved for the organization;
- permissions are limited to metadata read, contents write, issues write, and
  pull requests write for the current tracer bullet;
- subscribed events are limited to `issues`, `pull_request`, and `push`.

The REST API used by the local provisioning workflow does not provide an
authenticated endpoint for changing these installation-level selections. Keep
the installation hardening ticket open until the owner has supplied this
evidence and the rotation/revocation exercise is complete.
