import fs from "node:fs/promises";
import http from "node:http";
import path from "node:path";
import os from "node:os";
import process from "node:process";
import { spawn } from "node:child_process";
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

type InlineImage = {
  alt: string;
  cid: string;
  content: Buffer;
  contentType: string;
  filename: string;
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
const DEFAULT_SUBJECT = "Codex Email";
const DEFAULT_ALLOWED_SENDERS = ["rohan.adwankar@gmail.com"];
const DEFAULT_POLL_MS = 30_000;
const GOOGLE_AUTH_CLIENTS_URL = "https://console.cloud.google.com/auth/clients";

async function main(): Promise<void> {
  const command = process.argv[2];
  if (!command || !["auth", "run-once", "daemon", "self-test"].includes(command)) {
    throw new Error("usage: tsx src/index.ts <auth|run-once|daemon|self-test>");
  }

  if (command === "auth") {
    await authorizeInteractive();
    return;
  }

  const ctx = await createContext();
  if (command === "self-test") {
    await runSelfTest(ctx);
    return;
  }

  if (command === "run-once") {
    await processUnreadMessages(ctx);
    return;
  }

  for (;;) {
    await processUnreadMessages(ctx);
    await sleep(ctx.pollMs);
  }
}

type ProcessOptions = {
  includeSelf?: boolean;
  threadId?: string;
};

type Context = {
  gmail: gmail_v1.Gmail;
  statePath: string;
  pollMs: number;
  emailAddress: string;
  allowedSenders: Set<string>;
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
  const allowedSenders = parseAllowedSenders(process.env.CODEX_EMAIL_ALLOWED_SENDERS);
  const codex = new Codex();

  await fs.mkdir(APP_DIR, { recursive: true });

  return {
    gmail,
    statePath: DEFAULT_STATE_PATH,
    pollMs,
    emailAddress,
    allowedSenders,
    codex,
    workdir,
    model,
  };
}

async function processUnreadMessages(ctx: Context, options: ProcessOptions = {}): Promise<void> {
  const state = await loadState(ctx.statePath);
  const list = await ctx.gmail.users.messages.list({
    userId: "me",
    q: buildInboxQuery(ctx, options),
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
    if (!isAllowedSender(ctx, parsed.from, options)) {
      continue;
    }
    if (!parsed.body.trim()) {
      await markRead(ctx.gmail, messageId);
      continue;
    }

    const threadMetadata = await fetchThreadMetadata(ctx.gmail, gmailThreadId);

    const thread = existing?.codexThreadId
      ? ctx.codex.resumeThread(existing.codexThreadId, codexThreadOptions(ctx))
      : ctx.codex.startThread(codexThreadOptions(ctx));

    const prompt = buildEmailPrompt(parsed.body, existing);

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
      subject: replySubject(threadMetadata.subject || parsed.subject),
      body: resultText,
      threadId: gmailThreadId,
      inReplyTo: threadMetadata.lastMessageId || parsed.messageHeaderId,
      references: threadMetadata.references || parsed.references,
      workdir: ctx.workdir,
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

async function runSelfTest(ctx: Context): Promise<void> {
  const subject = `codex-email self-test ${new Date().toISOString()}`;
  const body = "Reply to this email in the same thread with exactly: self-test ok";

  const seed = await sendMessage(ctx.gmail, {
    to: ctx.emailAddress,
    from: ctx.emailAddress,
    subject,
    body,
  });
  const threadId = seed.threadId;
  if (!threadId) {
    throw new Error("Self-test seed email did not return a Gmail thread id.");
  }

  await waitForMessage(ctx.gmail, threadId);
  await processUnreadMessages(ctx, { includeSelf: true, threadId });

  const thread = await ctx.gmail.users.threads.get({
    userId: "me",
    id: threadId,
    format: "full",
  });
  const messages = thread.data.messages ?? [];
  if (messages.length < 2) {
    throw new Error(`Self-test failed: expected at least 2 messages in Gmail thread ${threadId}, got ${messages.length}.`);
  }

  console.log(`Self-test passed for Gmail thread ${threadId}.`);
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
  await ensureOauthClientFileInteractive();
  const { oauthClient, redirectUri } = await buildOAuthClientFromDisk();
  const url = oauthClient.generateAuthUrl({
    access_type: "offline",
    prompt: "consent",
    scope: SCOPES,
  });

  console.log("Open this URL in a browser:");
  console.log(url);

  const code = shouldAutoListenForOAuthCode(redirectUri)
    ? await waitForOAuthCode(redirectUri)
    : await promptForOAuthCode(
        "If Google redirects to a broken localhost page, copy either the `code` value or the full browser URL and paste it here.",
      );

  const { tokens } = await oauthClient.getToken(extractOAuthCode(code));
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

async function ensureOauthClientFileInteractive(): Promise<void> {
  try {
    await fs.access(DEFAULT_CLIENT_PATH);
    return;
  } catch {
    // fall through
  }

  await fs.mkdir(APP_DIR, { recursive: true });
  const rl = readline.createInterface({ input, output });

  console.log("");
  console.log("Google OAuth setup is required once.");
  console.log(`Open: ${GOOGLE_AUTH_CLIENTS_URL}`);
  console.log("Create a project if needed, create a Desktop app OAuth client, and download the JSON.");
  console.log("If Google says the app is in testing, add your Gmail as a test user in Google Auth Platform > Audience.");
  console.log("");
  maybeOpenBrowser(GOOGLE_AUTH_CLIENTS_URL);

  const response = (
    await rl.question("Paste the downloaded JSON here, or type a file path to it: ")
  ).trim();

  if (!response) {
    rl.close();
    throw new Error("No OAuth client JSON or file path was provided.");
  }

  if (response.startsWith("{")) {
    JSON.parse(response);
    await fs.writeFile(DEFAULT_CLIENT_PATH, response + "\n", "utf8");
    console.log(`Saved OAuth client JSON to ${DEFAULT_CLIENT_PATH}`);
    rl.close();
    return;
  }

  rl.close();
  await fs.copyFile(response, DEFAULT_CLIENT_PATH);
  console.log(`Saved OAuth client JSON to ${DEFAULT_CLIENT_PATH}`);
}

async function promptForOAuthCode(message?: string): Promise<string> {
  const rl = readline.createInterface({ input, output });
  if (message) {
    console.log(message);
  }
  const code = (await rl.question("Code or URL: ")).trim();
  rl.close();
  return code;
}

function extractOAuthCode(inputValue: string): string {
  const trimmed = inputValue.trim();
  if (!trimmed) {
    throw new Error("No OAuth code was provided.");
  }

  if (trimmed.startsWith("http://") || trimmed.startsWith("https://")) {
    const url = new URL(trimmed);
    const code = url.searchParams.get("code");
    if (!code) {
      throw new Error("No `code` parameter found in the pasted URL.");
    }
    return code;
  }

  return trimmed;
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

function shouldAutoListenForOAuthCode(redirectUri: string): boolean {
  if (!(redirectUri.startsWith("http://127.0.0.1") || redirectUri.startsWith("http://localhost"))) {
    return false;
  }

  const url = new URL(redirectUri);
  if (!url.port) {
    return false;
  }

  return Number(url.port) >= 1024;
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
  const subject = normalizeSubject(getHeader(headers, "Subject"));
  const from = extractEmailAddress(getHeader(headers, "From") || "");
  const messageHeaderId = normalizeMessageId(getHeader(headers, "Message-Id")) || "";
  const references = buildReferenceChain(
    getHeader(headers, "References"),
    getHeader(headers, "In-Reply-To"),
    messageHeaderId,
  );
  const body = extractPlainTextBody(payload).trim();
  return { subject, from, body, messageHeaderId, references };
}

async function fetchThreadMetadata(
  gmail: gmail_v1.Gmail,
  threadId: string,
): Promise<{ subject: string; lastMessageId: string; references: string }> {
  const thread = await gmail.users.threads.get({
    userId: "me",
    id: threadId,
    format: "full",
  });

  const messages = thread.data.messages ?? [];
  const allMessageIds: string[] = [];
  let subject = "";
  let lastMessageId = "";

  for (const message of messages) {
    const headers = message.payload?.headers ?? [];
    const currentSubject = normalizeSubject(getHeader(headers, "Subject"));
    const currentMessageId = normalizeMessageId(getHeader(headers, "Message-Id"));
    if (!subject && currentSubject) {
      subject = currentSubject;
    }
    if (currentMessageId) {
      allMessageIds.push(currentMessageId);
      lastMessageId = currentMessageId;
    }
  }

  const references = Array.from(new Set(allMessageIds)).join(" ");
  return { subject, lastMessageId, references };
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

function normalizeMessageId(value: string | null | undefined): string | null {
  if (!value) {
    return null;
  }
  const trimmed = value.trim();
  if (!trimmed) {
    return null;
  }
  return trimmed.startsWith("<") ? trimmed : `<${trimmed.replace(/[<>]/g, "")}>`;
}

function extractEmailAddress(value: string): string {
  const match = value.match(/<([^>]+)>/);
  return match?.[1] ?? value.trim();
}

function normalizeSubject(subject: string | null | undefined): string {
  const trimmed = subject?.trim();
  if (!trimmed || trimmed === "(no subject)") {
    return DEFAULT_SUBJECT;
  }
  return trimmed;
}

function replySubject(subject: string): string {
  const normalized = normalizeSubject(subject);
  return /^re:/i.test(normalized) ? normalized : `Re: ${normalized}`;
}

function buildEmailPrompt(body: string, existing: boolean): string {
  const instructions = [
    "You are replying by email.",
    "Use plain text unless markdown formatting is clearly useful.",
    "Markdown headings, lists, links, code blocks, and markdown images are supported by the mail bridge.",
    "If you generate a local raster image file, embed it by including markdown image syntax with the real local file path, for example: ![diagram](/absolute/path/to/file.png).",
    "Do not return raw HTML email bodies, MIME instructions, cid: references, or fenced HTML unless the user explicitly asks for source code.",
    "Do not put image markdown inside code fences.",
    "Prefer PNG, JPG, GIF, or WebP for inline email images. SVG is unreliable in Gmail.",
  ].join(" ");

  if (existing) {
    return `${instructions}\n\n${body}`;
  }

  return `${instructions}\n\n${body}`;
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
    workdir?: string;
  },
): Promise<void> {
  await sendMessage(gmail, args);
}

async function sendMessage(
  gmail: gmail_v1.Gmail,
  args: {
    to: string;
    from: string;
    subject: string;
    body: string;
    threadId?: string;
    inReplyTo?: string;
    references?: string;
    workdir?: string;
  },
): Promise<gmail_v1.Schema$Message> {
  const rendered = await renderEmailBody(args.body, args.workdir);
  const lines = [
    `From: ${args.from}`,
    `To: ${args.to}`,
    `Subject: ${normalizeSubject(args.subject)}`,
    "MIME-Version: 1.0",
  ];
  if (args.inReplyTo) {
    lines.push(`In-Reply-To: ${normalizeMessageId(args.inReplyTo)}`);
  }
  if (args.references) {
    const normalizedRefs = args.references
      .split(/\s+/)
      .map((value) => normalizeMessageId(value))
      .filter((value): value is string => Boolean(value));
    lines.push(`References: ${normalizedRefs.join(" ")}`);
  }
  if (!rendered.html) {
    lines.push("Content-Type: text/plain; charset=utf-8", "", rendered.text);
  } else {
    const relatedBoundary = createBoundary("related");
    const alternativeBoundary = createBoundary("alt");
    lines.push(`Content-Type: multipart/related; boundary="${relatedBoundary}"`, "");
    lines.push(`--${relatedBoundary}`);
    lines.push(`Content-Type: multipart/alternative; boundary="${alternativeBoundary}"`, "");
    lines.push(`--${alternativeBoundary}`);
    lines.push("Content-Type: text/plain; charset=utf-8");
    lines.push("Content-Transfer-Encoding: base64", "");
    lines.push(...encodeMimeBase64(rendered.text), "");
    lines.push(`--${alternativeBoundary}`);
    lines.push("Content-Type: text/html; charset=utf-8");
    lines.push("Content-Transfer-Encoding: base64", "");
    lines.push(...encodeMimeBase64(rendered.html), "");
    lines.push(`--${alternativeBoundary}--`);

    for (const image of rendered.inlineImages) {
      lines.push(`--${relatedBoundary}`);
      lines.push(`Content-Type: ${image.contentType}; name="${image.filename}"`);
      lines.push("Content-Transfer-Encoding: base64");
      lines.push(`Content-Disposition: inline; filename="${image.filename}"`);
      lines.push(`Content-ID: <${image.cid}>`, "");
      lines.push(...encodeMimeBase64(image.content), "");
    }

    lines.push(`--${relatedBoundary}--`);
  }

  const raw = Buffer.from(lines.join("\r\n"))
    .toString("base64")
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/g, "");

  const response = await gmail.users.messages.send({
    userId: "me",
    requestBody: {
      raw,
      threadId: args.threadId,
    },
  });
  return response.data;
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

async function renderEmailBody(markdown: string, workdir?: string): Promise<{
  text: string;
  html: string | null;
  inlineImages: InlineImage[];
}> {
  const inlineImages = await collectInlineImages(markdown, workdir);
  return {
    text: renderMarkdownToText(markdown, inlineImages),
    html: renderMarkdownToHtml(markdown, inlineImages),
    inlineImages,
  };
}

async function collectInlineImages(markdown: string, workdir?: string): Promise<InlineImage[]> {
  const images: InlineImage[] = [];
  const matches = Array.from(markdown.matchAll(/!\[([^\]]*)\]\(([^)]+)\)/g));
  for (const [index, match] of matches.entries()) {
    const resolvedPath = resolveLocalPath(match[2], workdir);
    if (!resolvedPath) {
      continue;
    }
    let content: Buffer;
    try {
      content = await fs.readFile(resolvedPath);
    } catch {
      continue;
    }
    const contentType = guessImageContentType(resolvedPath);
    if (!contentType) {
      continue;
    }
    images.push({
      alt: match[1] || path.basename(resolvedPath),
      cid: `codex-image-${Date.now()}-${index}@codex-email`,
      content,
      contentType,
      filename: path.basename(resolvedPath),
    });
  }
  return images;
}

function resolveLocalPath(rawPath: string, workdir?: string): string | null {
  const trimmed = rawPath.trim().replace(/^<|>$/g, "").replace(/^['"]|['"]$/g, "");
  if (!trimmed) {
    return null;
  }
  if (trimmed.startsWith("http://") || trimmed.startsWith("https://") || trimmed.startsWith("cid:")) {
    return null;
  }
  if (trimmed.startsWith("~/")) {
    return path.join(os.homedir(), trimmed.slice(2));
  }
  if (path.isAbsolute(trimmed)) {
    return trimmed;
  }
  return path.resolve(workdir || os.homedir(), trimmed);
}

function guessImageContentType(filePath: string): string | null {
  const ext = path.extname(filePath).toLowerCase();
  switch (ext) {
    case ".png":
      return "image/png";
    case ".jpg":
    case ".jpeg":
      return "image/jpeg";
    case ".gif":
      return "image/gif";
    case ".webp":
      return "image/webp";
    case ".svg":
      return "image/svg+xml";
    default:
      return null;
  }
}

function renderMarkdownToText(markdown: string, inlineImages: InlineImage[]): string {
  let text = markdown;
  for (const image of inlineImages) {
    text = text.replace(
      new RegExp(`!\\[[^\\]]*\\]\\([^)]*${escapeRegExp(image.filename)}[^)]*\\)`, "g"),
      `[Image attached: ${image.alt}]`,
    );
  }
  return text.trim() || "(No response text returned.)";
}

function renderMarkdownToHtml(markdown: string, inlineImages: InlineImage[]): string | null {
  const lines = markdown.replace(/\r\n/g, "\n").split("\n");
  const html: string[] = [];
  let index = 0;
  let inCodeBlock = false;
  let codeLines: string[] = [];

  while (index < lines.length) {
    const line = lines[index];
    if (line.trim().startsWith("```")) {
      if (inCodeBlock) {
        html.push(`<pre><code>${escapeHtml(codeLines.join("\n"))}</code></pre>`);
        codeLines = [];
        inCodeBlock = false;
      } else {
        inCodeBlock = true;
      }
      index += 1;
      continue;
    }
    if (inCodeBlock) {
      codeLines.push(line);
      index += 1;
      continue;
    }
    if (!line.trim()) {
      index += 1;
      continue;
    }
    const heading = line.match(/^(#{1,6})\s+(.*)$/);
    if (heading) {
      const level = heading[1].length;
      html.push(`<h${level}>${renderInlineMarkdown(heading[2], inlineImages)}</h${level}>`);
      index += 1;
      continue;
    }
    if (/^[-*]\s+/.test(line)) {
      const items: string[] = [];
      while (index < lines.length && /^[-*]\s+/.test(lines[index])) {
        items.push(`<li>${renderInlineMarkdown(lines[index].replace(/^[-*]\s+/, ""), inlineImages)}</li>`);
        index += 1;
      }
      html.push(`<ul>${items.join("")}</ul>`);
      continue;
    }
    const paragraph: string[] = [];
    while (
      index < lines.length &&
      lines[index].trim() &&
      !lines[index].trim().startsWith("```") &&
      !/^(#{1,6})\s+/.test(lines[index]) &&
      !/^[-*]\s+/.test(lines[index])
    ) {
      paragraph.push(lines[index]);
      index += 1;
    }
    html.push(`<p>${renderInlineMarkdown(paragraph.join(" "), inlineImages)}</p>`);
  }

  return html.length ? `<html><body>${html.join("\n")}</body></html>` : null;
}

function renderInlineMarkdown(value: string, inlineImages: InlineImage[]): string {
  const imageMap = new Map(inlineImages.map((image) => [image.filename, image]));
  let html = escapeHtml(value);
  html = html.replace(/`([^`]+)`/g, (_match, code) => `<code>${escapeHtml(code)}</code>`);
  html = html.replace(/\[([^\]]+)\]\((https?:\/\/[^)]+)\)/g, (_match, label, url) => {
    return `<a href="${escapeHtml(url)}">${escapeHtml(label)}</a>`;
  });
  html = html.replace(/!\[([^\]]*)\]\(([^)]+)\)/g, (_match, alt, source) => {
    const resolvedPath = resolveLocalPath(source);
    const image = imageMap.get(path.basename(resolvedPath || source));
    if (!image) {
      return `<em>${escapeHtml(alt || "image")}</em>`;
    }
    return `<img src="cid:${image.cid}" alt="${escapeHtml(image.alt)}" style="max-width:100%; height:auto; display:block;" />`;
  });
  return html;
}

function createBoundary(prefix: string): string {
  return `${prefix}-${Date.now()}-${Math.random().toString(16).slice(2)}`;
}

function encodeMimeBase64(value: string | Buffer): string[] {
  const encoded = (typeof value === "string" ? Buffer.from(value, "utf8") : value).toString("base64");
  return encoded.match(/.{1,76}/g) ?? [encoded];
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function maybeOpenBrowser(url: string): void {
  const openers = [
    ["xdg-open", url],
    ["open", url],
  ];

  for (const [command, arg] of openers) {
    try {
      const child = spawn(command, [arg], {
        detached: true,
        stdio: "ignore",
      });
      child.unref();
      console.log(`Tried opening browser with ${command}.`);
      return;
    } catch {
      // try next opener
    }
  }
}

function parseAllowedSenders(value: string | undefined): Set<string> {
  const configured = (value ?? DEFAULT_ALLOWED_SENDERS.join(","))
    .split(",")
    .map((entry) => entry.trim().toLowerCase())
    .filter(Boolean);
  return new Set(configured);
}

function buildInboxQuery(ctx: Context, options: ProcessOptions = {}): string {
  const senders = Array.from(ctx.allowedSenders).map((sender) => `from:${sender}`);
  if (options.includeSelf) {
    senders.push(`from:${ctx.emailAddress}`);
  }
  const senderQuery = senders.length ? `(${senders.join(" OR ")})` : "";
  const threadQuery = options.threadId ? ` thread:${options.threadId}` : "";
  return `is:unread in:inbox to:${ctx.emailAddress}${threadQuery}${senderQuery ? ` ${senderQuery}` : ""}`;
}

function isAllowedSender(ctx: Context, sender: string, options: ProcessOptions = {}): boolean {
  const normalized = sender.trim().toLowerCase();
  if (options.includeSelf && normalized === ctx.emailAddress.toLowerCase()) {
    return true;
  }
  return ctx.allowedSenders.has(normalized);
}

async function waitForMessage(gmail: gmail_v1.Gmail, threadId: string, timeoutMs = 15_000): Promise<void> {
  const startedAt = Date.now();
  while (Date.now() - startedAt < timeoutMs) {
    const thread = await gmail.users.threads.get({
      userId: "me",
      id: threadId,
      format: "metadata",
    });
    if ((thread.data.messages ?? []).length > 0) {
      return;
    }
    await sleep(1_000);
  }
  throw new Error(`Timed out waiting for Gmail thread ${threadId} to become visible.`);
}

function buildReferenceChain(...values: Array<string | null | undefined>): string {
  const normalized = values
    .flatMap((value) => (value ?? "").split(/\s+/))
    .map((value) => normalizeMessageId(value))
    .filter((value, index, array): value is string => Boolean(value) && array.indexOf(value) === index);
  return normalized.join(" ");
}

function escapeHtml(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

void main().catch((error) => {
  if (isGmailApiNotEnabledError(error)) {
    const enableUrl = extractExtendedHelpUrl(error) ?? "https://console.developers.google.com/apis/api/gmail.googleapis.com/overview";
    console.error("Gmail API is not enabled for this Google Cloud project.");
    console.error(`Open: ${enableUrl}`);
    console.error("Enable the Gmail API, wait a minute, then run `pnpm daemon` again.");
    process.exitCode = 1;
    return;
  }
  console.error(error);
  process.exitCode = 1;
});

function isGmailApiNotEnabledError(error: unknown): boolean {
  if (typeof error !== "object" || error === null || !("errors" in error)) {
    return false;
  }
  const errors = (error as { errors?: Array<{ reason?: string }> }).errors;
  return Array.isArray(errors) && errors.some((entry) => entry.reason === "accessNotConfigured");
}

function extractExtendedHelpUrl(error: unknown): string | null {
  if (typeof error !== "object" || error === null || !("errors" in error)) {
    return null;
  }
  const errors = (error as { errors?: Array<{ extendedHelp?: string }> }).errors;
  if (!Array.isArray(errors)) {
    return null;
  }
  const url = errors.map((entry) => entry.extendedHelp).find((value) => typeof value === "string");
  return url ?? null;
}
