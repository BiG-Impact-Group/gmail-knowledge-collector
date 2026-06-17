---
name: codex-plan-review
description: >
  Independent plan review via OpenAI Codex CLI. Sends the current epic plan + decomposition
  to Codex for blind-spot analysis, architectural critique, and improvement suggestions.
  Uses a non-Claude model to reduce confirmation bias. Invoke after decomposition is complete,
  before implementation begins. Triggers: "codex plan review", "independent plan review",
  "review plan with codex", /codex-plan-review.
---

# Codex Plan Review

You are orchestrating an independent plan review using OpenAI Codex CLI. The goal is to get a second opinion from a non-Claude model to catch blind spots, missing edge cases, and architectural issues that Claude may have overlooked during planning.

## When to Run

- After the Decomposition step is complete (plan exists with work units defined)
- Before Plan Finalization
- When the user invokes `/codex-plan-review`

## Step 1 — Locate the plan

Find the plan file:
```bash
ls -t docs/superpowers/plans/*.md | head -5
```

Ask the user to confirm which plan to review if multiple exist. Read the plan file in full.

## Step 2 — Gather supporting context

Read these files to build context for the review prompt:
- The plan file itself
- `CLAUDE.md` (architecture, conventions, constraints)
- Any memory docs referenced in the plan (`docs/superpowers/memory/*.md`)

## Step 3 — Prepare the review prompt

Write the review prompt to a temporary file:

```bash
cat > /tmp/codex-plan-review-prompt.md << 'PROMPT_EOF'
You are an adversarial plan reviewer for a software project. Your job is to find
problems, gaps, and risks that the planning team may have missed. Be specific and
constructive — vague concerns are useless.

## Project context

This is a Gmail Knowledge Collector: React 18 + TypeScript + Vite frontend, Supabase
backend (PostgreSQL + RLS + Edge Functions). It collects Gmail via OAuth 2.0 and stores
email for public sector knowledge capture. Per-user row isolation (not multi-tenant
org isolation) via RLS. SCSS design tokens, no Tailwind. Edge Functions handle OAuth
token exchange and scheduled email collection. The browser is read-only on collected mail.

Key constraints:
- RLS on all tables; policies scoped TO authenticated with (select auth.uid())
- OAuth refresh tokens stored server-side only (Supabase Vault or service-role-only table)
- Tokens NEVER returned to browser, never logged, never committed to git
- Browser has no INSERT/UPDATE/DELETE on messages — only edge functions write via service role
- Collected email is PII — never sent to third-party services or external models
- Secrets never enter git (.env excluded; use Supabase Vault for edge function secrets)
- All migrations idempotent (IF NOT EXISTS / IF EXISTS everywhere)
- Paired type generation committed alongside every migration

## Your review criteria

Evaluate the plan against these dimensions:

1. **Completeness** — Are there missing work units? Gaps between what the plan promises and what the units deliver?
2. **Dependency ordering** — Are the units in the right build order? Would any unit fail because a prerequisite isn't ready?
3. **Test coverage** — Are the defined tests sufficient? Missing edge cases? Missing negative tests?
4. **Security / token safety** — Tokens server-side only? No path that could leak refresh/access tokens to the browser? RLS gaps? Auth gaps?
5. **Database design** — Schema issues? Missing indexes? Non-idempotent migrations? Missing type generation step?
6. **Integration risk** — Which parts are most likely to break existing functionality? What's the riskiest unit?
7. **Performance** — Any N+1 queries? Unbounded fetches? Missing pagination? Heavy client-side computation?
8. **Rollback strategy** — If this fails in production, how do we back it out? Is that addressed?
9. **Safety rules compliance** — Does the plan explicitly address all five mandatory safety rules (token isolation, read-only browser, PII containment, secrets out of git, untrusted content note)?

## Output format

For each finding, provide:
- **Category**: (completeness | ordering | testing | security | database | integration | performance | rollback | safety)
- **Severity**: (critical | important | suggestion)
- **Finding**: What's wrong or missing (be specific — name files, tables, work units)
- **Recommendation**: What to do about it

End with a summary: overall plan quality (1-10), top 3 risks, and whether the plan is ready for implementation or needs revision.

---

PROMPT_EOF
```

## Step 4 — Append the plan content

```bash
echo "## Plan under review" >> /tmp/codex-plan-review-prompt.md
echo "" >> /tmp/codex-plan-review-prompt.md
cat "<plan-file-path>" >> /tmp/codex-plan-review-prompt.md
```

## Step 5 — Append CLAUDE.md for architecture context

```bash
echo "" >> /tmp/codex-plan-review-prompt.md
echo "## Project architecture (CLAUDE.md)" >> /tmp/codex-plan-review-prompt.md
echo "" >> /tmp/codex-plan-review-prompt.md
cat CLAUDE.md >> /tmp/codex-plan-review-prompt.md
```

## Step 6 — Run Codex

Execute the review non-interactively using `codex exec`. The `-s read-only` sandbox means Codex
can read files but cannot execute shell commands or edit code — it audits only, never modifies.

```bash
cd <project-root>
codex exec -m o3 -s read-only \
  "Perform an adversarial plan review using the criteria and context in the stdin block. Be specific — cite exact work units, tables, and files." \
  -o /tmp/codex-plan-review-output.md \
  < /tmp/codex-plan-review-prompt.md
echo "Exit code: $?"
```

If the `-o` flag is unavailable, fall back to piping output:
```bash
cat /tmp/codex-plan-review-prompt.md | codex exec -m o3 -s read-only - 2>&1 | tee /tmp/codex-plan-review-output.md
```

If Codex rejects the model name, try `o4-mini` or `gpt-4o` and record the working model in
`docs/dev-rules-local-overrides.md`.

## Step 7 — Present findings

Read the output:
```bash
cat /tmp/codex-plan-review-output.md
```

Present the findings to the user in a structured summary:
1. Overall plan score from Codex
2. Critical findings (if any)
3. Important findings
4. Suggestions
5. Your (Claude's) assessment of each finding — agree, partially agree, or disagree with reasoning

## Step 8 — Save review output

Copy the review output into the plan directory for traceability:
```bash
cp /tmp/codex-plan-review-output.md docs/superpowers/plans/YYYY-MM-DD-<slug>-codex-review.md
```

Do NOT commit — plan artifacts are working files that will be committed with the implementation PR.

## What NOT to do

- Do NOT implement any changes — this is review only
- Do NOT auto-accept Codex findings — present them for human decision
- Do NOT skip the review because the plan "looks good" — the whole point is independent verification
- Do NOT use Claude models for this — the value is in using a different model's perspective

## After Review

Tell the user: "Codex review is complete. Use the **Plan Finalization** template (`docs/superpowers/templates/plan-finalization.md`) to triage these findings and update the plan."

**Print the inputs for the next step on the screen** for the human to easily copy/paste into the next template:
- **Plan path:** (use actual path)
- **Codex review output path:** `docs/superpowers/plans/YYYY-MM-DD-<slug>-codex-review.md` (use actual path)
- **Feature branch:** (use actual branch name)
- **Epic name:** (use actual epic name)
- **GitHub epic issue:** #<number> (use actual issue number)
