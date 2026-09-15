/**
 * sync-agents.ts - one-way generator: OpenCode agents → Claude Code subagents.
 *
 * WHY: OpenCode (`.opencode/agents/*.md`) and Claude Code (`.claude/agents/*.md`)
 * use the same "YAML frontmatter + markdown body = system prompt" shape but
 * incompatible frontmatter schemas, model id formats, and permission/tool models.
 * Claude Code forces the prompt body inline (no include field), so true DRY is
 * impossible without codegen. This script makes `.opencode/agents/` the single
 * source of truth and emits translated `.claude/agents/*.md` from it.
 *
 * The body (system prompt) is copied VERBATIM - that's the DRY win. Only the
 * frontmatter is translated. Claude frontmatter is tool-level only, so the
 * nested OC read/bash/edit rules (path/command scope, last-match-wins) can't
 * live there. Instead the generator emits PreToolUse hooks per agent - a rules
 * JSON at .claude/hooks/rules/<name>.json + the shared
 * .claude/hooks/enforce-scope.sh - that re-applies those rules at runtime.
 *
 * GLOBAL parity: OpenCode merges opencode.jsonc's top-level `permission` into
 * EVERY agent. This generator reads that config and merges the global rules
 * into each agent's hook rules, GLOBAL-FIRST (so agent-specific rules win via
 * last-match-wins): the global `read` secret-denies (.env) thus reach
 * every agent as a `Read` PreToolUse hook, and global `bash` denies likewise.
 *
 * Residual losses (printed as WARNINGS / INFO):
 *  - 'ask' → allow (a PreToolUse hook cannot interactively prompt);
 *  - temperature (no Claude frontmatter equivalent);
 *  - Agent(name,…) task allowlists are honored ONLY when an agent runs as the
 *    --agent main thread; in subagent context the type list is ignored (a
 *    SubagentStart hook would be needed for subagent spawn-scoping);
 *  - external_directory (Claude scopes FS via settings additionalDirectories).
 *
 * Run from the repo root:
 *   bun run .opencode/scripts/sync-agents.ts           # generate
 *   bun run .opencode/scripts/sync-agents.ts --dry-run  # preview, write nothing
 *
 * Zero external deps: uses Bun's built-in Bun.YAML (Bun >= 1.3.x).
 */
import { readdir, readFile, writeFile, mkdir, rm } from "node:fs/promises";
import { join } from "node:path";

const YAML = (globalThis as any).Bun?.YAML;
if (!YAML?.parse) {
  console.error(
    "sync-agents: Bun.YAML not available. Run with Bun >= 1.3.x:\n  bun run .opencode/scripts/sync-agents.ts",
  );
  process.exit(1);
}

// Marker injected into every generated file's frontmatter so re-runs can clean
// stale output WITHOUT clobbering hand-written .claude/agents/*.md files.
const GEN_MARKER = "AUTO-GENERATED from .opencode/agents/";

// Paths resolved relative to THIS script so it works from any cwd.
const SCRIPT_DIR = (import.meta as any).dir ?? ".";
const SRC = join(SCRIPT_DIR, "..", "agents"); // .opencode/agents
const REPO_ROOT = join(SCRIPT_DIR, "..", "..");
const OC_CONFIG = join(REPO_ROOT, "opencode.jsonc"); // global permission + mcp servers
const DST = join(REPO_ROOT, ".claude", "agents"); // .claude/agents
// PreToolUse hook support: nested OC bash/edit rules survive the frontmatter
// flatten by being re-emitted as a rules JSON consumed by enforce-scope.sh.
const HOOKS_DIR = join(SCRIPT_DIR, "..", "..", ".claude", "hooks");
const RULES_DIR = join(HOOKS_DIR, "rules");
const HOOK_RUNNER = ".claude/hooks/enforce-scope.sh"; // repo-root-relative, as Claude invokes it

// OpenCode `provider/model-id` → Claude alias. Extend as you adopt models.
// Anything not listed emits `inherit` (with an INFO note).
const MODEL_ALIAS: Record<string, string> = {
  "anthropic/claude-sonnet-4-20250514": "sonnet",
  "anthropic/claude-opus-4-1-20250805": "opus",
  "anthropic/claude-haiku-4-20250514": "haiku",
};

