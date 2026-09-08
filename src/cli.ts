#!/usr/bin/env node
import { stdin as input } from "node:process";

import { TU_DARMSTADT_DEFAULTS, getDefaultAccount, upsertAccount, type AccountConfig } from "./config.ts";
import { getPassword, setPassword } from "./secrets.ts";
import { MailClient } from "./mail.ts";
import { CalendarClient } from "./calendar.ts";

type Input = Record<string, unknown>;

async function readInput(): Promise<Input> {
  const raw = process.argv.slice(3).join(" ") || (await readStdin());
  if (!raw.trim()) return {};
  try {
    return JSON.parse(raw) as Input;
  } catch {
    throw new Error("Input must be a JSON object, supplied after the command or on stdin.");
  }
}

async function readStdin(): Promise<string> {
  if (input.isTTY) return "";
  const chunks: Buffer[] = [];
  for await (const chunk of input) chunks.push(Buffer.from(chunk));
  return Buffer.concat(chunks).toString("utf8");
}

function string(value: unknown, name: string): string {
  if (typeof value !== "string" || !value) throw new Error(`Missing required string: ${name}`);
  return value;
}

function number(value: unknown, fallback: number): number {
  return typeof value === "number" && Number.isFinite(value) ? value : fallback;
}

function positiveInteger(value: unknown, name: string): number {
  if (typeof value !== "number" || !Number.isInteger(value) || value < 1) throw new Error(`${name} must be a positive integer.`);
  return value;
}

function bool(value: unknown): boolean | undefined {
  return typeof value === "boolean" ? value : undefined;
}

function strings(value: unknown, name: string): string[] | undefined {
  if (value === undefined) return undefined;
  if (!Array.isArray(value) || !value.every((item) => typeof item === "string")) throw new Error(`${name} must be an array of strings.`);
  return value;
}

function integers(value: unknown, name: string): number[] | undefined {
  if (value === undefined) return undefined;
  if (!Array.isArray(value) || !value.every((item) => typeof item === "number" && Number.isInteger(item) && item > 0)) throw new Error(`${name} must be an array of positive integers.`);
  return value;
}

function nonNegativeInteger(value: unknown, name: string): number {
  if (typeof value !== "number" || !Number.isInteger(value) || value < 0) throw new Error(`${name} must be a non-negative integer.`);
  return value;
}

async function clients() {
  const account = await getDefaultAccount();
  if (!account) throw new Error("No groupware account configured. Run `groupware setup` first.");
  const password = await getPassword(account.primaryEmail);
  if (!password) throw new Error(`No password available for ${account.primaryEmail}. Run \`groupware setup\` again.`);
  return { account, mail: new MailClient(account, password), calendar: new CalendarClient(account, password) };
}

async function prompt(question: string): Promise<string> {
  if (!input.isTTY) throw new Error("Interactive setup requires a terminal. Supply JSON input and GROUPWARE_PASSWORD instead.");
  process.stdout.write(question);
  input.resume();
  return new Promise((resolve) => {
    input.once("data", (chunk: Buffer) => { input.pause(); resolve(chunk.toString().trim()); });
  });
}

async function promptPassword(question: string): Promise<string> {
  if (!input.isTTY) throw new Error("Interactive setup requires a terminal. Supply JSON input and GROUPWARE_PASSWORD instead.");
  process.stdout.write(question);
  input.setRawMode(true);
  input.resume();
  return new Promise((resolve, reject) => {
    let value = "";
    const done = () => {
      input.setRawMode(false);
      input.pause();
      input.removeListener("data", onData);
    };
    const onData = (chunk: Buffer) => {
      const key = chunk.toString();
      if (key === "\u0003") { done(); reject(new Error("Setup cancelled.")); return; }
      if (key === "\r" || key === "\n") { done(); process.stdout.write("\n"); resolve(value); return; }
      if (key === "\u007f" || key === "\b") { value = value.slice(0, -1); return; }
      if (!key.startsWith("\u001b")) value += key;
    };
    input.on("data", onData);
  });
}

