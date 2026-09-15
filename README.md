# OpenCode ↔ Claude Code agent sync

A one-way generator that translates [OpenCode](https://opencode.ai) agent definitions (`.opencode/agents/*.md`) into [Claude Code](https://code.claude.com) subagent equivalents (`.claude/agents/*.md`), plus a `PreToolUse` hook that restores the path/command-scoped permissions Claude's flat `tools`/`disallowedTools` lists can't express, and a CI job that regenerates and diffs so drift fails the PR instead of shipping silently.

Full write-up, with the reasoning behind every design decision here: **[Same Agents, Two Tools: How I Keep OpenCode and Claude Code in Sync](https://sypniewski.dev/en/blog/opencode-claude-code-agent-sync/)**.

This repo is an extract of the real files from my own project, with the project-specific bits generalized (`.env`/secrets paths, the CI runner and action pins). It's a reference, not a template: there's no sample `.opencode/agents/` tree included, since the point is to drop these files into a repo that already has one.

## What's here

- `.opencode/scripts/sync-agents.ts` — the generator. Zero external dependencies, runs on [Bun](https://bun.sh) (>= 1.3.x, uses the built-in `Bun.YAML.parse`).
- `.claude/hooks/enforce-scope.sh` — the runtime hook that re-applies OpenCode's original permission scoping, since it can't survive the frontmatter translation.
- `.github/workflows/agents-sync.yml` — CI job: regenerate, then `git diff --exit-code -- .claude`.
- `.gitattributes` — forces LF across the source and generated trees so that diff is byte-exact across platforms.

## Using it

1. Copy `.opencode/scripts/sync-agents.ts`, `.claude/hooks/enforce-scope.sh`, and the `.gitattributes` lines into your repo (adjust paths if your `.opencode/agents/` or `opencode.jsonc` don't live at the repo root).
2. Run `bun run .opencode/scripts/sync-agents.ts` from the repo root. It reads your `.opencode/agents/*.md` and `opencode.jsonc`, and writes translated frontmatter + a rules JSON per agent to `.claude/agents/` and `.claude/hooks/rules/`.
3. Wire `enforce-scope.sh` into each generated agent's `PreToolUse` hook (the generator does this for you automatically, in the frontmatter it emits).
4. Add the CI workflow, or fold the two steps (regenerate, diff) into an existing job.

`--dry-run` previews the output without writing anything.

## What doesn't survive the translation

The generator prints these as warnings/info rather than silently dropping them: `ask` degrades to `allow` (a `PreToolUse` hook can't interactively prompt), `temperature` has no Claude equivalent, and `Agent(name, ...)` task allowlists are only honored when the agent runs as the `--agent` main thread. See the blog post for the full reasoning, including the security fix that shaped `mergeRules()` and the fail-open trade-off in the hook.

## License

MIT — see [LICENSE](./LICENSE).
