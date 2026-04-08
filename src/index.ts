import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import process from "node:process";
import readline from "node:readline/promises";
import { spawn } from "node:child_process";
import { stdin as input, stdout as output } from "node:process";

import { Codex } from "@openai/codex-sdk";
import { ImapFlow } from "imapflow";
import { simpleParser } from "mailparser";
import nodemailer from "nodemailer";

type BridgeConfig = {
  emailAddress: string;
  appPassword: string;
  imapHost: string;
  imapPort: number;
  smtpHost: string;
  smtpPort: number;
  secureImap: boolean;
  secureSmtp: boolean;
};

type BridgeState = {
  messageToThread: Record<string, string>;
  processedUids: Record<string, true>;
  updatedAt?: string;
};

type Context = {
  config: BridgeConfig;
  statePath: string;
  pollMs: number;
  codex: Codex;
  workdir: string;
  model?: string;
};

type ParsedMail = {
  uid: number;
  subject: string;
  from: string;
  body: string;
  messageId: string;
  references: string[];
  inReplyTo?: string | undefined;
};

const APP_DIR = path.join(os.homedir(), ".config", "codex-gmail-bridge");
const DEFAULT_CONFIG_PATH = path.join(APP_DIR, "config.json");
const DEFAULT_STATE_PATH = path.join(APP_DIR, "state.json");
const DEFAULT_EMAIL_ADDRESS = "rohanchromebook@gmail.com";
const DEFAULT_POLL_MS = 30_000;
const APP_PASSWORDS_URL = "https://myaccount.google.com/apppasswords";