// OpenCode permission key → Claude tool name(s).
// OC's single `edit` perm gates write + edit + apply_patch, hence both Edit and Write.
const PERM_TO_TOOL: Record<string, string[]> = {
  read: ["Read"],
  glob: ["Glob"],
  grep: ["Grep"],
  edit: ["Edit", "Write"],
  bash: ["Bash"],
  todowrite: ["TodoWrite"],
  webfetch: ["WebFetch"],
  websearch: ["WebSearch"],
  skill: ["Skill"],
};

// Permission keys with no Claude frontmatter equivalent (skipped + INFO).
const NO_EQUIV = new Set([
  "list", // Claude has no dedicated List tool; Glob covers dir listing
  "lsp", // MCP-scoped in Claude
  "external_directory", // Claude scopes FS via settings additionalDirectories
  "question", // AskUserQuestion isn't available to subagents in Claude
  "doom_loop", // OpenCode recovery-prompt gating
]);

// Ordered OC rule (last-match-wins) emitted to .claude/hooks/rules/<name>.json
// and re-applied at runtime by enforce-scope.sh.
interface ScopeRule {
  pattern: string;
  action: "allow" | "deny" | "ask";
}
interface HookRules {
  read?: ScopeRule[];
  bash?: ScopeRule[];
  edit?: ScopeRule[];
}

// Global opencode.jsonc rules merged into every agent (global-first).
interface GlobalRules {
  read: ScopeRule[];
  bash: ScopeRule[];
  edit: ScopeRule[];
  mcpServers: Set<string>;
}

interface Result {
  name: string;
  fmOut: Record<string, unknown>;
  warnings: string[];
  infos: string[];
  hookRules: HookRules;
}

// Convert an OC permission value (scalar | ordered object) to ordered rules.
// Scalars carry no path/command scope → no hook rules (the tool-level decision
// is handled by the allow/deny sets). Only nested objects produce scope rules.
function toScopeRules(v: any): ScopeRule[] {
  if (v && typeof v === "object") {
    return (Object.entries(v) as [string, any][]).map(([pattern, action]) => ({
      pattern,
      action: String(action) as ScopeRule["action"],
    }));
  }
  return [];
}

// Merge GLOBAL + agent rules, global-first. A naive [global, ...agent] concat
// would let a broad agent catch-all (e.g. "*": allow) silently drop GLOBAL
// defense-in-depth denies the agent never re-asserts (e.g. "cat .env*":
// deny). So non-overlapping global rules are RE-APPENDED at the END - last-
// match-wins then guarantees a global rule the agent didn't explicitly override
// still sticks, while patterns the agent DID re-assert (e.g. code-review's
// "git commit": deny) are excluded from the re-append so the explicit override
// survives. Preserves the global block's internal ordering (aspire deny→
// isolated-allow) in both copies.
function mergeRules(globalRules: ScopeRule[], agentRules: ScopeRule[]): ScopeRule[] {
  if (!globalRules.length) return agentRules;
  if (!agentRules.length) return globalRules;
  const agentPats = new Set(agentRules.map((r) => r.pattern));
  const reassert = globalRules.filter((g) => !agentPats.has(g.pattern));
  return [...globalRules, ...agentRules, ...reassert];
}

// Parse JSONC (opencode.jsonc): strip // line-comments and trailing commas
// while respecting string literals, then JSON.parse. Zero deps.
function parseJsonc(text: string): any {
  let out = "";
  let i = 0;
  let inStr = false;
  while (i < text.length) {
    const c = text[i];
    if (inStr) {
      out += c;
      if (c === "\\" && i + 1 < text.length) {
        out += text[i + 1];
        i += 2;
        continue;
      }
      if (c === '"') inStr = false;
      i++;
      continue;
    }
    if (c === '"') {
      inStr = true;
      out += c;
      i++;
      continue;
    }
    if (c === "/" && text[i + 1] === "/") {
      while (i < text.length && text[i] !== "\n") i++;
      continue;
    }
    out += c;
    i++;
  }
  out = out.replace(/,(\s*[}\]])/g, "$1");
  return JSON.parse(out);
}

