---
name: sessionend
description: "End-of-session ritual that turns sessions into institutional memory via Zengram. Detects repeatable workflows worth capturing as skills AND mistakes/corrections worth capturing as CLAUDE.md rules. Reflects honestly, stores to Zengram, updates local memory, spots workflow patterns, and proposes rule updates. Use when the user types /sessionend, says they're done, wrapping up, signing off, 'that's it for today', 'end session', 'let's wrap up', 'save and close', or any signal that the session is ending. Also triggers on 'session summary', 'what did we do', or 'capture this session'. This is the closing ritual — if a session is ending, start here."
---

## Session Context

**Current directory:** !`pwd`

**Git status:** !`git -C $(pwd) status --short 2>/dev/null || echo "Not a git repo"`

**Recent commits (last 8 hours):** !`git -C $(pwd) log --oneline --since="8 hours ago" 2>/dev/null || echo "No commits in last 8 hours"`

**Current branch:** !`git -C $(pwd) branch --show-current 2>/dev/null || echo "No git repo"`

**Uncommitted changes:** !`git -C $(pwd) diff --stat 2>/dev/null || echo "No git repo or no changes"`

# Session End

A closing ritual that turns each session into institutional memory via Zengram. The goal is three things: (1) make sure nothing important gets lost between sessions, (2) build an honest record of what's working and what isn't, and (3) evolve our tools — capturing repeatable workflows as skills and mistakes/corrections as CLAUDE.md rules.

---

## Step 1 — Gather Session Artifacts

Run these to understand what actually happened:

```bash
git -C $(pwd) log --oneline --since="8 hours ago" 2>/dev/null || true
git -C $(pwd) diff HEAD~1 --stat 2>/dev/null || true
git -C $(pwd) status 2>/dev/null || true
```

Also review the conversation history in your context — what was asked, what tools were used, what succeeded, what had to be retried.

---

## Step 2 — Reflect Honestly

Before storing anything, think through the session critically. Don't just summarize — evaluate.

**What went well?**
- Problems solved cleanly on the first try
- Tools used effectively
- Good decisions made quickly
- User got what they needed without friction

**What went wrong or poorly?**
- Wrong approaches tried before finding the right one
- Misunderstandings that needed correction
- Repeated tool calls, retries, or backtracking
- Things that took longer than they should have
- User had to correct me or redirect me

**How could this session have gone better?**
- What would I do differently if I started over?
- Are there patterns worth changing (how I approach certain tasks, which tools I reach for first, how I ask clarifying questions)?
- Any workflow or tooling improvements that would help future sessions?

Be specific. "Everything went fine" is not a useful reflection. If something was suboptimal, name it.

---

## Step 3 — Store to Zengram

Call `brain_store` with a structured session summary. Use this format:

```
topic: session-reflection/{project-name}/{YYYY-MM-DD}

content:
## Session: {project} — {date}

### What was accomplished
- {bullet list of concrete outcomes}

### What went well
- {specific things that worked}

### What went wrong
- {honest account of friction, errors, wrong turns}

### How to improve
- {actionable changes for future sessions}

### Cross-agent relevant
- {anything other agents should know}
- (omit section if nothing applies)
```

**Parameters:**
- `type`: `event` — session reflections are immutable history
- `source_agent`: your agent identifier
- `importance`: `medium` (or `high` if major decisions or discoveries were made)
- `category`: `episodic`

---

## Step 4 — Update Local Memory

Check if the session revealed anything worth persisting in the project's `memory/` directory:

- New user preferences or feedback → update `feedback_*.md`
- New project facts → update or create `project_*.md`
- New information about the user → update `user_*.md`
- New external resource pointers → update `reference_*.md`

Update `MEMORY.md` index if any files were added or changed.

Only update memory if there's something genuinely new. Don't re-save things already captured.

---

## Step 5 — Detect Workflow Patterns (Workflow Spotter)

After reflecting, evaluate whether this session produced work worth capturing as a repeatable skill.

**Check these triggers — if 3+ are true, suggest skill creation:**

- [ ] More than simple Q&A — real multi-step work happened
- [ ] 3+ distinct phases (research → build → verify, or similar arc)
- [ ] Reusable artifacts created (templates, configs, workflows, components)
- [ ] The user would likely do something similar again
- [ ] 50%+ of the work could be systematized
- [ ] You figured things out that future sessions shouldn't have to rediscover
- [ ] 10+ back-and-forth exchanges on a single project
- [ ] 5+ tool calls in service of one outcome
- [ ] 3+ file outputs created

**If 3+ triggers hit, suggest it:**

```
---
Workflow Pattern Detected

This session completed a [WORKFLOW TYPE] workflow:
[PHASE 1] → [PHASE 2] → [PHASE 3] → [PHASE 4]

This looks repeatable. Want me to capture it as a skill?

Suggested skill: [skill-name]
Would include: [key components]
Triggers: "[phrase 1]", "[phrase 2]", "[phrase 3]"

I can build it now or save for later.
---
```

**If fewer than 3 triggers hit**, skip silently — don't mention it.

**Don't suggest skills for:** one-off research, highly variable creative work, processes still being figured out (revisit after the 3rd time you do it), or things that already have a skill.

