# Privacy

HandEye runs entirely on this machine. It has no server, no telemetry endpoint and no account.

## What is stored

Everything lives under `%LOCALAPPDATA%\dsh-handeye-plus` (override with `DSH_HANDEYE_DATA_DIR`):

| Path | Content |
|---|---|
| `episodes/` | One JSONL file per run: which tool ran, arguments summary, result summary, timings |
| `goals/` | Goals, steps, budgets, acceptance results |
| `cards/`, `skills/`, `capabilities/`, `suggestions/` | Procedures you wrote or that were compiled from runs |
| `overrides.jsonl`, `override.json` | Human approvals ("allow once"), with reason |
| `grant-once.json` | One-shot grant for a destructive action (deleted when used) |

Screenshots taken by `eye_shot` / `eye_region` are written wherever the tool call asked for them;
nothing copies them anywhere else.

## What leaves this machine

Nothing, unless you explicitly send it:

- The DSH/LLM conversation itself (that is your model provider's business, not this plugin's).
- A bundle you export yourself with `node bin/he-server.js export <file>`.
- A `SKILL.md` you export yourself.

The plugin never uploads screenshots, OCR text, logs or the data directory.

## Retention

- Logs and episodes stay until you delete them.
- `override.json` and `grant-once.json` are consumed on use; `grant-once.json` is removed after it fires.

## Delete your data

```powershell
# stop DSH first, then
Remove-Item "$env:LOCALAPPDATA\dsh-handeye-plus" -Recurse -Force
```

To keep a copy before deleting, export first:

```powershell
node bin/he-server.js export D:\handeye-backup.json --include-logs
```

## Redaction

Tool results and log lines pass through `src/memory/redact.js`, which masks obvious secrets
(tokens, passwords, keys) before they are written to episodes. This is best-effort, not a guarantee:
review exported bundles before sharing them.