async function setup(values: Input) {
  if (!Object.keys(values).length) {
    if (!input.isTTY) throw new Error("Run `groupware setup` in an interactive terminal, or supply JSON input and GROUPWARE_PASSWORD.");
    console.log("TU Darmstadt groupware setup");
    values = {
      preset: "tu-darmstadt",
      loginId: await prompt("TU-ID: "),
      primaryEmail: await prompt("Primary email address: "),
      password: await promptPassword("Password (input hidden): "),
    };
  }
  const preset = values.preset === "tu-darmstadt";
  const password = typeof values.password === "string" ? values.password : process.env.GROUPWARE_PASSWORD;
  if (!password) throw new Error("Enter a password in interactive setup, or set GROUPWARE_PASSWORD only for this setup command; it is stored in the OS keychain, not the config file.");
  const loginId = string(values.loginId, "loginId");
  const primaryEmail = string(values.primaryEmail, "primaryEmail").toLowerCase();
  const account: AccountConfig = preset
    ? { ...TU_DARMSTADT_DEFAULTS, loginId, primaryEmail }
    : {
        label: string(values.label, "label"), loginId, primaryEmail,
        imapHost: string(values.imapHost, "imapHost"), imapPort: number(values.imapPort, 993),
        imapUserTemplate: string(values.imapUserTemplate, "imapUserTemplate"),
        smtpHost: string(values.smtpHost, "smtpHost"), smtpPort: number(values.smtpPort, 465),
        smtpUserTemplate: string(values.smtpUserTemplate, "smtpUserTemplate"),
        caldavUrlTemplate: string(values.caldavUrlTemplate, "caldavUrlTemplate"),
        caldavUserTemplate: string(values.caldavUserTemplate, "caldavUserTemplate"),
        timezone: typeof values.timezone === "string" ? values.timezone : "UTC",
      };
  const mail = new MailClient(account, password);
  const folders = await mail.listFolders();
  const special = (flag: string) => folders.find((folder) => folder.specialUse === flag)?.path;
  account.folders = { inbox: special("\\Inbox") ?? "INBOX", sent: special("\\Sent"), drafts: special("\\Drafts"), trash: special("\\Trash") };
  const calendar = new CalendarClient(account, password);
  const calendars = await calendar.listCalendars();
  await setPassword(primaryEmail, password);
  await upsertAccount(account);
  return { configured: primaryEmail, folders: account.folders, calendars: calendars.length };
}

