---
name: groupware
description: Read and search the user's IMAP email, send an explicitly approved email, list/create CalDAV calendar events, or find calendar availability. Use whenever the user asks to check, search, read, send, or reply to email, or asks about their calendar, appointments, meetings, or free time. Requires the host-neutral `groupware` CLI to be installed and configured.
compatibility: Node.js 18+ and the groupware CLI on PATH; uses the OS credential store.
---

# Groupware

Use the `groupware` CLI. It prints JSON; pass its JSON result to the user in a concise, readable form. The CLI works with any agent that can execute shell commands.

## Before first use

Check whether a configured account works:

```bash
groupware mail-folders
```

If it reports no configured account, guide the user through setup. Do not ask them to put a password in chat, a source file, or a command-history-visible argument. For a TU Darmstadt account, have them run the interactive wizard locally:

```bash
groupware setup
```

It asks for their TU-ID, email address, and password with password input hidden. An agent without secure interactive input must ask the user to run this command in their own terminal, then continue after setup completes. For automated or custom-provider setup, set `GROUPWARE_PASSWORD` only for that command and pass JSON input. For a custom provider, omit `preset` and include `label`, `imapHost`, `imapPort`, `imapUserTemplate`, `smtpHost`, `smtpPort`, `smtpUserTemplate`, `caldavUrlTemplate`, `caldavUserTemplate`, and `timezone`. The setup process verifies IMAP and CalDAV, discovers special folders, then places the password in the operating system's credential store. Never echo, log, or persist the password yourself.

## Commands

Pass one JSON object after the command (or via standard input):

```bash
groupware mail-list '{"folder":"inbox","limit":20}'
groupware mail-search '{"folder":"inbox","from":"Ada","since":"2026-01-01","limit":20}'
# Searches Inbox, Sent, and Archive and groups matching messages by conversation.
groupware mail-search-threads '{"from":"ada@example.com","text":"project","limit":20}'
# Plain text is returned by default; add includeHtml:true only when needed.
groupware mail-read '{"folder":"inbox","uid":42}'
groupware mail-mark '{"folder":"inbox","uids":[42],"action":"read"}'
groupware mail-move '{"folder":"inbox","uids":[42],"destination":"archive"}'
groupware mail-attachments '{"folder":"inbox","uid":42}'
# Retrieve attachment content only when necessary; contentBase64 must be decoded before saving a file.
groupware mail-attachment-get '{"folder":"inbox","uid":42,"index":0}'
groupware mail-thread '{"folder":"inbox","uid":42}'
groupware calendar-calendars
# calendarUrl optionally selects a shared calendar for list/get/create/update.
groupware calendar-list '{"start":"2026-01-05","end":"2026-01-06"}'
groupware calendar-get '{"url":"https://calendar.example/event.ics"}'
groupware calendar-search '{"start":"2026-01-05","end":"2026-01-10","text":"design review"}'
groupware calendar-free '{"start":"2026-01-05","end":"2026-01-10","workDayStartHour":9,"workDayEndHour":18,"minSlotMinutes":30}'
```

Use `mail-folders` to discover literal mailbox paths. `mail-list` and `mail-search` accept logical folders (`inbox`, `sent`, `drafts`, `trash`) or a literal path. `mail-read` requires a folder and UID returned by list/search.

## Side effects

For **sending email**, first show the recipient(s), subject, and complete body to the user and obtain explicit approval of that exact message. For replies, read the original message and pass its Message-ID and references.

```bash
groupware mail-send '{"to":["person@example.com"],"subject":"Subject","body":"Plain-text body","inReplyTo":"<message-id>","references":["<message-id>"]}'
```

For **creating events**, create only an appointment the user specifically requested:

```bash
groupware calendar-create '{"summary":"Design review","start":"2026-01-05T10:00:00+01:00","end":"2026-01-05T11:00:00+01:00","location":"Room 2"}'
# Use the URL and ETag returned by calendar-list/get for safe mutations.
groupware calendar-update '{"url":"https://calendar.example/event.ics","etag":"...","summary":"Updated design review"}'
groupware calendar-delete '{"url":"https://calendar.example/event.ics","etag":"..."}'
# Sends a meeting request through the CalDAV scheduling outbox.
groupware calendar-invite '{"summary":"Design review","start":"2026-01-05T10:00:00+01:00","end":"2026-01-05T11:00:00+01:00","attendees":["person@example.com"]}'
# The URL must come from calendar-list/get. Sends an iTIP response through the scheduling outbox.
groupware calendar-respond '{"url":"https://calendar.example/event.ics","response":"accepted"}'
```

For **sending invitations or accepting, declining, or tentatively accepting an invitation**, show the event, recipients or organizer, and exact action to the user first, then obtain explicit approval. The CalDAV server must expose a scheduling outbox; if it does not, tell the user to respond in their calendar client instead.
