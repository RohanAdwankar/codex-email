# codex-gmail-bridge

## Commands

- `pnpm auth`: save the Gmail OAuth client and token.
- `pnpm daemon`: run the email worker.
- `pnpm dev-daemon`: run the email worker with hot reload on code changes.
- `pnpm run-once`: process unread mail one time.
- `pnpm self-test`: send a self-test thread and verify the reply path.
- `pnpm list-emails -- '<gmail search query>'`: list matching emails with ids and thread ids.
- `pnpm read-email -- <gmail-message-id>`: dump a message and its MIME parts.
- Blocked Gmail attachment extensions are automatically renamed to safe `.txt` attachments before send.
