import fs from "node:fs/promises";
import http from "node:http";
import path from "node:path";
import os from "node:os";
import process from "node:process";
import readline from "node:readline/promises";
import { stdin as input, stdout as output } from "node:process";

import { google, gmail_v1 } from "googleapis";
import { OAuth2Client } from "google-auth-library";
import { Codex } from "@openai/codex-sdk";

type GmailThreadState = {
  codexThreadId: string;
  lastProcessedMessageId: string;
  subject?: string;
  updatedAt: string;
};

type BridgeState = {
  gmailThreads: Record<string, GmailThreadState>;
};

type OAuthClientConfig = {
  installed?: {
    client_id: string;
    client_secret: string;
    redirect_uris: string[];
  };
  web?: {
    client_id: string;
    client_secret: string;
    redirect_uris: string[];
  };
};

const SCOPES = [
  "https://www.googleapis.com/auth/gmail.modify",
  "https://www.googleapis.com/auth/gmail.send",
];

const APP_DIR = path.join(os.homedir(), ".config", "codex-gmail-bridge");
const DEFAULT_CLIENT_PATH = path.join(APP_DIR, "google-oauth-client.json");
const DEFAULT_TOKEN_PATH = path.join(APP_DIR, "google-oauth-token.json");
const DEFAULT_STATE_PATH = path.join(APP_DIR, "state.json");
const DEFAULT_EMAIL_ADDRESS = "rohanchromebook@gmail.com";
const DEFAULT_POLL_MS = 30_000;
const GMAIL_QUICKSTART_URL = "https://developers.google.com/workspace/gmail/api/quickstart/nodejs";
const GMAIL_API_ENABLE_URL = "https://console.cloud.google.com/apis/library/gmail.googleapis.com";
const GOOGLE_AUTH_BRANDING_URL = "https://console.cloud.google.com/auth/branding";
const GOOGLE_AUTH_CLIENTS_URL = "https://console.cloud.google.com/auth/clients";

async function main(): Promise<void> {
  const command = process.argv[2];
  if (!command || !["auth", "run-once", "daemon"].includes(command)) {
    throw new Error("usage: tsx src/index.ts <auth|run-once|daemon>");
  }

  if (command === "auth") {
    await authorizeInteractive();
    return;
  }

  const ctx = await createContext();
  if (command === "run-once") {
    await processUnreadMessages(ctx);
    return;
  }

  for (;;) {
    await processUnreadMessages(ctx);
    await sleep(ctx.pollMs);
  }
}

type Context = {
  gmail: gmail_v1.Gmail;
  statePath: string;
  pollMs: number;
  emailAddress: string;
  codex: Codex;
  workdir: string;
  model?: string;
};

async function createContext(): Promise<Context> {
  const auth = await loadAuthorizedClient();
  const gmail = google.gmail({ version: "v1", auth });
  const emailAddress = process.env.CODEX_EMAIL_ADDRESS || DEFAULT_EMAIL_ADDRESS;
  const workdir = process.env.CODEX_EMAIL_WORKDIR || os.homedir();
  const pollMs = Number(process.env.CODEX_EMAIL_POLL_MS || DEFAULT_POLL_MS);
  const model = process.env.CODEX_EMAIL_MODEL;
  const codex = new Codex();

  await fs.mkdir(APP_DIR, { recursive: true });

  return {
    gmail,
    statePath: DEFAULT_STATE_PATH,
    pollMs,
    emailAddress,
    codex,
    workdir,
    model,
  };
}

async function processUnreadMessages(ctx: Context): Promise<void> {
  const state = await loadState(ctx.statePath);
  const list = await ctx.gmail.users.messages.list({
    userId: "me",
    q: `is:unread in:inbox to:${ctx.emailAddress} -from:me`,
    maxResults: 25,
  });

  const messages = list.data.messages ?? [];
  const detailed = await Promise.all(
    messages.map((message) =>
      ctx.gmail.users.messages.get({
        userId: "me",
        id: message.id!,
        format: "full",
      }),
    ),
  );

  detailed.sort((a, b) => {
    const left = Number(a.data.internalDate || 0);
    const right = Number(b.data.internalDate || 0);
    return left - right;
  });

  for (const response of detailed) {
    const message = response.data;
    const messageId = message.id;
    const gmailThreadId = message.threadId;
    if (!messageId || !gmailThreadId) {
      continue;
    }

    const existing = state.gmailThreads[gmailThreadId];
    if (existing?.lastProcessedMessageId === messageId) {
      continue;
    }

    const parsed = parseIncomingMessage(message);
    if (!parsed.body.trim()) {
      await markRead(ctx.gmail, messageId);
      continue;
    }

    const thread = existing?.codexThreadId
      ? ctx.codex.resumeThread(existing.codexThreadId, codexThreadOptions(ctx))
      : ctx.codex.startThread(codexThreadOptions(ctx));

    const prompt = existing
      ? parsed.body
      : `You are replying by email. Keep the response concise and plain text unless formatting is clearly useful.\n\n${parsed.body}`;

    let resultText: string;
    try {
      const result = await thread.run(prompt);
      resultText = result.finalResponse.trim() || "(No response text returned.)";
    } catch (error) {
      const messageText = error instanceof Error ? error.message : String(error);
      resultText = `Codex run failed:\n\n${messageText}`;
    }

    await sendReply(ctx.gmail, {
      to: parsed.from,
      from: ctx.emailAddress,
      subject: replySubject(parsed.subject),
      body: resultText,
      threadId: gmailThreadId,
      inReplyTo: parsed.messageHeaderId,
      references: parsed.references,
    });

    if (!thread.id) {
      throw new Error(`Codex thread id missing after processing Gmail thread ${gmailThreadId}`);
    }

    state.gmailThreads[gmailThreadId] = {
      codexThreadId: thread.id,
      lastProcessedMessageId: messageId,
      subject: parsed.subject,
      updatedAt: new Date().toISOString(),
    };
    await saveState(ctx.statePath, state);
    await markRead(ctx.gmail, messageId);
  }
}

