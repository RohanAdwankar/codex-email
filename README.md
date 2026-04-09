# codex-gmail-bridge

## Commands

CODEX_EMAIL_ADDRESS='your-codex@gmail.com' \
CODEX_EMAIL_ALLOWED_SENDERS='alice@gmail.com,bob@example.com' \
CODEX_EMAIL_WORKDIR="$HOME"\
CODEX_EMAIL_POLL_MS='30000' \
CODEX_EMAIL_SANDBOX_MODE='danger-full-access' \
CODEX_EMAIL_APPROVAL_POLICY='never' \
pnpm daemon

- `pnpm auth`: save the Gmail OAuth client and token.
- `pnpm daemon`: run the email worker.
- `pnpm dev-daemon`: run the email worker with hot reload on code changes.
- `pnpm run-once`: process unread mail one time.
- `pnpm self-test`: send a self-test thread and verify the reply path.
- `pnpm list-emails -- '<gmail search query>'`: list matching emails with ids and thread ids.
- `pnpm read-email -- <gmail-message-id>`: dump a message and its MIME parts.
