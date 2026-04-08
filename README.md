# codex-gmail-bridge

Turns a Gmail inbox into Codex threads on your own machine.

## Setup

1. Install dependencies:
   `pnpm install`
2. Bootstrap Gmail auth:
   `pnpm auth`
   The command walks you through the Google OAuth setup.
   If Google says the app is still in testing, add your Gmail as a test user in Google Auth Platform > Audience.
3. Run the worker:
   `pnpm daemon`

## Behavior

- A new inbound email starts a new Codex thread.
- A reply in the same Gmail thread resumes the same Codex thread.
- When Codex finishes, the bridge replies by email.

## Commands

- `pnpm auth`
- `pnpm run-once`
- `pnpm daemon`

## Environment

- `CODEX_EMAIL_ADDRESS`
- `CODEX_EMAIL_WORKDIR`
- `CODEX_EMAIL_MODEL`
- `CODEX_EMAIL_POLL_MS`