function codexThreadOptions(ctx: Context) {
  return {
    model: ctx.model,
    workingDirectory: ctx.workdir,
    skipGitRepoCheck: true,
    sandboxMode: "danger-full-access" as const,
    approvalPolicy: "never" as const,
  };
}

async function authorizeInteractive(): Promise<void> {
  await fs.mkdir(APP_DIR, { recursive: true });
  const { oauthClient, redirectUri } = await buildOAuthClientFromDisk();
  const url = oauthClient.generateAuthUrl({
    access_type: "offline",
    prompt: "consent",
    scope: SCOPES,
  });

  console.log("Open this URL in a browser:");
  console.log(url);

  const code =
    redirectUri.startsWith("http://127.0.0.1") || redirectUri.startsWith("http://localhost")
      ? await waitForOAuthCode(redirectUri)
      : await promptForOAuthCode();

  const { tokens } = await oauthClient.getToken(code);
  oauthClient.setCredentials(tokens);
  await fs.writeFile(DEFAULT_TOKEN_PATH, JSON.stringify(tokens, null, 2) + "\n", "utf8");
  console.log(`Saved token to ${DEFAULT_TOKEN_PATH}`);
}

async function loadAuthorizedClient(): Promise<OAuth2Client> {
  const { oauthClient } = await buildOAuthClientFromDisk();
  const token = JSON.parse(await fs.readFile(DEFAULT_TOKEN_PATH, "utf8")) as Record<string, unknown>;
  oauthClient.setCredentials(token);
  return oauthClient;
}

async function buildOAuthClientFromDisk(): Promise<{ oauthClient: OAuth2Client; redirectUri: string }> {
  const raw = JSON.parse(await fs.readFile(DEFAULT_CLIENT_PATH, "utf8")) as OAuthClientConfig;
  const cfg = raw.installed ?? raw.web;
  if (!cfg) {
    throw new Error(`OAuth client JSON at ${DEFAULT_CLIENT_PATH} is missing installed/web credentials`);
  }
  const redirectUri = cfg.redirect_uris[0];
  return {
    oauthClient: new google.auth.OAuth2(cfg.client_id, cfg.client_secret, redirectUri),
    redirectUri,
  };
}

async function promptForOAuthCode(): Promise<string> {
  const rl = readline.createInterface({ input, output });
  const code = (await rl.question("Code: ")).trim();
  rl.close();
  return code;
}

async function waitForOAuthCode(redirectUri: string): Promise<string> {
  const url = new URL(redirectUri);
  const port = Number(url.port || "80");
  const hostname = url.hostname;
  const pathname = url.pathname;

  console.log(`Waiting for OAuth callback on ${redirectUri}`);

  return await new Promise<string>((resolve, reject) => {
    const server = http.createServer((req, res) => {
      try {
        if (!req.url) {
          throw new Error("OAuth callback missing URL");
        }
        const requestUrl = new URL(req.url, redirectUri);
        if (requestUrl.pathname !== pathname) {
          res.statusCode = 404;
          res.end("Not found");
          return;
        }
        const code = requestUrl.searchParams.get("code");
        const error = requestUrl.searchParams.get("error");
        if (error) {
          res.statusCode = 400;
          res.end(`OAuth error: ${error}`);
          server.close();
          reject(new Error(`OAuth error: ${error}`));
          return;
        }
        if (!code) {
          res.statusCode = 400;
          res.end("Missing code");
          return;
        }
        res.end("Authorization received. You can return to the terminal.");
        server.close();
        resolve(code);
      } catch (error) {
        server.close();
        reject(error);
      }
    });

    server.once("error", reject);
    server.listen(port, hostname);
  });
}

