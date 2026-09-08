# groupware-skill

A host-neutral [Agent Skill](https://agentskills.io/) for Exchange-style email
(IMAP/SMTP) and calendars (CalDAV), with a TU Darmstadt preset. It runs through
the `groupware` CLI and works with any agent host that supports skills and shell
commands.

## Install

```bash
npm install
npm link             # makes `groupware` available on PATH for this checkout
```

Add [`skills/`](skills/) to your agent host's skill search path.

## Configure an account

Do not provide a password in chat, source code, or a command argument. For a TU
Darmstadt account, run the interactive setup locally; it prompts for your TU-ID,
email address, and a hidden password:

```bash
groupware setup
```

For non-interactive automation, set `GROUPWARE_PASSWORD` only for that command
and pass the JSON configuration. For a custom provider, omit `preset` and supply `label`, `imapHost`,
`imapPort`, `imapUserTemplate`, `smtpHost`, `smtpPort`, `smtpUserTemplate`,
`caldavUrlTemplate`, `caldavUserTemplate`, and `timezone`.

The CLI verifies connectivity, discovers special mail folders, stores
non-secret configuration in `~/.groupware/config.json`, and stores the password
in the OS credential store.

## Use

The skill instructions are in [`skills/groupware/SKILL.md`](skills/groupware/SKILL.md).
For example:

```bash
groupware mail-folders
groupware mail-list '{"folder":"inbox","limit":20}'
groupware calendar-list '{"start":"2026-01-05","end":"2026-01-06"}'
groupware calendar-respond '{"url":"https://calendar.example/event.ics","response":"accepted"}'
```

The CLI can read and search IMAP mail, send approved mail, list and manage
CalDAV events, send invitations, and respond to invitations through the
provider's CalDAV scheduling outbox. Sending mail, invitations, and invitation
responses are side effects: an agent must show the exact action and obtain the
user's explicit approval first. Some CalDAV providers do not expose a scheduling
outbox; use their calendar client to respond in that case.

## Development

```bash
npm run check
```
