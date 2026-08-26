// Classifier system prompt (#36 iteration 2). Beyond the minimal v1 taxonomy,
// this encodes the failure modes measured by the ratified-gold rescore of the
// Ox Alpha Free baseline (82.5%, docs recall ~54%): written-material tickets
// were called "feature" because adding something new felt like a feature, and
// one CI-failure alert was classified from its repository name. Legacy org
// labels must never be mentioned or supplied.

export function buildSystemPrompt(): string {
  return [
    "You classify software repository issues into exactly one of three categories.",
    "Forced choice: you must always pick one; there is no other or unclear option.",
    "",
    "Decision procedure - ask the questions in order:",
    "1. What artifact changes when the issue is resolved?",
    "   If only written material changes (documentation, wiki pages, specs,",
    "   templates, skill or policy guides, survey reports, verification",
    "   write-ups), classify it as docs - even when the ticket adds something",
    "   new. Tickets whose deliverable is a written finding, audit result, or",
    '   go/no-go recommendation ("verify X", "research Y", "survey Z") are docs.',
    "   Only if runtime code or build/config artifacts change, continue:",
    "2. Is claimed behavior broken?",
    "   Contrary to documented intent, crashing, producing wrong results, or a",
    "   regression is bug. Otherwise it is a new capability or enhancement:",
    "   feature.",
    "",
    "Category definitions:",
    "- bug: something is broken, crashes, produces wrong results, regressed, or behaves contrary to documented intent.",
    "- feature: a request for new capability, enhancement, or support for a new use case.",
    "- docs: improvements, fixes, or requests concerning documentation, guides, examples, or reference material.",
    "",
    "Edge rulings:",
    "- Mixed-scope tickets: classify by the dominant deliverable.",
    "- Refactors and test-only changes without a defect are feature.",
    "- Routine maintenance (dependency updates, toolchain migrations, new CI workflows) is feature: code or config changes, nothing broken.",
    "- Security exploits are bug; security hardening without an exploit is feature.",
    "- Automated failure alerts (failing checks, drift detection) report something broken: bug.",
    "",
    "Output discipline:",
    '- category: one of "bug", "feature", "docs".',
    "- confidence: your certainty in [0,1]. Reserve >= 0.8 for unambiguous cases.",
    "- rationale: at most three sentences. Cite the deciding signal from the issue text.",
    "",
    "Classify by the change the ticket demands. Never infer the category from",
    "repository names, project names, or title nouns alone.",
    "Judge the issue on its content alone. Do not assume labels or metadata.",
  ].join("\n");
}

export interface ClassificationPromptInput {
  repository: string;
  title: string;
  body: string;
  /** Optional issue labels, rendered as passive context. */
  labels?: readonly string[];
  /** Optional repository description, rendered above the repository line. */
  repositoryDescription?: string;
}

export function buildUserPrompt(input: ClassificationPromptInput): string {
  const body = input.body.trim().length > 0 ? input.body : "(no body provided)";
  const lines: string[] = [];
  // The repository name is deliberately not rendered: the rescore showed the
  // model anchoring on repo-name nouns (e.g. predicting "docs" for a CI
  // failure alert because the repo was docs.wazoo.dev). Title and body carry
  // the classification signal; the field stays in the interface so callers
  // keep a stable shape.
  lines.push(`Issue title: ${input.title}`);
  if (input.labels && input.labels.length > 0) {
    lines.push(`Existing labels: ${input.labels.join(", ")}`);
  }
  lines.push("");
  lines.push("Issue body:");
  lines.push(body);
  return lines.join("\n");
}
