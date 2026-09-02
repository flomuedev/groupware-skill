# pi-groupware

A self-contained [pi](https://github.com/earendil-works/pi-mono) extension for
Exchange-style email (IMAP/SMTP) and calendar (CalDAV) access, with a built-in
preset for **TU Darmstadt**.

This replaces the earlier `tu-exchange` skill, which shelled out to
`himalaya` + `vdirsyncer` + `khal` — real CLI tools that had to be installed
separately (via WSL on Windows) and kept in sync. This extension instead
talks IMAP/SMTP/CalDAV directly from pure npm packages (`imapflow`,
`nodemailer`, `tsdav`, `ical.js`), so `npm install` is the entire setup on
any OS, including plain Windows (no WSL required).

## Install

```bash
git clone <this repo> ~/.pi/agent/extensions/pi-groupware
cd ~/.pi/agent/extensions/pi-groupware
npm install
```

Restart pi (or run `/reload`). The extension auto-loads from
`~/.pi/agent/extensions/pi-groupware/` because it has a `package.json` with a
`pi.extensions` entry pointing at `./src/index.ts`.

## First-time setup

Inside pi, run:

```
/groupware-setup
```

You'll be asked for:

1. Whether to use the built-in **TU Darmstadt** server preset, or enter custom
   IMAP/SMTP/CalDAV settings for another Exchange-style account.
2. Your login id (TU-ID) and primary email address.
3. Your password.

The wizard then verifies IMAP, SMTP, and CalDAV connectivity, auto-discovers
your real `Sent`/`Drafts`/`Trash` folder names (they're often localized, e.g.
`Gesendete Elemente`), and saves everything.

Run `/groupware-status` any time to re-verify the connection.

## Where things are stored

- **Non-secret config** (login id, email, server hosts, discovered folder
  names): `~/.pi-groupware/config.json`. No password is ever written here.
- **Password**: the OS credential store, via
  [`@napi-rs/keyring`](https://github.com/Brooooooklyn/keyring-node):
  - Windows → Credential Manager
  - macOS → Keychain
  - Linux → Secret Service (GNOME Keyring / KWallet via libsecret)

If no credential store is available on a given platform/architecture,
`/groupware-setup` warns you and does not persist the password; you'll be
asked to re-enter it (verification only, per-session) until a store is
available.

> The setup wizard's password prompt is a normal pi text input — there's no
> masked/secret input widget in the extension API yet, so the characters are
> visible while you type them in the pi UI. They're not written to the
> session transcript or to disk in plaintext.

## What it can do

Tools available to the LLM (also directly usable, e.g. "check my mail",
"what's on my calendar tomorrow?"):

- `mail_list_folders`, `mail_list_messages`, `mail_search`, `mail_read`,
  `mail_send` (SMTP send + saves a copy to Sent)
- `calendar_list_events`, `calendar_create_event`, `calendar_find_free_time`

## Deliberate limitations (carried over from the old skill)

- **No Exchange meeting-response handling.** Do not use this to accept,
  decline, or tentatively accept meeting invitations — CalDAV cannot reliably
  change Exchange organizer/attendee state. Respond in Outlook/OWA instead.
  `calendar_create_event` is only for creating your own new appointments.
- **Sending requires explicit approval.** `mail_send` is only meant to be
  called once a human has approved the exact recipient/subject/body — this is
  enforced by prompt guidance to the LLM, not by the tool itself, so review
  what the assistant is about to send.
- Only one CalDAV calendar (the account's primary calendar) is queried by
  default; shared/other calendars aren't auto-added.

## Development

```bash
npm install
npm run check   # tsc --noEmit, using a local type stub for @earendil-works/pi-coding-agent
npm run smoke   # loads the extension with a fake pi API and prints registered tools/commands
```

`npm run check`/`npm run smoke` are dev conveniences only; they are not part
of what pi loads at runtime (pi provides the real `@earendil-works/pi-coding-agent`,
`typebox`, etc. itself).