function translate(name: string, oc: any, global: GlobalRules): Result {
  const warnings: string[] = [];
  const infos: string[] = [];
  const fmOut: Record<string, unknown> = { name };

  if (typeof oc.description === "string") {
    fmOut.description = oc.description;
  } else {
    warnings.push("missing `description` - Claude requires it");
  }

  if (typeof oc.model === "string") {
    if (oc.model in MODEL_ALIAS) {
      fmOut.model = MODEL_ALIAS[oc.model];
    } else {
      fmOut.model = "inherit";
      infos.push(
        `model '${oc.model}' not in MODEL_ALIAS → emitted 'inherit' (add it to MODEL_ALIAS to pin a Claude alias)`,
      );
    }
  }

  // Only the active `steps` maps; OpenCode treats a leading-dot key (`.steps`)
  // as disabled, so we deliberately do NOT map `.steps`.
  if (typeof oc.steps === "number") fmOut.maxTurns = oc.steps;
  if (".steps" in oc) {
    infos.push(
      "`.steps` is OpenCode's disabled-key convention - skipped (not emitted as maxTurns)",
    );
  }

  if (oc.mode === "primary") {
    infos.push(
      `mode: primary → Claude has no field; run as \`claude --agent ${name}\` to use it as the main session agent`,
    );
  } else if (oc.mode && oc.mode !== "subagent") {
    infos.push(`mode: ${oc.mode} → no Claude equivalent`);
  }

  if (oc.hidden) {
    infos.push("hidden: true → no equivalent (Claude lists all agents in /agents)");
  }
  if (oc.temperature !== undefined) {
    infos.push(
      `temperature: ${oc.temperature} → no Claude frontmatter equivalent (Claude uses model/effort)`,
    );
  }

  const perm = oc.permission ?? {};
  const allow = new Set<string>();
  const deny = new Set<string>();

  for (const [key, rawVal] of Object.entries(perm) as [string, any][]) {
    // MCP server glob, e.g. "context7_*" → mcp__context7. Only emit when the
    // prefix is a REAL mcp server (in opencode.jsonc `mcp`); OC custom tools
    // also use the `*_` shape (e.g. "loop_*", "ship_create_*") but are NOT MCP
    // servers - emitting mcp__<prefix> for those produces phantom tools.
    if (key.endsWith("_*")) {
      const server = key.slice(0, -2);
      if (!global.mcpServers.has(server)) {
        infos.push(
          `permission.${key}: '${server}' is not a configured mcp server (absent from opencode.jsonc mcp) - likely a custom tool, not an MCP server; no mcp__<server> emitted`,
        );
        continue;
      }
      const tool = `mcp__${server}`;
      if (rawVal === "allow") allow.add(tool);
      else if (rawVal === "deny") deny.add(tool);
      else if (rawVal === "ask") {
        allow.add(tool);
        warnings.push(
          `permission.${key}: 'ask' → emitted as allow (Claude has no per-tool 'ask')`,
        );
      }
      continue;
    }

    // `task` = subagent-spawn permission. Not a regular tool, but maps to
    // Claude's Agent tool. Nested allowlists → Agent(name, ...) syntax.
    if (key === "task") {
      if (typeof rawVal === "string") {
        if (rawVal === "allow") allow.add("Agent");
        else if (rawVal === "ask") {
          allow.add("Agent");
          warnings.push("permission.task: 'ask' → emitted as allow (Claude has no per-tool 'ask')");
        }
        // "deny" → omit Agent entirely (subagent can't spawn children)
      } else if (rawVal && typeof rawVal === "object") {
        handleNested("task", rawVal, [], allow, deny, warnings, name);
      }
      continue;
    }

    if (key in PERM_TO_TOOL) {
      const tools = PERM_TO_TOOL[key];
      if (typeof rawVal === "string") {
        applyScalar(rawVal, tools, allow, deny, warnings, key);
      } else if (rawVal && typeof rawVal === "object") {
        handleNested(key, rawVal, tools, allow, deny, warnings, name);
      }
      continue;
    }

    if (NO_EQUIV.has(key)) {
      infos.push(`permission.${key} → no Claude frontmatter equivalent (skipped)`);
    } else {
      infos.push(`permission.${key} → unmapped key (skipped)`);
    }
  }

  // Build hook rules by merging GLOBAL opencode.jsonc rules (global-first) with
  // this agent's nested rules (see mergeRules for the re-append rationale).
  // read: global rules apply to EVERY agent (secrets protected everywhere).
  // bash: skipped when the agent scalar-denies bash (no Bash tool to guard).
  // edit: global + nested.
  const hookRules: HookRules = {};
  const mergedRead = mergeRules(global.read, toScopeRules(perm.read));
  if (mergedRead.length) hookRules.read = mergedRead;
  const bashScalarDeny = typeof perm.bash === "string" && perm.bash === "deny";
  if (!bashScalarDeny) {
    const mergedBash = mergeRules(global.bash, toScopeRules(perm.bash));
    if (mergedBash.length) hookRules.bash = mergedBash;
  }
  const mergedEdit = mergeRules(global.edit, toScopeRules(perm.edit));
  if (mergedEdit.length) hookRules.edit = mergedEdit;
  if (hookRules.read?.length || hookRules.bash?.length || hookRules.edit?.length) {
    fmOut.hooks = emitHooksBlock(hookRules, name);
  }

  if (allow.size) fmOut.tools = [...allow];
  if (deny.size) fmOut.disallowedTools = [...deny];

  return { name, fmOut, warnings, infos, hookRules };
}

