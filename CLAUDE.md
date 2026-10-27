@AGENTS.md

## Code graph (Graphify)

- For structural questions (what calls what, where a feature lives), check `graphify-out/GRAPH_REPORT.md` and use graph queries before reading many files.
- Always read the actual files before editing them; the graph is a map, not the source of truth.
- After significant changes, update the graph incrementally rather than doing a full rebuild: `/graphify . --update` (skill) or `graphify update .` (shell, no LLM needed).
