# Security

HandEye drives a real desktop: it can move the mouse, type, click coordinates, read the screen and
run UIA/CDP actions. Treat it with the same care as a remote-control tool.

## Supported versions

The latest release on `main`. Older tags are kept for reference but not patched.

## Reporting a vulnerability

Do **not** open a public issue for anything that could let a third party take control of the machine or
read local data. Report it privately:

- Open a GitHub security advisory on `dove-pen/dsh-handeye`, or
- Contact the maintainer through the address on the repository profile.

Include: version, what you did, what happened, and the smallest reproduction you can manage.
You should get an acknowledgement within a few days.

## Threat model (what this plugin defends)

| Control | What it stops |
|---|---|
| Gate (`src/core/gate.js`) | Acting while paused, acting outside the bound step, exceeding the action budget, calling a tool outside the allow-list |
| One-shot grants (`grant-once.json`) | A destructive action being approved once and reused — the grant is consumed and deleted |
| Acceptance checks (`src/core/verify.js`) | "I think I did it" — the step only advances when machine-checkable evidence passes |
| Path guard | Acceptance checks pointing at credential directories, system dirs or key files |
| Command guard | Whitelisted command prefix **and** refusal of shell metacharacters (`& | > < ^`) |
| Redaction | Tokens and passwords in tool output before they land in episodes |

## What it does **not** defend

- A malicious model or prompt that gets you to approve a destructive action yourself.
- Another process on the same user account reading `%LOCALAPPDATA%\dsh-handeye-plus`.
- Screenshots you took of sensitive content and left on disk.
- Supply chain of the bundled `bin/handeye.exe` — verify the hash if you care.
