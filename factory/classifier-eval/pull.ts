import { CaseFile } from "./schema.ts";

// GitHub issue payload as returned by `gh issue list --json` (subset).
export interface GhIssuePayload {
  number: number;
  title: string;
  url: string;
  body?: string | null;
  labels?: Array<{ name: string }>;
}

const BODY_LIMIT = 3000;

function shortRepoName(repository: string): string {
  const slash = repository.lastIndexOf("/");
  return slash === -1 ? repository : repository.slice(slash + 1);
}

// Pure mapper from a gh issue payload to a fixture case. Deterministic ids:
// `<short-repo>-<issue-number>`. Bodies truncate to the context budget.
export function mapIssueToCase(input: {
  repository: string;
  issue: GhIssuePayload;
}): CaseFile {
  const body = (input.issue.body ?? "").slice(0, BODY_LIMIT);
  const candidate = CaseFile.parse({
    id: `${shortRepoName(input.repository)}-${input.issue.number}`,
    repository: input.repository,
    issueNumber: input.issue.number,
    title: input.issue.title,
    body,
    url: input.issue.url,
    legacyLabels: (input.issue.labels ?? []).map((label) => label.name),
  });
  return candidate;
}
