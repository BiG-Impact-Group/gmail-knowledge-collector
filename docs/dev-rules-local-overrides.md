# Development Rules — Local Overrides

> Records every change made to the inherited skill set from `todo-sample`. Read alongside `docs/dev-rules.md`. Where this file conflicts, this file wins.

**Seeded from:** `/Users/caleb/todo-sample` (momentum project)  
**Applied:** 2026-06-17  
**Codex CLI version at seed time:** 0.139.0

---

## 1. Base branch: `dev` → `test`

**Skills changed:** `codex-code-review`, `pr-package`, `memory-persist`

The momentum project used a `dev` integration branch. This repo standardizes on `test` as the integration branch (feature PRs target `test`; `main` is the release branch).

**Changes applied:**
- `codex-code-review` Step 1 & 2: `git merge-base dev HEAD` → `git merge-base test HEAD`
- `pr-package` Step 1 & 2: `git merge-base dev HEAD` → `git merge-base test HEAD`
- `pr-package` description and pipeline language: `dev → test → main` → `test → main`
- `memory-persist` Step 1 & 3: `git merge-base dev HEAD` → `git merge-base test HEAD`

No `dev` branch exists or will be created in this repo.

---

## 2. Codex invocation: `codex --quiet` → `codex exec`

**Skills changed:** `codex-plan-review`, `codex-code-review`

The inherited skills used the old interactive invocation:
```bash
codex --model gpt-5.4-high --quiet "..."
```
This requires a real TTY and hangs when run as a subprocess.

**Replacement:** `codex exec` with stdin piping (non-interactive, no TTY required):
```bash
codex exec -m o3 -s read-only \
  "<short instruction>" \
  -o /tmp/output.md \
  < /tmp/prompt.md
```

**Model used:** `o3` (confirmed working via smoke test on 2026-06-17)

**Sandbox:** `-s read-only` — Codex can read files but cannot execute shell commands or edit code. Reviews are audit-only; Claude applies fixes.

**Fallback if `-o` is unavailable:**
```bash
cat /tmp/prompt.md | codex exec -m o3 -s read-only - 2>&1 | tee /tmp/output.md
```

If `o3` is rejected at runtime, try `o4-mini` or `gpt-4o` and update this file with the working model.

---

## 3. Codex review context: momentum → this project

**Skills changed:** `codex-plan-review`, `codex-code-review`

The inherited prompt templates referenced momentum-specific context: insurance SaaS platform, multi-tenant architecture, `llmService`, `variable_registry`, Scandinavian Minimalism design system, and `tenant_id` filtering.

**Replacement context in both prompts:**
- Gmail Knowledge Collector: React 18 + TypeScript + Vite + Supabase (PostgreSQL + RLS + Edge Functions)
- Per-user row isolation (not multi-tenant org isolation) via RLS
- SCSS design tokens, no Tailwind
- Edge Functions: OAuth token exchange, scheduled email collection
- Browser read-only on collected mail

**Added to both prompts:** The five mandatory safety rules from `docs/project-brief.md` as explicit `CRITICAL` check items.

**Removed from both prompts:** `variable_registry`, `tenant_id filtering`, `llmService`, `Scandinavian Minimalism`, `insurance SaaS`

---

## 4. Validation-gate Supabase project ref

**Skill changed:** `validation-gate`

The inherited skill hardcoded momentum's Supabase project ref (`mcqiltqjmuunhodmafcj`) in the migration target gate (Step 9.5). This causes an immediate hard failure for any other project.

**Replacement:** Updated to this project's Supabase project ref. See Step 9.5 in the skill file.

Also updated the runbook path from `docs/superpowers/runbooks/migration-deploy-gate.md` (momentum artifact) to inline the error message — this repo does not have a separate runbooks directory.

---

## 5. Version source: `FormStructureTree.tsx` → `package.json`

**Skill changed:** `feature-commit`

The inherited skill read the version from:
```
src/components/product/application-builder/FormStructureTree.tsx (BUILDER_VERSION const)
```
That file is a momentum-specific component that does not exist in this repo.

**Replacement:** Read version from `package.json` `"version"` field, or from `CLAUDE.md` `Current version` line.

---

## 6. Memory path: `momentum/memory/` → `docs/superpowers/memory/`

**Skills changed:** `feature-commit`, `memory-persist`

The inherited skills wrote epic memory docs to `momentum/memory/`, a momentum-specific directory.

**Replacement:** `docs/superpowers/memory/` — committed with the repo, visible in code review, no external wiki dependency.

The `memory-persist` skill also referenced `momentum/memory/rating-engine-feature-documentation.md` and `momentum/memory/auth-login-feature-documentation.md` as format examples. These have been removed. Future sessions use existing docs in `docs/superpowers/memory/` as format references once the first epic completes.

---

## 7. Wiki sync removed from `memory-persist`

**Skill changed:** `memory-persist`

The inherited skill called `/wiki-sync` in Step 8 to propagate docs to an Obsidian wiki. That skill does not exist in this repo and this team does not use Obsidian.

**Replacement:** The committed memory doc in `docs/superpowers/memory/` is the artifact. No external wiki sync. Step 8 (wiki sync) has been removed; the skill now ends at Step 8 (verify).

---

## 8. `design-guardian` removed

**Skill removed:** `.claude/skills/design-guardian/`

The design-guardian skill enforced the SHAPE "Scandinavian Minimalism" design system, referencing a specific Figma file (`og2y5TjaBswiPpgovaiC59`) and SecondSight component paths (`src/design-system/`, `src/components/admin/design-system/`). These assets do not exist in this project.

Its always-on trigger for any UI code would cause it to fire and reference non-existent files on every component we write.

**Replacement for UI quality:** Stylelint gate (SCSS tokens), `react-best-practices` skill, `composition-patterns` skill.

---

## 9. `supabase-mcp` — verify at first use

**Skill:** `.claude/skills/supabase-mcp/` (packaged binary, content opaque)

Copied as-is from todo-sample. At first use, verify that it targets this project's Supabase instance, not a momentum project. If it attempts to connect to a different project, stop and reconfigure before proceeding.

---

## 10. Documentation-only notes (no behavior change)

**`dev-rules.md` contains momentum-specific documentation that is wrong for this project but is not changed (it is the upstream process document):**

- `pwd` expected output: `/c/Users/avigi/Code/momentum-rv` (Windows, wrong user). Our working directory: `/Users/caleb/Documents/Claude Code/gmail-knowledge-collector`
- Dev server port: `http://127.0.0.1:8081`. Our Vite default: `http://localhost:5173`
- Supabase link command in Step 10: `npx supabase link --project-ref iwpckxvgpdmglfrngrkr` — this is momentum's project ref. Use this project's ref (see `validation-gate` Step 9.5).
- `spawn-planner` pre-flight untracked-shared check includes `momentum/memory` path — benign since that directory does not exist here and the check will find nothing.
