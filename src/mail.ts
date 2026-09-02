import { ImapFlow, type FetchMessageObject, type ListResponse, type SearchObject } from "imapflow";
import nodemailer from "nodemailer";
import MailComposer from "nodemailer/lib/mail-composer/index.js";

import type { AccountConfig } from "./config.ts";
import { resolveAccount } from "./config.ts";

export interface FolderInfo {
  path: string;
  specialUse?: string;
  flags: string[];
}

export interface MessageSummary {
  uid: number;
  seq: number;
  from?: string;
  to?: string[];
  subject?: string;
  date?: string;
  flags: string[];
  hasAttachments: boolean;
  messageId?: string;
}

export interface MessageDetail extends MessageSummary {
  text?: string;
  html?: string;
  cc?: string[];
  inReplyTo?: string;
  references?: string[];
}

export interface SendOptions {
  to: string[];
  cc?: string[];
  bcc?: string[];
  subject: string;
  text: string;
  html?: string;
  inReplyTo?: string;
  references?: string[];
  saveToFolder?: string;
}

function envelopeToAddresses(list?: Array<{ address?: string; name?: string }>): string[] {
  if (!list) return [];
  return list
    .filter((a) => a.address)
    .map((a) => (a.name ? `${a.name} <${a.address}>` : (a.address as string)));
}

function summarize(msg: FetchMessageObject): MessageSummary {
  return {
    uid: msg.uid,
    seq: msg.seq,
    from: envelopeToAddresses(msg.envelope?.from)[0],
    to: envelopeToAddresses(msg.envelope?.to),
    subject: msg.envelope?.subject ?? undefined,
    date: msg.envelope?.date ? new Date(msg.envelope.date).toISOString() : undefined,
    flags: msg.flags ? Array.from(msg.flags) : [],
    hasAttachments: Boolean(msg.bodyStructure && JSON.stringify(msg.bodyStructure).includes('"attachment"')),
    messageId: msg.envelope?.messageId ?? undefined,
  };
}

export class MailClient {
  private account: AccountConfig;
  private password: string;

  constructor(account: AccountConfig, password: string) {
    this.account = account;
    this.password = password;
  }

  private async withImap<T>(fn: (client: ImapFlow) => Promise<T>): Promise<T> {
    const resolved = resolveAccount(this.account);
    const client = new ImapFlow({
      host: this.account.imapHost,
      port: this.account.imapPort,
      secure: true,
      auth: { user: resolved.imapUser, pass: this.password },
      logger: false,
    });
    await client.connect();
    try {
      return await fn(client);
    } finally {
      await client.logout().catch(() => client.close());
    }
  }

  async listFolders(): Promise<FolderInfo[]> {
    return this.withImap(async (client) => {
      const list = await client.list();
      return list.map((mb: ListResponse) => ({
        path: mb.path,
        specialUse: mb.specialUse,
        flags: mb.flags ? Array.from(mb.flags) : [],
      }));
    });
  }

  /** Resolve a logical folder name ("inbox" | "sent" | "drafts" | "trash") or a literal path. */
  async resolveFolder(name: string): Promise<string> {
    const configured = this.account.folders as Record<string, string | undefined> | undefined;
    const key = name.toLowerCase();
    if (configured?.[key]) return configured[key] as string;

    const specialUseMap: Record<string, string> = {
      inbox: "\\Inbox",
      sent: "\\Sent",
      drafts: "\\Drafts",
      trash: "\\Trash",
    };
    const wanted = specialUseMap[key];
    if (wanted) {
      const folders = await this.listFolders();
      const found = folders.find((f) => f.specialUse === wanted);
      if (found) return found.path;
    }
    return name; // treat as a literal path
  }

  async listMessages(folder: string, limit = 20): Promise<MessageSummary[]> {
    const path = await this.resolveFolder(folder);
    return this.withImap(async (client) => {
      const mailbox = await client.mailboxOpen(path);
      const total = mailbox.exists;
      if (total === 0) return [];
      const start = Math.max(1, total - limit + 1);
      const results: MessageSummary[] = [];
      for await (const msg of client.fetch(`${start}:${total}`, { envelope: true, flags: true, bodyStructure: true })) {
        results.push(summarize(msg));
      }
      return results.reverse();
    });
  }

  async search(
    folder: string,
    query: { text?: string; from?: string; subject?: string; since?: string; unseen?: boolean },
    limit = 20,
  ): Promise<MessageSummary[]> {
    const path = await this.resolveFolder(folder);
    return this.withImap(async (client) => {
      await client.mailboxOpen(path);
      const searchQuery: SearchObject = {};
      if (query.text) searchQuery.or = [{ subject: query.text }, { body: query.text }];
      if (query.from) searchQuery.from = query.from;
      if (query.subject) searchQuery.subject = query.subject;
      if (query.since) searchQuery.since = new Date(query.since);
      if (query.unseen) searchQuery.seen = false;

      const uids = (await client.search(searchQuery, { uid: true })) || [];
      const wanted = uids.slice(-limit).reverse();
      if (wanted.length === 0) return [];
      const results: MessageSummary[] = [];
      for await (const msg of client.fetch(wanted, { envelope: true, flags: true, bodyStructure: true }, { uid: true })) {
        results.push(summarize(msg));
      }
      return results;
    });
  }

  async readMessage(folder: string, uid: number): Promise<MessageDetail> {
    const path = await this.resolveFolder(folder);
    return this.withImap(async (client) => {
      await client.mailboxOpen(path);
      const msg = await client.fetchOne(String(uid), { envelope: true, flags: true, source: true }, { uid: true });
      if (!msg) throw new Error(`Message uid ${uid} not found in ${path}`);

      let text: string | undefined;
      let html: string | undefined;
      if (msg.source) {
        const { simpleParser } = await import("mailparser");
        const parsed = await simpleParser(msg.source);
        text = parsed.text ?? undefined;
        html = typeof parsed.html === "string" ? parsed.html : undefined;
      }

      return {
        ...summarize(msg),
        text,
        html,
        cc: envelopeToAddresses(msg.envelope?.cc),
        inReplyTo: msg.envelope?.inReplyTo ?? undefined,
      };
    });
  }

  /** Compose a message once, send it via SMTP, and optionally append the exact same bytes to a mailbox (e.g. Sent). */
  async send(opts: SendOptions): Promise<{ messageId: string; savedTo?: string }> {
    const resolved = resolveAccount(this.account);

    const composer = new MailComposer({
      from: resolved.fromAddress,
      to: opts.to,
      cc: opts.cc,
      bcc: opts.bcc,
      subject: opts.subject,
      text: opts.text,
      html: opts.html,
      inReplyTo: opts.inReplyTo,
      references: opts.references,
    });

    const raw: Buffer = await new Promise((resolve, reject) => {
      composer.compile().build((err: Error | null, message: Buffer) => {
        if (err) reject(err);
        else resolve(message);
      });
    });

    const transport = nodemailer.createTransport({
      host: this.account.smtpHost,
      port: this.account.smtpPort,
      secure: true,
      auth: { user: resolved.smtpUser, pass: this.password },
    });
    const info = await transport.sendMail({ raw });
    transport.close();

    let savedTo: string | undefined;
    if (opts.saveToFolder) {
      const path = await this.resolveFolder(opts.saveToFolder);
      await this.withImap(async (client) => {
        await client.append(path, raw, ["\\Seen"]);
      });
      savedTo = path;
    }

    return { messageId: info.messageId, savedTo };
  }
}
