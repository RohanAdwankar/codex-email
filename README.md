# codex-gmail-bridge

Turns a Gmail inbox into Codex threads on your own machine.

## Setup

1. Install dependencies:
   `pnpm install`
2. Create a Google Cloud OAuth desktop client with the Gmail API enabled.
3. Save the client JSON to:
   `~/.config/codex-gmail-bridge/google-oauth-client.json`
4. Bootstrap Gmail auth:
   `pnpm auth`
5. Run the worker:
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