function applyScalar(
  val: string,
  tools: string[],
  allow: Set<string>,
  deny: Set<string>,
  warnings: string[],
  key: string,
) {
  if (val === "allow") tools.forEach((t) => allow.add(t));
  else if (val === "deny") tools.forEach((t) => deny.add(t));
  else if (val === "ask") {
    tools.forEach((t) => allow.add(t));
    warnings.push(
      `permission.${key}: 'ask' → emitted as allow. Claude has no per-tool 'ask'; gate via permissionMode or a PreToolUse hook.`,
    );
  }
}

function handleNested(
  key: string,
  obj: Record<string, any>,
  tools: string[],
  allow: Set<string>,
  deny: Set<string>,
  warnings: string[],
  name: string,
) {
  // `task` nested = subagent spawn allowlist → Claude Agent(type, ...) syntax.
  // F-GEN-1: this allowlist is honored ONLY when the agent runs as the main
  // thread (claude --agent <name>); in subagent context the type list is
  // ignored and any Agent type is spawnable. These agents normally run as
  // subagents, so OC's spawn-scoping is NOT enforced in the common case - a
  // SubagentStart hook would be needed to restore it. Documented, not fixed.
  if (key === "task") {
    const allowed: string[] = [];
    for (const [k, v] of Object.entries(obj)) {
      if (v === "allow" && k !== "*") allowed.push(k);
    }
    if (allowed.length) {
      allow.add(`Agent(${allowed.join(", ")})`);
      warnings.push(
        `permission.task: Agent(${allowed.join(", ")}) allowlist honored ONLY as the --agent main thread (claude --agent ${name}); in subagent context the type list is ignored. Spawn-scoping in subagent context needs a SubagentStart hook (not emitted).`,
      );
    }
    return;
  }

  // `edit`/`bash` nested: Claude frontmatter is tool-level only (no path/command
  // scoping), so the tool is emitted ALLOWED to preserve function. The dropped
  // scope is now RE-ENFORCED by a PreToolUse hook (rules JSON + enforce-scope.sh
  // emitted in main()), which re-applies these very rules last-match-wins. The
  // one residual loss is 'ask' → allow (a hook cannot interactively prompt).
  const entries = Object.entries(obj);
  const allowRules = entries.filter(([k, v]) => v === "allow" && k !== "*");
  const dropped = entries.filter(([k]) => k !== "*").map(([k, v]) => `${k}=${v}`);
  const hookScoped = key === "bash" || key === "edit";
  const restored = hookScoped
    ? " scope RE-ENFORCED via PreToolUse hook (.claude/hooks/rules/<agent>.json + enforce-scope.sh); 'ask'→allow remains (no interactive prompt)."
    : " scope LOST - Claude frontmatter is tool-level only.";

  if (allowRules.length) {
    tools.forEach((t) => allow.add(t));
    warnings.push(
      `permission.${key}: path/command-scoped allow-rules [${dropped.join(
        ", ",
      )}] → tool emitted ALLOWED.${restored}`,
    );
  } else {
    const star = obj["*"];
    if (typeof star === "string") applyScalar(star, tools, allow, deny, warnings, `${key}["*"]`);
    if (dropped.length) {
      warnings.push(
        `permission.${key}: non-allow rules [${dropped.join(", ")}] → tool-level decision from "*" above.${restored}`,
      );
    }
  }
}

