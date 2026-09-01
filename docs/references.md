# References

External sources that informed the Wazoo software factory architecture,
design decisions, and implementation approach.

## Software factory concept

- [Building a software factory for AI SDK](https://vercel.com/blog/building-a-software-factory-for-ai-sdk) — Vercel's factory for AI SDK: 4 agents (Classifier, Analyzer, Implementer, Reviewer), human-in-the-loop merge, 25-35% of merged PRs authored by agents. Primary architectural reference for the 4-module split and light/dark operating modes.
- [Building a software factory](https://hraness.substack.com/p/harnessing-agents) — Hraness's 30-day writeup on agent-driven development and software factory patterns.
- [The rise of software factories](https://x.com/hraness/status/2094532326357397595) — Hraness on the emerging category of AI-native software factories.
- [How to Build an AI Software Factory with AI Agents in TypeScript](https://mastra.ai/blog/software-factory) — Mastra's take on governed, observable agent systems for software development.
- [mastra-ai/softwarefactory-template](https://github.com/mastra-ai/softwarefactory-template) — Mastra's open-source software factory template.

## Reference implementations

- [addyosmani/factory](https://github.com/addyosmani/factory) — Reference software factory for Claude Code and Codex.
- [addyosmani/agent-skills](https://github.com/addyosmani/agent-skills) — Production-grade engineering skills for AI coding agents.
- [coleam00/Archon](https://github.com/coleam00/Archon) — Open-source harness builder for AI coding; makes AI coding deterministic and repeatable.

## Agent orchestration and harnesses

- [Ryan Dahl on celld](https://x.com/rough__sea/status/2092091242377265562) — Ryan Dahl's development approach for celld; exported from a larger private repo, demonstrating repo-as-artifact patterns.
- [Cursor pstack plugin spec](https://github.com/cursor/plugins/tree/main/pstack#readme) — Cursor's plugin specification for structured tooling.
- [Anti-slop for coding](https://x.com/juampitech/status/2091908660058333679) — Curated list of tools to reduce low-quality AI-generated code (anti-slop, thermo-nuclear, deslop).

## SDLC and process

- [The AI-Native SDLC playbook](https://claude.com/blog/the-ai-native-sdlc-playbook) — Anthropic's stage-by-stage playbook for AI-native software development lifecycle.
- [The /wayfinder Skill](https://www.aihero.dev/skills-wayfinder) — Pattern for charting large efforts as shared maps of decision tickets.
