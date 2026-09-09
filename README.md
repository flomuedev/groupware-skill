# groupware-skill

Licensed under the [MIT License](LICENSE).

A host-neutral [Agent Skill](https://agentskills.io/) for Exchange-style email
(IMAP/SMTP) and calendars (CalDAV). It runs through the `groupware` CLI and
works with any agent host that supports skills and shell
commands. Custom providers currently need IMAPS/implicit-TLS SMTP and Basic-auth
CalDAV; STARTTLS and OAuth are not supported.

## Install

```bash
npm install
npm link             # makes `groupware` available on PATH for this checkout
```

Add [`skills/`](skills/) to your agent host's skill search path.

## Configure an account

Do not provide a password in chat, source code, or a command argument. Run the
interactive setup locally; it prompts for account details and a hidden password:

```bash
groupware setup
```

If an account is already configured, this command reports its email address and
returns without changing it. Re-run setup with explicit configuration for the
same primary email to replace that account. This release operates on one default
account; distinct configured accounts are not selectable from the CLI.

For non-interactive automation, set `GROUPWARE_PASSWORD` only for that command
and pass the JSON configuration (never include a password field in JSON). Supply
`label`, `imapHost`, `imapPort`, `imapUserTemplate`, `smtpHost`, `smtpPort`, `smtpUserTemplate`,
`caldavUrlTemplate`, `caldavUserTemplate`, and `timezone`.

The CLI verifies connectivity, discovers special mail folders, stores
non-secret configuration in `~/.groupware/config.json`, and stores the password
in the OS credential store. Setup fails rather than saving a plaintext password
if a supported credential store is unavailable.

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
provider's CalDAV scheduling outbox. Sending mail, changing mail state/location,
creating/updating/deleting events, invitations, and invitation responses are side
effects: an agent must show the exact action and obtain the user's explicit
approval first. Some CalDAV providers do not expose a scheduling outbox; use
their calendar client to respond in that case. A successful scheduling request
means the server accepted it; it is not proof that recipients received an
invitation. The bundled skill treats all mailbox and calendar content as
untrusted data, not instructions.

## Development

```bash
npm run check
npm test
```