async function main(): Promise<void> {
  const command = process.argv[2];
  if (!command || !["auth", "run-once", "daemon"].includes(command)) {
    throw new Error("usage: tsx src/index.ts <auth|run-once|daemon>");
  }

  if (command === "auth") {
    await configureInteractive();
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

async function configureInteractive(): Promise<void> {
  await fs.mkdir(APP_DIR, { recursive: true });
  const rl = readline.createInterface({ input, output });

  console.log("");
  console.log("Gmail app password setup is required once.");
  console.log(`Open: ${APP_PASSWORDS_URL}`);
  console.log("Create an app password for Mail, then paste it here.");
  console.log("");
  maybeOpenBrowser(APP_PASSWORDS_URL);

  const emailAddress =
    (await rl.question(`Gmail address [${DEFAULT_EMAIL_ADDRESS}]: `)).trim() || DEFAULT_EMAIL_ADDRESS;
  const appPassword = (await rl.question("App password: ")).trim().replace(/\s+/g, "");
  rl.close();

  if (!appPassword) {
    throw new Error("No app password was provided.");
  }

  const config: BridgeConfig = {
    emailAddress,
    appPassword,
    imapHost: "imap.gmail.com",
    imapPort: 993,
    smtpHost: "smtp.gmail.com",
    smtpPort: 465,
    secureImap: true,
    secureSmtp: true,
  };

  await testConnections(config);
  await fs.writeFile(DEFAULT_CONFIG_PATH, JSON.stringify(config, null, 2) + "\n", {
    encoding: "utf8",
    mode: 0o600,
  });
  console.log(`Saved config to ${DEFAULT_CONFIG_PATH}`);
}

async function createContext(): Promise<Context> {
  await fs.mkdir(APP_DIR, { recursive: true });
  const config = JSON.parse(await fs.readFile(DEFAULT_CONFIG_PATH, "utf8")) as BridgeConfig;
  const pollMs = Number(process.env.CODEX_EMAIL_POLL_MS || DEFAULT_POLL_MS);
  const workdir = process.env.CODEX_EMAIL_WORKDIR || os.homedir();
  const model = process.env.CODEX_EMAIL_MODEL;
  const codex = new Codex();

  return {
    config,
    statePath: DEFAULT_STATE_PATH,
    pollMs,
    codex,
    workdir,
    model,
  };
}

async function processUnreadMessages(ctx: Context): Promise<void> {
  const state = await loadState(ctx.statePath);
  const imap = new ImapFlow({
    host: ctx.config.imapHost,
    port: ctx.config.imapPort,
    secure: ctx.config.secureImap,
    auth: {
      user: ctx.config.emailAddress,
      pass: ctx.config.appPassword,
    },
  });

  await imap.connect();
  try {
    const lock = await imap.getMailboxLock("INBOX");
    try {
      const messages: ParsedMail[] = [];
      for await (const message of imap.fetch({ seen: false }, { uid: true, source: true, envelope: true })) {
        if (!message.uid || !message.source) {
          continue;
        }
        const uidKey = String(message.uid);
        if (state.processedUids[uidKey]) {
          continue;
        }

        const parsed = await simpleParser(message.source);
        const from = parsed.from?.value?.[0]?.address?.trim() || "";
        if (!from || from.toLowerCase() === ctx.config.emailAddress.toLowerCase()) {
          await imap.messageFlagsAdd(message.uid, ["\\Seen"]);
          state.processedUids[uidKey] = true;
          continue;
        }

        const body = (parsed.text || parsed.html || "").toString().trim();
        if (!body) {
          await imap.messageFlagsAdd(message.uid, ["\\Seen"]);
          state.processedUids[uidKey] = true;
          continue;
        }

        const refs = normalizeReferences(parsed.references);
        const inReplyToRaw = parsed.inReplyTo ? normalizeMessageId(parsed.inReplyTo) : null;
        const inReplyTo = inReplyToRaw ?? undefined;
        const messageId = normalizeMessageId(parsed.messageId) || `${uidKey}@local`;

        messages.push({
          uid: message.uid,
          subject: parsed.subject || "(no subject)",
          from,
          body,
          messageId,
          references: refs,
          inReplyTo,
        });
      }

      messages.sort((a, b) => a.uid - b.uid);
      for (const message of messages) {
        const codexThreadId = findThreadForMessage(state, message);
        const thread = codexThreadId
          ? ctx.codex.resumeThread(codexThreadId, codexThreadOptions(ctx))
          : ctx.codex.startThread(codexThreadOptions(ctx));

        const prompt = codexThreadId
          ? message.body
          : `You are replying by email. Keep the response concise and plain text unless formatting is clearly useful.\n\n${message.body}`;

        let responseText: string;
        try {
          const result = await thread.run(prompt);
          responseText = result.finalResponse.trim() || "(No response text returned.)";
        } catch (error) {
          const messageText = error instanceof Error ? error.message : String(error);
          responseText = `Codex run failed:\n\n${messageText}`;
        }

        if (!thread.id) {
          throw new Error(`Codex thread id missing after processing email uid ${message.uid}`);
        }

        const sentMessageId = await sendReply(ctx.config, {
          to: message.from,
          subject: replySubject(message.subject),
          body: responseText,
          inReplyTo: message.messageId,
          references: [...message.references, message.messageId],
        });

        state.messageToThread[message.messageId] = thread.id;
        if (sentMessageId) {
          state.messageToThread[sentMessageId] = thread.id;
        }
        state.processedUids[String(message.uid)] = true;
        state.updatedAt = new Date().toISOString();
        await saveState(ctx.statePath, state);
        await imap.messageFlagsAdd(message.uid, ["\\Seen"]);
      }
    } finally {
      lock.release();
    }
  } finally {
    await imap.logout();
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

function findThreadForMessage(state: BridgeState, message: ParsedMail): string | null {
  const keys = [...message.references];
  if (message.inReplyTo) {
    keys.push(message.inReplyTo);
  }
  for (const key of keys) {
    const threadId = state.messageToThread[key];
    if (threadId) {
      return threadId;
    }
  }
  return null;
}

async function testConnections(config: BridgeConfig): Promise<void> {
  const imap = new ImapFlow({
    host: config.imapHost,
    port: config.imapPort,
    secure: config.secureImap,
    auth: {
      user: config.emailAddress,
      pass: config.appPassword,
    },
  });
  await imap.connect();
  await imap.logout();

  const transporter = nodemailer.createTransport({
    host: config.smtpHost,
    port: config.smtpPort,
    secure: config.secureSmtp,
    auth: {
      user: config.emailAddress,
      pass: config.appPassword,
    },
  });
  await transporter.verify();
}

async function sendReply(
  config: BridgeConfig,
  args: {
    to: string;
    subject: string;
    body: string;
    inReplyTo: string;
    references: string[];
  },
): Promise<string | null> {
  const transporter = nodemailer.createTransport({
    host: config.smtpHost,
    port: config.smtpPort,
    secure: config.secureSmtp,
    auth: {
      user: config.emailAddress,
      pass: config.appPassword,
    },
  });

  const info = await transporter.sendMail({
    from: config.emailAddress,
    to: args.to,
    subject: args.subject,
    text: args.body,
    inReplyTo: args.inReplyTo,
    references: args.references,
  });

  return normalizeMessageId(info.messageId);
}

async function loadState(statePath: string): Promise<BridgeState> {
  try {
    return JSON.parse(await fs.readFile(statePath, "utf8")) as BridgeState;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      return { messageToThread: {}, processedUids: {} };
    }
    throw error;
  }
}

async function saveState(statePath: string, state: BridgeState): Promise<void> {
  await fs.writeFile(statePath, JSON.stringify(state, null, 2) + "\n", "utf8");
}

function normalizeReferences(value: string | string[] | undefined): string[] {
  if (!value) {
    return [];
  }
  const raw = Array.isArray(value) ? value.join(" ") : value;
  return raw
    .split(/\s+/)
    .map((part) => normalizeMessageId(part))
    .filter((part): part is string => Boolean(part));
}

function normalizeMessageId(value: string | undefined | null): string | null {
  if (!value) {
    return null;
  }
  const trimmed = value.trim();
  if (!trimmed) {
    return null;
  }
  return trimmed.startsWith("<") ? trimmed : `<${trimmed.replace(/[<>]/g, "")}>`;
}

function replySubject(subject: string): string {
  return /^re:/i.test(subject) ? subject : `Re: ${subject}`;
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

void main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
