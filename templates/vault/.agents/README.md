# `.agents/`

Vault-local agent assets. Create Vault seeds this tree (no overwrite).

```text
.agents/
└── skills/<id>/SKILL.md   # Composer `$` skills; see skills/README.md
```

Use Skill management in Edda to add or remove vault-local skills. Removal goes
to the recycle bin and is remembered across vault opens; Undo restores your files.
The on-disk format remains `.agents/skills/<id>/SKILL.md` for external tools.
Workspace instructions (`AGENTS.md`) are edited in Settings → Agent with confirmation.
Do not store model API keys here (BYOA).