---

## Step 5b — Detect Rule Patterns (Rule Spotter)

Evaluate whether this session revealed mistakes, corrections, or validated approaches worth adding to CLAUDE.md as permanent rules. CLAUDE.md is loaded into every session automatically — rules here are enforced without needing to query memory or brain.

**Check these triggers — if 2+ are true, propose a CLAUDE.md update:**

- [ ] The user corrected my approach ("no, don't do X", "always do Y instead")
- [ ] A bug was caused by a pattern that should be avoided going forward
- [ ] I had to retry something 3+ times before finding the right approach
- [ ] A tool/infra quirk was discovered that future sessions need to know
- [ ] The same mistake has appeared in memory files or brain entries before (recurring)
- [ ] A workflow step was missing that caused rework or wasted time
- [ ] Something worked exceptionally well and should be standard practice
- [ ] A positive approach was validated by the user (explicit or implicit approval)

**If 2+ triggers hit, propose it:**

```
---
Rule Pattern Detected

This session revealed: [WHAT HAPPENED]
Root cause: [WHY IT HAPPENED]
Prevention: [THE RULE]

Proposed CLAUDE.md addition:
Section: [Critical Rules / Demo Pipeline / Visual Verification / etc.]
Rule: "[The concise rule to add]"

Should I add this to CLAUDE.md now?
---
```

**Important distinctions:**
- Mistakes/corrections/infra quirks → CLAUDE.md rules (enforced every session)
- Repeatable multi-step workflows → Skills (invoked on demand)
- One-off project context → Zengram (queried on demand via brain_search)
- User preferences → Memory files (loaded per-project)

**Also check:** Review existing memory files (`feedback_*.md`) for patterns that have been saved 2+ times. If so, they've graduated from "preference" to "rule" — propose promoting them to CLAUDE.md.

**Capture positive patterns too:** If something worked great this session (a tool choice, an approach, a workflow), and it's not obvious or currently documented, propose adding it. The goal isn't just avoiding negatives — it's reinforcing what works.

**If fewer than 2 triggers hit**, skip silently.

---

## Step 6 — Quality Checklist

Before delivering the summary, verify:

- [ ] Session reflection is specific (no "everything went fine" — name concrete outcomes)
- [ ] "What went wrong" section is honest (if nothing went wrong, explain why — was it simple, or are you not looking hard enough?)
- [ ] brain_store was called with properly structured content
- [ ] Cross-agent section included only if genuinely relevant (don't force it)
- [ ] Local memory updated only with genuinely new information (no re-saving known facts)
- [ ] MEMORY.md index updated if substantive work happened
- [ ] Workflow Spotter evaluation was done (even if result was "no pattern detected")
- [ ] Rule Spotter evaluation was done (even if result was "no rule needed")
- [ ] If CLAUDE.md update was proposed and approved, the edit was actually made

If any check fails, fix it before proceeding to the summary.

---

## Step 7 — Output Summary

End with a short plaintext summary to the user:

```
Session wrapped up.

Stored to Zengram: session-reflection/{project}/{date}

Accomplished: {1-2 sentence summary}
Went well: {1-2 things}
Could improve: {1-2 things}
Memory updated: {yes/no — what changed}
Workflow pattern: {yes — suggested [skill-name] / no}
Rule pattern: {yes — proposed CLAUDE.md update for [topic] / no}
```

Keep it brief. The user is signing off — they don't need a wall of text.

---

## Reference: What a Great Session Reflection Looks Like

Use this as the bar for quality. This is a real example of what a properly done session-end should produce:

```
topic: session-reflection/shared-brain/2026-03-20

content:
## Session: shared-brain — 2026-03-20

### What was accomplished
- Shipped Shared Brain v2.0.0: client knowledge base, import/export, webhook notifications, entity relationship graph
- Added 4 new MCP tools (brain_client, brain_export, brain_import, brain_graph)
- Built D3.js interactive entity visualization
- 34 files changed, 4,619 lines added

### What went well
- Architecture decisions from v1.5 carried forward cleanly — access-weighted search, consolidated facts pattern
- Entity extraction backfill worked on first try (303 entities from 247 memories)
- Client fingerprint matching solved the "which client is this about" problem elegantly

### What went wrong
- Spent 40 minutes debugging Qdrant filter syntax for the new knowledge_category field — should have checked Qdrant docs first instead of guessing
- First attempt at brain_graph returned circular references because co-occurrence tracking didn't exclude self-references
- Forgot to update the MCP server tool count in the npm package description (still says 6, should be 11)

### How to improve
- Before adding new Qdrant filter fields, always check the Qdrant payload indexing docs first
- When adding new tools to MCP server, add a checklist item to update package.json description
- Graph queries need cycle detection — add to standard testing checklist

### Cross-agent relevant
- brain_client tool now available — Neo and n8n can get full client briefings in one call
- Entity graph API at GET /memory/graph — useful for any agent that needs relationship context
- Webhook notifications now fire on store/supersede/delete — n8n workflows can react in real-time
```

**Why this is good:** Specific outcomes with numbers. Honest about wrong turns (40 minutes on Qdrant filters). Improvement items are actionable and future-facing. Cross-agent section only includes things other agents genuinely need.