async function loadState(statePath: string): Promise<BridgeState> {
  try {
    return JSON.parse(await fs.readFile(statePath, "utf8")) as BridgeState;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      return { gmailThreads: {} };
    }
    throw error;
  }
}

async function saveState(statePath: string, state: BridgeState): Promise<void> {
  await fs.writeFile(statePath, JSON.stringify(state, null, 2) + "\n", "utf8");
}

function parseIncomingMessage(message: gmail_v1.Schema$Message) {
  const payload = message.payload;
  const headers = payload?.headers ?? [];
  const subject = getHeader(headers, "Subject") || "(no subject)";
  const from = extractEmailAddress(getHeader(headers, "From") || "");
  const messageHeaderId = getHeader(headers, "Message-Id") || "";
  const references = getHeader(headers, "References") || messageHeaderId;
  const body = extractPlainTextBody(payload).trim();
  return { subject, from, body, messageHeaderId, references };
}

function extractPlainTextBody(payload: gmail_v1.Schema$MessagePart | undefined): string {
  if (!payload) {
    return "";
  }

  if (payload.mimeType === "text/plain" && payload.body?.data) {
    return decodeBase64Url(payload.body.data);
  }

  for (const part of payload.parts ?? []) {
    const text = extractPlainTextBody(part);
    if (text) {
      return text;
    }
  }

  if (payload.body?.data) {
    return decodeBase64Url(payload.body.data);
  }

  return "";
}

function decodeBase64Url(value: string): string {
  const normalized = value.replace(/-/g, "+").replace(/_/g, "/");
  return Buffer.from(normalized, "base64").toString("utf8");
}

function getHeader(headers: gmail_v1.Schema$MessagePartHeader[], name: string): string | null {
  const match = headers.find((header) => header.name?.toLowerCase() === name.toLowerCase());
  return match?.value ?? null;
}

function extractEmailAddress(value: string): string {
  const match = value.match(/<([^>]+)>/);
  return match?.[1] ?? value.trim();
}

function replySubject(subject: string): string {
  return /^re:/i.test(subject) ? subject : `Re: ${subject}`;
}

async function sendReply(
  gmail: gmail_v1.Gmail,
  args: {
    to: string;
    from: string;
    subject: string;
    body: string;
    threadId: string;
    inReplyTo?: string;
    references?: string;
  },
): Promise<void> {
  const lines = [
    `From: ${args.from}`,
    `To: ${args.to}`,
    `Subject: ${args.subject}`,
    "Content-Type: text/plain; charset=utf-8",
    "MIME-Version: 1.0",
  ];
  if (args.inReplyTo) {
    lines.push(`In-Reply-To: ${args.inReplyTo}`);
  }
  if (args.references) {
    lines.push(`References: ${args.references}`);
  }
  lines.push("", args.body);

  const raw = Buffer.from(lines.join("\r\n"))
    .toString("base64")
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/g, "");

  await gmail.users.messages.send({
    userId: "me",
    requestBody: {
      raw,
      threadId: args.threadId,
    },
  });
}

async function markRead(gmail: gmail_v1.Gmail, messageId: string): Promise<void> {
  await gmail.users.messages.modify({
    userId: "me",
    id: messageId,
    requestBody: {
      removeLabelIds: ["UNREAD"],
    },
  });
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

void main().catch((error) => {
  if (isMissingOauthClientFile(error)) {
    console.error("Missing Gmail OAuth client file.");
    console.error("");
    console.error(`Expected file: ${DEFAULT_CLIENT_PATH}`);
    console.error("");
    console.error("Create a Google Cloud desktop OAuth client for Gmail:");
    console.error(`- Gmail API quickstart: ${GMAIL_QUICKSTART_URL}`);
    console.error(`- Enable Gmail API: ${GMAIL_API_ENABLE_URL}`);
    console.error(`- OAuth consent screen: ${GOOGLE_AUTH_BRANDING_URL}`);
    console.error(`- OAuth clients: ${GOOGLE_AUTH_CLIENTS_URL}`);
    console.error("");
    console.error("After downloading the OAuth client JSON, place it here:");
    console.error(`mkdir -p ${APP_DIR}`);
    console.error(`mv ~/Downloads/<client>.json ${DEFAULT_CLIENT_PATH}`);
    process.exitCode = 1;
    return;
  }
  console.error(error);
  process.exitCode = 1;
});

function isMissingOauthClientFile(error: unknown): error is NodeJS.ErrnoException {
  return (
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    (error as NodeJS.ErrnoException).code === "ENOENT" &&
    "path" in error &&
    (error as NodeJS.ErrnoException).path === DEFAULT_CLIENT_PATH
  );
}
