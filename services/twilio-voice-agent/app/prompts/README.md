# Live system prompt (single source of truth)

Production voice calls use **one** system prompt file:

```
app/data/agent_master_system_prompt.md
```

Loaded by `app/agent_runtime/master_prompt.py` and injected by
`app/agent_runtime/llm_tool_runtime.py` on every OpenAI request.

## Editing safely

1. Edit only `agent_master_system_prompt.md` for live behavior changes.
2. Keep `##` section headings intact — the loader maps them to canonical keys
   (`persona`, `tool_rules`, `payment_rules`, etc.).
3. Privacy, payment, and tool-safety sections are **never dropped** when the
   prompt is trimmed for token budget.
4. Run before deploy:
   ```bash
   python -m app.scripts.runtime_identity_check
   python scripts/check_agent_runtime.py
   ```
5. Confirm startup logs include `master_prompt_diag` with expected `hash` and
   `chars` (see `runtime_identity.py` — minimum ~12k chars on release branches).

## Archived prompt systems

Older prompt sources were moved to:

```
archive_legacy/2026_06_26_architecture_cleanup/data/
  prompt_pack/          # six-file Eric pack (v4.15)
  eric_system_prompt.md # legacy single file
```

They are **not** loaded in the live call path.

## Version / hash checks

- Label: `PROMPT_VERSION_LABEL` in `master_prompt.py` (e.g. `v4.20-elevenlabs-aligned`)
- Startup: `prompt_startup_diagnostic()` logs `version`, `hash`, `chars`, `sections`
- Deploy gate: `validate_runtime_identity()` fails if master prompt is too small or
  checkout tool is exposed to the LLM
