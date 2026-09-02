import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";

import { getDefaultAccount } from "./config.ts";
import { getPassword } from "./secrets.ts";
import { MailClient } from "./mail.ts";
import { CalendarClient } from "./calendar.ts";

async function requireClients() {
  const account = await getDefaultAccount();
  if (!account) {
    throw new Error("No pi-groupware account configured yet. Ask the user to run /groupware-setup.");
  }
  const password = await getPassword(account.primaryEmail);
  if (!password) {
    throw new Error(
      `No stored password for ${account.primaryEmail} (OS credential store may be unavailable). Ask the user to run /groupware-setup again.`,
    );
  }
  return {
    account,
    mail: new MailClient(account, password),
    calendar: new CalendarClient(account, password),
  };
}

export function registerGroupwareTools(pi: ExtensionAPI): void {
  pi.registerTool({
    name: "mail_list_folders",
    label: "Mail: List Folders",
    description: "List the mail folders (mailboxes) available in the configured account.",
    promptSnippet: "List mail folders",
    parameters: Type.Object({}),
    async execute() {
      const { mail } = await requireClients();
      const folders = await mail.listFolders();
      return {
        content: [
          {
            type: "text",
            text: folders.map((f) => `${f.path}${f.specialUse ? ` (${f.specialUse})` : ""}`).join("\n"),
          },
        ],
        details: { folders },
      };
    },
  });

  pi.registerTool({
    name: "mail_list_messages",
    label: "Mail: List Messages",
    description:
      'List the most recent messages in a folder. Use logical names "inbox", "sent", "drafts", "trash" or a literal folder path.',
    promptSnippet: "List recent email messages in a folder",
    parameters: Type.Object({
      folder: Type.Optional(Type.String({ description: 'Folder name, default "inbox"' })),
      limit: Type.Optional(Type.Integer({ minimum: 1, maximum: 100, description: "Max messages, default 20" })),
    }),
    async execute(_id, params) {
      const { mail } = await requireClients();
      const messages = await mail.listMessages(params.folder ?? "inbox", params.limit ?? 20);
      return {
        content: [{ type: "text", text: formatMessages(messages) }],
        details: { messages },
      };
    },
  });

  pi.registerTool({
    name: "mail_search",
    label: "Mail: Search",
    description: "Search messages in a folder by sender, subject, free text, or unseen status.",
    promptSnippet: "Search email by sender/subject/text",
    parameters: Type.Object({
      folder: Type.Optional(Type.String({ description: 'Folder name, default "inbox"' })),
      text: Type.Optional(Type.String({ description: "Free text matched against subject and body" })),
      from: Type.Optional(Type.String({ description: "Sender address or name substring" })),
      subject: Type.Optional(Type.String()),
      since: Type.Optional(Type.String({ description: "ISO date; only messages on/after this date" })),
      unseen: Type.Optional(Type.Boolean({ description: "Only unread messages" })),
      limit: Type.Optional(Type.Integer({ minimum: 1, maximum: 100 })),
    }),
    async execute(_id, params) {
      const { mail } = await requireClients();
      const messages = await mail.search(
        params.folder ?? "inbox",
        {
          text: params.text,
          from: params.from,
          subject: params.subject,
          since: params.since,
          unseen: params.unseen,
        },
        params.limit ?? 20,
      );
      return {
        content: [{ type: "text", text: messages.length ? formatMessages(messages) : "No matching messages." }],
        details: { messages },
      };
    },
  });

  pi.registerTool({
    name: "mail_read",
    label: "Mail: Read Message",
    description: "Read the full text/body of one message by its folder and UID (from mail_list_messages/mail_search).",
    promptSnippet: "Read a single email by folder + uid",
    parameters: Type.Object({
      folder: Type.String(),
      uid: Type.Integer(),
    }),
    async execute(_id, params) {
      const { mail } = await requireClients();
      const message = await mail.readMessage(params.folder, params.uid);
      const bodyText = message.text ?? "(no plain-text body; message may be HTML-only)";
      const header = [
        `From: ${message.from ?? "?"}`,
        `To: ${(message.to ?? []).join(", ")}`,
        message.cc?.length ? `Cc: ${message.cc.join(", ")}` : undefined,
        `Subject: ${message.subject ?? "(no subject)"}`,
        `Date: ${message.date ?? "?"}`,
      ]
        .filter(Boolean)
        .join("\n");
      return {
        content: [{ type: "text", text: `${header}\n\n${bodyText}` }],
        details: { message },
      };
    },
  });

  pi.registerTool({
    name: "mail_send",
    label: "Mail: Send",
    description:
      "Send an email via SMTP and save a copy to the Sent folder. Only call this when the user has explicitly approved sending " +
      "(recipient, subject, and body must already be confirmed with the user).",
    promptSnippet: "Send an email (requires explicit user approval)",
    promptGuidelines: [
      "Use mail_send only after the user has clearly approved the exact recipient, subject, and body — never send speculatively.",
      "Use mail_read to fetch a message's Message-ID/references before calling mail_send as a reply, and pass them as inReplyTo/references so threading works.",
    ],
    parameters: Type.Object({
      to: Type.Array(Type.String()),
      cc: Type.Optional(Type.Array(Type.String())),
      bcc: Type.Optional(Type.Array(Type.String())),
      subject: Type.String(),
      body: Type.String({ description: "Plain-text body" }),
      inReplyTo: Type.Optional(Type.String({ description: "Message-ID header of the message being replied to" })),
      references: Type.Optional(Type.Array(Type.String())),
    }),
    async execute(_id, params) {
      const { mail } = await requireClients();
      const result = await mail.send({
        to: params.to,
        cc: params.cc,
        bcc: params.bcc,
        subject: params.subject,
        text: params.body,
        inReplyTo: params.inReplyTo,
        references: params.references,
        saveToFolder: "sent",
      });
      return {
        content: [
          {
            type: "text",
            text: `Sent (${result.messageId})${result.savedTo ? `, saved to ${result.savedTo}` : ", but could not save a copy to Sent"}.`,
          },
        ],
        details: result,
      };
    },
  });

  pi.registerTool({
    name: "calendar_list_events",
    label: "Calendar: List Events",
    description: "List calendar events between two ISO date(-time)s.",
    promptSnippet: "List calendar events in a date range",
    parameters: Type.Object({
      start: Type.String({ description: "ISO date or date-time, inclusive" }),
      end: Type.String({ description: "ISO date or date-time, exclusive" }),
    }),
    async execute(_id, params) {
      const { calendar } = await requireClients();
      const events = await calendar.listEvents(new Date(params.start), new Date(params.end));
      return {
        content: [{ type: "text", text: events.length ? formatEvents(events) : "No events in this range." }],
        details: { events },
      };
    },
  });

  pi.registerTool({
    name: "calendar_create_event",
    label: "Calendar: Create Event",
    description:
      "Create a new calendar event. This is a side effect (a real appointment is created) — only call after the user has " +
      "clearly asked for this specific event.",
    promptSnippet: "Create a calendar event (requires explicit user request)",
    promptGuidelines: [
      "Do not use calendar_create_event to accept, decline, or otherwise respond to an existing Exchange meeting invitation; " +
        "CalDAV cannot reliably change Exchange attendee/organizer state. Tell the user to respond in Outlook/OWA instead.",
    ],
    parameters: Type.Object({
      summary: Type.String({ description: "Event title" }),
      start: Type.String({ description: "ISO date-time (or date if allDay)" }),
      end: Type.String({ description: "ISO date-time (or date if allDay)" }),
      allDay: Type.Optional(Type.Boolean()),
      location: Type.Optional(Type.String()),
      description: Type.Optional(Type.String()),
    }),
    async execute(_id, params) {
      const { calendar } = await requireClients();
      const created = await calendar.createEvent({
        summary: params.summary,
        start: new Date(params.start),
        end: new Date(params.end),
        allDay: params.allDay,
        location: params.location,
        description: params.description,
      });
      return {
        content: [{ type: "text", text: `Created event "${params.summary}" (uid ${created.uid}).` }],
        details: created,
      };
    },
  });

  pi.registerTool({
    name: "calendar_find_free_time",
    label: "Calendar: Find Free Time",
    description: "Compute free periods within a date range and working-hour window, based on the user's own calendar only.",
    promptSnippet: "Find free time slots from the calendar",
    parameters: Type.Object({
      start: Type.String({ description: "ISO date, e.g. 2026-01-05" }),
      end: Type.String({ description: "ISO date, exclusive" }),
      workDayStartHour: Type.Optional(Type.Integer({ minimum: 0, maximum: 23 })),
      workDayEndHour: Type.Optional(Type.Integer({ minimum: 1, maximum: 24 })),
      minSlotMinutes: Type.Optional(Type.Integer({ minimum: 5 })),
    }),
    async execute(_id, params) {
      const { calendar } = await requireClients();
      const rangeStart = new Date(params.start);
      const rangeEnd = new Date(params.end);
      const events = await calendar.listEvents(rangeStart, rangeEnd);
      const startHour = params.workDayStartHour ?? 9;
      const endHour = params.workDayEndHour ?? 18;
      const minSlot = params.minSlotMinutes ?? 30;

      const freeSlots: Array<{ start: string; end: string }> = [];
      for (let d = new Date(rangeStart); d < rangeEnd; d.setDate(d.getDate() + 1)) {
        const dayStart = new Date(d);
        dayStart.setHours(startHour, 0, 0, 0);
        const dayEnd = new Date(d);
        dayEnd.setHours(endHour, 0, 0, 0);

        const busy = events
          .map((e) => ({ start: new Date(e.start), end: new Date(e.end) }))
          .filter((e) => e.end > dayStart && e.start < dayEnd)
          .sort((a, b) => a.start.getTime() - b.start.getTime());

        let cursor = dayStart;
        for (const b of busy) {
          if (b.start.getTime() - cursor.getTime() >= minSlot * 60_000) {
            freeSlots.push({ start: cursor.toISOString(), end: b.start.toISOString() });
          }
          if (b.end > cursor) cursor = b.end;
        }
        if (dayEnd.getTime() - cursor.getTime() >= minSlot * 60_000) {
          freeSlots.push({ start: cursor.toISOString(), end: dayEnd.toISOString() });
        }
      }

      return {
        content: [
          {
            type: "text",
            text: freeSlots.length
              ? freeSlots.map((s) => `${s.start} — ${s.end}`).join("\n")
              : "No free slots found in the given range/working hours.",
          },
        ],
        details: { freeSlots },
      };
    },
  });
}

function formatMessages(messages: Awaited<ReturnType<MailClient["listMessages"]>>): string {
  if (messages.length === 0) return "No messages.";
  return messages
    .map((m) => `[uid ${m.uid}] ${m.date ?? "?"} — ${m.from ?? "?"} — ${m.subject ?? "(no subject)"}${m.flags.includes("\\Seen") ? "" : " [unread]"}`)
    .join("\n");
}

function formatEvents(events: Awaited<ReturnType<CalendarClient["listEvents"]>>): string {
  return events
    .map((e) => `${e.start} — ${e.end}${e.allDay ? " (all-day)" : ""}: ${e.summary ?? "(no title)"}${e.location ? ` @ ${e.location}` : ""}`)
    .join("\n");
}
