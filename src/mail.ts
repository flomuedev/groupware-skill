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
  /** Present only when explicitly requested; HTML bodies can be very large. */
  html?: string;
  cc?: string[];
  inReplyTo?: string;
  references?: string[];
}

export interface ThreadMessage extends MessageSummary {
  folder: string;
}

export interface ThreadSummary {
  subject: string;
  messages: ThreadMessage[];
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

export interface AttachmentInfo {
  index: number;
  filename?: string;
  contentType?: string;
  size: number;
}

export interface AttachmentContent extends AttachmentInfo {
  contentBase64: string;
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
    try {
      await client.connect();
      return await fn(client);
    } catch (error) {
      const response = (error as { response?: { attributes?: Array<{ type?: string; value?: unknown }> } }).response;
      const detail = response?.attributes
        ?.filter((attribute) => attribute.type === "TEXT" && typeof attribute.value === "string")
        .map((attribute) => String(attribute.value).trim())
        .filter(Boolean)
        .join(" ");
      const message = error instanceof Error ? error.message : String(error);
      throw new Error(detail ? `IMAP request rejected: ${detail}` : message === "Command failed" ? "IMAP authentication was rejected. Check the TU-ID and password." : message);
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
      archive: "\\Archive",
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

  async readMessage(folder: string, uid: number, includeHtml = false): Promise<MessageDetail> {
    const path = await this.resolveFolder(folder);
    return this.withImap(async (client) => {
      await client.mailboxOpen(path);
      const msg = await client.fetchOne(String(uid), { envelope: true, flags: true, source: true }, { uid: true });
      if (!msg) throw new Error(`Message uid ${uid} not found in ${path}`);

      let text: string | undefined;
      let html: string | undefined;
      let references: string[] | undefined;
      if (msg.source) {
        const { simpleParser } = await import("mailparser");
        const parsed = await simpleParser(msg.source);
        text = parsed.text ?? undefined;
        html = includeHtml && typeof parsed.html === "string" ? parsed.html : undefined;
        const value = parsed.headers.get("references");
        references = typeof value === "string" ? value.split(/\s+/).filter(Boolean) : undefined;
      }

      return {
        ...summarize(msg),
        text,
        html,
        cc: envelopeToAddresses(msg.envelope?.cc),
        inReplyTo: msg.envelope?.inReplyTo ?? undefined,
        references,
      };
    });
  }

  async searchThreads(
    query: { text?: string; from?: string; subject?: string; since?: string; unseen?: boolean },
    limit = 20,
    folders = ["inbox", "sent", "archive"],
  ): Promise<ThreadSummary[]> {
    const results: ThreadMessage[] = [];
    for (const folder of [...new Set(folders)]) {
      try {
        const messages = await this.search(folder, query, limit);
        results.push(...messages.map((message) => ({ ...message, folder })));
      } catch {
        // An optional logical folder (notably archive) may not exist on every server.
      }
    }
    const threads = new Map<string, ThreadSummary>();
    for (const message of results) {
      const subject = (message.subject ?? "(no subject)").replace(/^(?:(?:re|fw|fwd|aw):\s*)+/i, "").trim();
      const key = subject.toLowerCase();
      const thread = threads.get(key) ?? { subject, messages: [] };
      thread.messages.push(message);
      threads.set(key, thread);
    }
    return [...threads.values()]
      .map((thread) => ({ ...thread, messages: thread.messages.sort((a, b) => (a.date ?? "").localeCompare(b.date ?? "")) }))
      .sort((a, b) => (b.messages.at(-1)?.date ?? "").localeCompare(a.messages.at(-1)?.date ?? ""))
      .slice(0, limit);
  }

  async mark(folder: string, uids: number[], action: "read" | "unread" | "flag" | "unflag"): Promise<void> {
    if (!uids.length) throw new Error("At least one message UID is required.");
    const path = await this.resolveFolder(folder);
    await this.withImap(async (client) => {
      await client.mailboxOpen(path);
      const ok = action === "read" ? await client.messageFlagsAdd(uids, ["\\Seen"], { uid: true })
        : action === "unread" ? await client.messageFlagsRemove(uids, ["\\Seen"], { uid: true })
        : action === "flag" ? await client.messageFlagsAdd(uids, ["\\Flagged"], { uid: true })
        : await client.messageFlagsRemove(uids, ["\\Flagged"], { uid: true });
      if (!ok) throw new Error("The mail server did not confirm the flag update.");
    });
  }

  async move(folder: string, uids: number[], destination: string): Promise<void> {
    if (!uids.length) throw new Error("At least one message UID is required.");
    const [source, target] = await Promise.all([this.resolveFolder(folder), this.resolveFolder(destination)]);
    await this.withImap(async (client) => {
      await client.mailboxOpen(source);
      if (!await client.messageMove(uids, target, { uid: true })) throw new Error("The mail server did not confirm the move.");
    });
  }

  async listAttachments(folder: string, uid: number): Promise<AttachmentInfo[]> {
    const message = await this.readParsed(folder, uid);
    return message.attachments.map((attachment, index) => ({ index, filename: attachment.filename || undefined, contentType: attachment.contentType, size: attachment.size }));
  }

  async downloadAttachment(folder: string, uid: number, index: number): Promise<AttachmentContent> {
    const message = await this.readParsed(folder, uid);
    const attachment = message.attachments[index];
    if (!attachment) throw new Error(`Attachment ${index} not found on message uid ${uid}.`);
    return { index, filename: attachment.filename || undefined, contentType: attachment.contentType, size: attachment.size, contentBase64: attachment.content.toString("base64") };
  }

  async getThread(folder: string, uid: number, limit = 100): Promise<ThreadMessage[]> {
    const original = await this.readMessage(folder, uid);
    const ids = [original.messageId, original.inReplyTo, ...(original.references ?? [])].filter((id): id is string => Boolean(id));
    const paths = [...new Set(await Promise.all([folder, "inbox", "sent", "archive"].map((name) => this.resolveFolder(name))))];
    return this.withImap(async (client) => {
      const found = new Map<string, ThreadMessage>();
      for (const path of paths) {
        try {
          await client.mailboxOpen(path);
          const uids = ids.length ? await Promise.all(ids.map((id) => client.search({ header: { "message-id": id } }, { uid: true }))) : [];
          for (const matches of uids) for await (const msg of client.fetch((matches || []).slice(-limit), { envelope: true, flags: true, bodyStructure: true }, { uid: true })) {
            const message = { ...summarize(msg), folder: path };
            found.set(`${path}:${msg.uid}`, message);
          }
        } catch { /* optional folders may not exist */ }
      }
      if (!found.size) found.set(`${folder}:${uid}`, { ...original, folder });
      return [...found.values()].sort((a, b) => (a.date ?? "").localeCompare(b.date ?? ""));
    });
  }

  private async readParsed(folder: string, uid: number) {
    const path = await this.resolveFolder(folder);
    return this.withImap(async (client) => {
      await client.mailboxOpen(path);
      const msg = await client.fetchOne(String(uid), { source: true }, { uid: true });
      if (!msg || !msg.source) throw new Error(`Message uid ${uid} not found in ${path}`);
      const { simpleParser } = await import("mailparser");
      return simpleParser(msg.source);
    });
  }

  private async compose(opts: SendOptions): Promise<Buffer> {
    const resolved = resolveAccount(this.account);
    const composer = new MailComposer({
      from: resolved.fromAddress, to: opts.to, cc: opts.cc, bcc: opts.bcc, subject: opts.subject,
      text: opts.text, html: opts.html, inReplyTo: opts.inReplyTo, references: opts.references,
    });
    return new Promise((resolve, reject) => composer.compile().build((err: Error | null, message: Buffer) => err ? reject(err) : resolve(message)));
  }

  /** Compose a message once, send it via SMTP, and optionally append the exact same bytes to a mailbox (e.g. Sent). */
  async send(opts: SendOptions): Promise<{ messageId: string; savedTo?: string }> {
    const raw = await this.compose(opts);
    const resolved = resolveAccount(this.account);
    const transport = nodemailer.createTransport({
      host: this.account.smtpHost,
      port: this.account.smtpPort,
      secure: true,
      auth: { user: resolved.smtpUser, pass: this.password },
    });
    // Nodemailer cannot reliably infer recipients from a raw MIME message;
    // provide the SMTP envelope explicitly while retaining the exact bytes saved to Sent.
    const info = await transport.sendMail({ raw, envelope: { from: resolved.fromAddress, to: [...opts.to, ...(opts.cc ?? []), ...(opts.bcc ?? [])] } });
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