function localDateParts(date: Date, timezone: string): Record<string, number> {
  const parts = new Intl.DateTimeFormat("en-CA", { timeZone: timezone, year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", hourCycle: "h23" }).formatToParts(date);
  return Object.fromEntries(parts.filter((part) => part.type !== "literal").map((part) => [part.type, Number(part.value)]));
}

/** Convert a wall-clock time in the account timezone to an absolute instant, including DST offsets. */
function zonedTime(year: number, month: number, day: number, hour: number, timezone: string): Date {
  const wanted = Date.UTC(year, month - 1, day, hour);
  let instant = wanted;
  for (let i = 0; i < 3; i++) {
    const actual = localDateParts(new Date(instant), timezone);
    const offset = wanted - Date.UTC(actual.year, actual.month - 1, actual.day, actual.hour);
    if (offset === 0) break;
    instant += offset;
  }
  return new Date(instant);
}

function freeTime(events: Array<{ start: string; end: string }>, start: string, end: string, startHour: number, endHour: number, minimumMinutes: number, timezone: string) {
  const slots: Array<{ start: string; end: string }> = [];
  const rangeStart = new Date(start);
  const rangeEnd = new Date(end);
  if (Number.isNaN(rangeStart.getTime()) || Number.isNaN(rangeEnd.getTime()) || rangeStart >= rangeEnd) throw new Error("start and end must be valid ISO dates with end after start.");
  const first = localDateParts(rangeStart, timezone);
  for (let day = new Date(Date.UTC(first.year, first.month - 1, first.day)); day < rangeEnd; day.setUTCDate(day.getUTCDate() + 1)) {
    const year = day.getUTCFullYear(), month = day.getUTCMonth() + 1, date = day.getUTCDate();
    const dayStart = new Date(Math.max(zonedTime(year, month, date, startHour, timezone).getTime(), rangeStart.getTime()));
    const dayEnd = new Date(Math.min(zonedTime(year, month, date, endHour, timezone).getTime(), rangeEnd.getTime()));
    if (dayStart >= dayEnd) continue;
    let cursor = dayStart;
    for (const busy of events.map((event) => ({ start: new Date(event.start), end: new Date(event.end) })).filter((event) => event.end > dayStart && event.start < dayEnd).sort((a, b) => a.start.getTime() - b.start.getTime())) {
      const busyStart = new Date(Math.max(busy.start.getTime(), dayStart.getTime()));
      const busyEnd = new Date(Math.min(busy.end.getTime(), dayEnd.getTime()));
      if (busyStart.getTime() - cursor.getTime() >= minimumMinutes * 60_000) slots.push({ start: cursor.toISOString(), end: busyStart.toISOString() });
      if (busyEnd > cursor) cursor = busyEnd;
    }
    if (dayEnd.getTime() - cursor.getTime() >= minimumMinutes * 60_000) slots.push({ start: cursor.toISOString(), end: dayEnd.toISOString() });
  }
  return slots;
}

async function run(command: string, values: Input): Promise<unknown> {
  if (command === "setup") return setup(values);
  const { account, mail, calendar } = await clients();
  switch (command) {
    case "mail-folders": return mail.listFolders();
    case "mail-list": return mail.listMessages(typeof values.folder === "string" ? values.folder : "inbox", number(values.limit, 20));
    case "mail-search": return mail.search(typeof values.folder === "string" ? values.folder : "inbox", { text: typeof values.text === "string" ? values.text : undefined, from: typeof values.from === "string" ? values.from : undefined, subject: typeof values.subject === "string" ? values.subject : undefined, since: typeof values.since === "string" ? values.since : undefined, unseen: bool(values.unseen) }, number(values.limit, 20));
    case "mail-read": return mail.readMessage(string(values.folder, "folder"), positiveInteger(values.uid, "uid"), bool(values.includeHtml) ?? false);
    case "mail-search-threads": return mail.searchThreads({ text: typeof values.text === "string" ? values.text : undefined, from: typeof values.from === "string" ? values.from : undefined, subject: typeof values.subject === "string" ? values.subject : undefined, since: typeof values.since === "string" ? values.since : undefined, unseen: bool(values.unseen) }, number(values.limit, 20));
    case "mail-mark": { const uids = integers(values.uids, "uids"); const action = string(values.action, "action"); if (!uids?.length || !["read", "unread", "flag", "unflag"].includes(action)) throw new Error("uids and a valid action are required."); await mail.mark(typeof values.folder === "string" ? values.folder : "inbox", uids, action as "read" | "unread" | "flag" | "unflag"); return { ok: true }; }
    case "mail-move": { const uids = integers(values.uids, "uids"); if (!uids?.length) throw new Error("uids must contain at least one UID."); await mail.move(typeof values.folder === "string" ? values.folder : "inbox", uids, string(values.destination, "destination")); return { ok: true }; }
    case "mail-attachments": return mail.listAttachments(string(values.folder, "folder"), positiveInteger(values.uid, "uid"));
    case "mail-attachment-get": return mail.downloadAttachment(string(values.folder, "folder"), positiveInteger(values.uid, "uid"), nonNegativeInteger(values.index, "index"));
    case "mail-thread": return mail.getThread(string(values.folder, "folder"), positiveInteger(values.uid, "uid"), number(values.limit, 100));
    case "mail-send": {
      const to = strings(values.to, "to");
      if (!to?.length) throw new Error("to must contain at least one recipient.");
      return mail.send({ to, cc: strings(values.cc, "cc"), bcc: strings(values.bcc, "bcc"), subject: string(values.subject, "subject"), text: string(values.body, "body"), inReplyTo: typeof values.inReplyTo === "string" ? values.inReplyTo : undefined, references: strings(values.references, "references"), saveToFolder: "sent" });
    }
    case "calendar-calendars": return calendar.calendarInfos();
    case "calendar-list": return calendar.listEvents(new Date(string(values.start, "start")), new Date(string(values.end, "end")), typeof values.calendarUrl === "string" ? values.calendarUrl : undefined);
    case "calendar-get": return calendar.getEvent(string(values.url, "url"), typeof values.calendarUrl === "string" ? values.calendarUrl : undefined);
    case "calendar-search": return calendar.searchEvents(new Date(string(values.start, "start")), new Date(string(values.end, "end")), string(values.text, "text"), typeof values.calendarUrl === "string" ? values.calendarUrl : undefined);
    case "calendar-create": return calendar.createEvent({ summary: string(values.summary, "summary"), start: new Date(string(values.start, "start")), end: new Date(string(values.end, "end")), allDay: bool(values.allDay), location: typeof values.location === "string" ? values.location : undefined, description: typeof values.description === "string" ? values.description : undefined }, typeof values.calendarUrl === "string" ? values.calendarUrl : undefined);
    case "calendar-update": return calendar.updateEvent({ url: string(values.url, "url"), etag: typeof values.etag === "string" ? values.etag : undefined, summary: typeof values.summary === "string" ? values.summary : undefined, start: typeof values.start === "string" ? new Date(values.start) : undefined, end: typeof values.end === "string" ? new Date(values.end) : undefined, allDay: bool(values.allDay), location: typeof values.location === "string" ? values.location : undefined, description: typeof values.description === "string" ? values.description : undefined }, typeof values.calendarUrl === "string" ? values.calendarUrl : undefined);
    case "calendar-delete": return calendar.deleteEvent(string(values.url, "url"), typeof values.etag === "string" ? values.etag : undefined);
    case "calendar-invite": {
      const attendees = strings(values.attendees, "attendees");
      if (!attendees?.length) throw new Error("attendees must contain at least one email address.");
      return calendar.sendInvite({ summary: string(values.summary, "summary"), start: new Date(string(values.start, "start")), end: new Date(string(values.end, "end")), attendees, allDay: bool(values.allDay), location: typeof values.location === "string" ? values.location : undefined, description: typeof values.description === "string" ? values.description : undefined });
    }
    case "calendar-respond": {
      const response = string(values.response, "response");
      if (!(["accepted", "declined", "tentative"] as string[]).includes(response)) throw new Error("response must be accepted, declined, or tentative.");
      await calendar.respondToInvite(string(values.url, "url"), response as "accepted" | "declined" | "tentative", typeof values.calendarUrl === "string" ? values.calendarUrl : undefined);
      return { ok: true };
    }
    case "calendar-free": {
      const start = string(values.start, "start"), end = string(values.end, "end");
      const events = await calendar.listEvents(new Date(start), new Date(end));
      return freeTime(events, start, end, number(values.workDayStartHour, 9), number(values.workDayEndHour, 18), number(values.minSlotMinutes, 30), account.timezone);
    }
    default: throw new Error(`Unknown command: ${command}`);
  }
}

const command = process.argv[2];
if (!command || ["--help", "help"].includes(command)) {
  console.error("Usage: groupware <setup|mail-folders|mail-list|mail-search|mail-read|mail-search-threads|mail-mark|mail-move|mail-attachments|mail-attachment-get|mail-thread|mail-send|calendar-calendars|calendar-list|calendar-get|calendar-search|calendar-create|calendar-update|calendar-delete|calendar-invite|calendar-respond|calendar-free> [JSON input]");
  process.exit(command ? 0 : 1);
}
run(command, await readInput()).then((result) => console.log(JSON.stringify(result, null, 2))).catch((error) => { console.error(JSON.stringify({ error: error instanceof Error ? error.message : String(error) })); process.exit(1); });