function splitFrontmatter(raw: string): { fmText: string; body: string } | null {
  const lines = raw.split(/\r?\n/);
  if (lines[0]?.trim() !== "---") return null;
  let end = -1;
  for (let i = 1; i < lines.length; i++) {
    if (lines[i].trim() === "---") {
      end = i;
      break;
    }
  }
  if (end === -1) return null;
  return {
    fmText: lines.slice(1, end).join("\n"),
    body: lines.slice(end + 1).join("\n"),
  };
}

function yamlScalar(v: unknown): string {
  if (typeof v === "string") {
    return `"${v.replace(/\\/g, "\\\\").replace(/"/g, '\\"').replace(/\n/g, "\\n")}"`;
  }
  return String(v);
}

// Build the Claude Code `hooks:` frontmatter block (raw multi-line YAML). Only
// emits a matcher for modes that have scoped rules. fmOut.hooks carries this
// pre-formatted string; emitFrontmatter writes it verbatim (see special-case).
// Indentation is load-bearing: each matcher list item must sit UNDER PreToolUse
// (4-space indent) so the block parses as valid YAML.
function emitHooksBlock(rules: HookRules, name: string): string {
  const matchers: string[] = [];
  if (rules.read?.length) {
    matchers.push(
      `    - matcher: "Read"\n      hooks:\n        - type: command\n          command: "${HOOK_RUNNER} read ${name}"`,
    );
  }
  if (rules.bash?.length) {
    matchers.push(
      `    - matcher: "Bash"\n      hooks:\n        - type: command\n          command: "${HOOK_RUNNER} bash ${name}"`,
    );
  }
  if (rules.edit?.length) {
    matchers.push(
      `    - matcher: "Edit|Write"\n      hooks:\n        - type: command\n          command: "${HOOK_RUNNER} edit ${name}"`,
    );
  }
  return `hooks:\n  PreToolUse:\n${matchers.join("\n")}`;
}

function emitFrontmatter(fm: Record<string, unknown>): string {
  const order = ["name", "description", "model", "tools", "disallowedTools", "hooks", "maxTurns"];
  const lines: string[] = [
    "---",
    `# ${GEN_MARKER}<name>.md by .opencode/scripts/sync-agents.ts - DO NOT EDIT by hand.`,
    "# Regenerate:  bun run .opencode/scripts/sync-agents.ts",
  ];
  for (const k of order) {
    if (!(k in fm)) continue;
    if (k === "hooks") {
      // Pre-formatted multi-line YAML block (the full `hooks:` key) from emitHooksBlock.
      lines.push(fm["hooks"] as string);
      continue;
    }
    const v = fm[k];
    if (Array.isArray(v)) {
      lines.push(`${k}:`);
      for (const item of v) lines.push(`  - ${yamlScalar(item)}`);
    } else {
      lines.push(`${k}: ${yamlScalar(v)}`);
    }
  }
  for (const k of Object.keys(fm)) {
    if (order.includes(k)) continue;
    lines.push(`${k}: ${yamlScalar(fm[k])}`);
  }
  lines.push("---");
  return lines.join("\n");
}

