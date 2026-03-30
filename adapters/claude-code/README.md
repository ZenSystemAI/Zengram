# Zengram — Claude Code Skills

Claude Code skills that integrate with Zengram for session memory and institutional knowledge.

## Prerequisites

- [Zengram MCP server](../../mcp-server/) configured in your Claude Code settings
- `brain_store`, `brain_search`, and other Zengram MCP tools available

## Available Skills

### sessionend

End-of-session ritual that turns each session into institutional memory. Stores structured reflections to Zengram, detects repeatable workflows worth capturing as skills, and spots mistakes worth adding as CLAUDE.md rules.

**Triggers:** `/sessionend`, "wrapping up", "that's it for today", "end session", "session summary"

**What it does:**
1. Gathers session artifacts (git log, diff, conversation review)
2. Reflects honestly on what went well and what didn't
3. Stores a structured reflection to Zengram via `brain_store`
4. Updates local project memory if new information was discovered
5. Spots repeatable workflows (suggests new skills)
6. Spots mistake patterns (proposes CLAUDE.md rules)

## Installation

Copy the skill directory to your project's `.claude/skills/`:

```bash
cp -r adapters/claude-code/sessionend /path/to/your-project/.claude/skills/
```

Or symlink for auto-updates:

```bash
ln -s /path/to/zengram/adapters/claude-code/sessionend /path/to/your-project/.claude/skills/sessionend
```

The skill will then appear in Claude Code's `/sessionend` command.

## How It Fits

```
Session ends → /sessionend → Reflection → brain_store → Zengram
                                        → Local memory update
                                        → Workflow pattern detection
                                        → Rule pattern detection
```

The sessionend skill is the primary feedback loop that turns ephemeral session context into durable institutional memory. Over time, this builds a searchable record of decisions, mistakes, and lessons that any agent connected to Zengram can access.