async function main() {
  const dryRun = process.argv.includes("--dry-run");

  // Load the GLOBAL opencode.jsonc permission (merged into every agent by OC)
  // + the mcp server-name set (used to filter the `*_` MCP-glob heuristic).
  // Missing/unreadable config → empty global rules (no merge); warn loudly.
  let global: GlobalRules = { read: [], bash: [], edit: [], mcpServers: new Set() };
  try {
    const cfgRaw = await readFile(OC_CONFIG, "utf8");
    const cfg = parseJsonc(cfgRaw);
    const gperm = cfg?.permission ?? {};
    global = {
      read: toScopeRules(gperm.read),
      bash: toScopeRules(gperm.bash),
      edit: toScopeRules(gperm.edit),
      mcpServers: new Set(Object.keys(cfg?.mcp ?? {})),
    };
  } catch (e) {
    console.warn(
      `sync-agents: could not read/parse ${OC_CONFIG} - global permission NOT merged (secret-read denies will be MISSING). Fix this.\n  ${String(e)}`,
    );
  }

  let srcFiles: string[];
  try {
    srcFiles = (await readdir(SRC)).filter((f) => f.endsWith(".md"));
  } catch (e) {
    console.error(`sync-agents: source dir not found: ${SRC}\n  ${String(e)}`);
    process.exit(1);
  }
  if (!srcFiles.length) {
    console.error(`sync-agents: no .md files in ${SRC}`);
    process.exit(1);
  }

  await mkdir(DST, { recursive: true });
  await mkdir(RULES_DIR, { recursive: true });

  // Clean only previously-generated files (marker-based) so hand-written ones survive.
  let cleaned = 0;
  if (!dryRun) {
    for (const f of (await readdir(DST)).filter((f) => f.endsWith(".md"))) {
      const content = await readFile(join(DST, f), "utf8");
      if (content.includes(GEN_MARKER)) {
        await rm(join(DST, f));
        cleaned++;
      }
    }
    // RULES_DIR is a dedicated generated dir - wipe stale *.json so removed/renamed
    // agents don't leave orphan rule files that enforce-scope.sh would still load.
    for (const f of (await readdir(RULES_DIR)).filter((f) => f.endsWith(".json"))) {
      await rm(join(RULES_DIR, f));
      cleaned++;
    }
  }

  const results: Result[] = [];
  for (const file of srcFiles) {
    const name = file.replace(/\.md$/, "");
    const raw = await readFile(join(SRC, file), "utf8");
    const split = splitFrontmatter(raw);
    if (!split) {
      console.warn(`sync-agents: ${file}: no frontmatter delimiters - skipped`);
      continue;
    }
    let oc: any;
    try {
      oc = YAML.parse(split.fmText);
    } catch (e) {
      console.warn(`sync-agents: ${file}: frontmatter parse failed - skipped\n  ${String(e)}`);
      continue;
    }
    const res = translate(name, oc ?? {}, global);
    const out = emitFrontmatter(res.fmOut) + "\n" + split.body;
    results.push(res);
    if (!dryRun) {
      await writeFile(join(DST, `${name}.md`), out.endsWith("\n") ? out : out + "\n");
      // Emit hook rules whenever the agent has any scoped rules (read/bash/edit).
      // The frontmatter hooks block + enforce-scope.sh consume this at runtime.
      if (res.hookRules.read?.length || res.hookRules.bash?.length || res.hookRules.edit?.length) {
        const json = JSON.stringify(res.hookRules, null, 2);
        await writeFile(join(RULES_DIR, `${name}.json`), json.endsWith("\n") ? json : json + "\n");
      }
    }
  }

  const pad = Math.max(...results.map((r) => r.name.length));
  for (const r of results) {
    const tools = (r.fmOut.tools as string[] | undefined)?.join(", ") ?? "(inherit all)";
    const dis = (r.fmOut.disallowedTools as string[] | undefined)?.join(", ");
    const mt = r.fmOut.maxTurns ?? "";
    const hookModes = Object.keys(r.hookRules);
    const hooks = hookModes.length ? `  hooks=${hookModes.join("+")}` : "";
    console.log(
      `  ${r.name.padEnd(pad)}  → ${r.name}.md   tools=${tools}${dis ? `  deny=${dis}` : ""}${hooks}${mt ? `  maxTurns=${mt}` : ""}`,
    );
    for (const w of r.warnings) console.log(`      ⚠  ${w}`);
  }
  const withInfos = results.filter((r) => r.infos.length);
  if (withInfos.length) {
    console.log("\n  non-lossy notes (portable fields with no 1:1 target - informational):");
    for (const r of withInfos) for (const i of r.infos) console.log(`      •  ${r.name}: ${i}`);
  }
  const hooked = results.filter(
    (r) => r.hookRules.read?.length || r.hookRules.bash?.length || r.hookRules.edit?.length,
  );
  console.log(
    `\n${dryRun ? "[dry-run] would generate" : "generated"} ${results.length} agent(s) → ${DST}${
      hooked.length ? ` (+ ${hooked.length} scope-rule file(s) → ${RULES_DIR})` : ""
    }${cleaned ? ` (cleaned ${cleaned} stale generated file(s))` : ""}`,
  );
}

main().catch((e) => {
  console.error(`sync-agents: ${String(e?.stack ?? e)}`);
  process.exit(1);
});
