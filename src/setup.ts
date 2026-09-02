import type { ExtensionAPI, ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import nodemailer from "nodemailer";

import { TU_DARMSTADT_DEFAULTS, getDefaultAccount, resolveAccount, upsertAccount, type AccountConfig } from "./config.ts";
import { getPassword, keyringAvailable, setPassword } from "./secrets.ts";
import { MailClient } from "./mail.ts";
import { CalendarClient } from "./calendar.ts";

async function runVerification(account: AccountConfig, password: string, ctx: ExtensionCommandContext): Promise<AccountConfig> {
  const resolved = resolveAccount(account);
  const lines: string[] = [];

  ctx.ui.notify("Connecting to IMAP…", "info");
  const mail = new MailClient(account, password);
  const folders = await mail.listFolders();
  lines.push(`IMAP OK: ${folders.length} folders found on ${account.imapHost}.`);

  const bySpecialUse = (flag: string) => folders.find((f) => f.specialUse === flag)?.path;
  const discovered = {
    inbox: bySpecialUse("\\Inbox") ?? "INBOX",
    sent: bySpecialUse("\\Sent"),
    drafts: bySpecialUse("\\Drafts"),
    trash: bySpecialUse("\\Trash"),
  };
  if (!discovered.sent) {
    const guess = folders.find((f) => /sent|gesendete/i.test(f.path));
    if (guess) discovered.sent = guess.path;
  }
  lines.push(
    `Folders: inbox=${discovered.inbox ?? "?"} sent=${discovered.sent ?? "?"} drafts=${discovered.drafts ?? "?"} trash=${discovered.trash ?? "?"}`,
  );

  ctx.ui.notify("Checking SMTP…", "info");
  const transport = nodemailer.createTransport({
    host: account.smtpHost,
    port: account.smtpPort,
    secure: true,
    auth: { user: resolved.smtpUser, pass: password },
  });
  await transport.verify();
  transport.close();
  lines.push(`SMTP OK: ${account.smtpHost}.`);

  ctx.ui.notify("Connecting to CalDAV…", "info");
  const calendar = new CalendarClient(account, password);
  const calendars = await calendar.listCalendars();
  lines.push(`CalDAV OK: ${calendars.length} calendar(s) visible.`);

  ctx.ui.notify(lines.join("\n"), "info");

  return {
    ...account,
    folders: {
      inbox: discovered.inbox,
      sent: discovered.sent,
      drafts: discovered.drafts,
      trash: discovered.trash,
    },
  };
}

export function registerSetupCommands(pi: ExtensionAPI): void {
  pi.registerCommand("groupware-setup", {
    description: "Configure email (IMAP/SMTP) and calendar (CalDAV) access for pi-groupware",
    handler: async (_args, ctx) => {
      const usePreset = await ctx.ui.confirm(
        "pi-groupware setup",
        "Use the built-in TU Darmstadt server preset? Choose No to enter custom IMAP/SMTP/CalDAV server settings.",
      );

      const loginId = await ctx.ui.input("Login ID (e.g. your TU-ID)", "ab12cdef");
      if (!loginId) return ctx.ui.notify("Setup cancelled: login id is required.", "warning");

      const primaryEmail = await ctx.ui.input("Primary email address", "firstname.lastname@tu-darmstadt.de");
      if (!primaryEmail) return ctx.ui.notify("Setup cancelled: primary email is required.", "warning");

      let account: AccountConfig;
      if (usePreset) {
        account = {
          ...TU_DARMSTADT_DEFAULTS,
          loginId,
          primaryEmail: primaryEmail.toLowerCase(),
        };
      } else {
        const label = (await ctx.ui.input("Account label", "My Exchange account")) || "Exchange";
        const imapHost = await ctx.ui.input("IMAP host", "mail.example.com");
        const imapPort = Number((await ctx.ui.input("IMAP port", "993")) || 993);
        const imapUserTemplate = (await ctx.ui.input("IMAP username template ({id} = login id)", "{id}")) || "{id}";
        const smtpHost = await ctx.ui.input("SMTP host", "smtp.example.com");
        const smtpPort = Number((await ctx.ui.input("SMTP port", "465")) || 465);
        const smtpUserTemplate = (await ctx.ui.input("SMTP username template ({id} = login id)", "{id}")) || "{id}";
        const caldavUrlTemplate = await ctx.ui.input(
          "CalDAV URL template ({id}/{email} placeholders)",
          "https://mail.example.com:1443/users/{email}/calendar",
        );
        const caldavUserTemplate = (await ctx.ui.input("CalDAV username template", "{id}")) || "{id}";
        const timezone = (await ctx.ui.input("Timezone", "Europe/Berlin")) || "Europe/Berlin";
        if (!imapHost || !smtpHost || !caldavUrlTemplate) {
          return ctx.ui.notify("Setup cancelled: server settings are required.", "warning");
        }
        account = {
          label,
          loginId,
          primaryEmail: primaryEmail.toLowerCase(),
          imapHost,
          imapPort,
          imapUserTemplate,
          smtpHost,
          smtpPort,
          smtpUserTemplate,
          caldavUrlTemplate,
          caldavUserTemplate,
          timezone,
        };
      }

      const hasKeyring = await keyringAvailable();
      if (!hasKeyring) {
        ctx.ui.notify(
          "Warning: no OS credential store is available (@napi-rs/keyring failed to load for this platform/arch). " +
            "The password cannot be saved; you will be asked to re-enter it every session.",
          "warning",
        );
      }

      const password = await ctx.ui.input(
        "Password (stored in the OS credential store, not in chat history or on disk)",
        "",
      );
      if (!password) return ctx.ui.notify("Setup cancelled: password is required.", "warning");

      try {
        const verified = await runVerification(account, password, ctx);
        if (hasKeyring) {
          await setPassword(verified.primaryEmail, password);
        }
        await upsertAccount(verified);
        ctx.ui.notify(
          `pi-groupware is configured for ${verified.primaryEmail}. Try "check my mail" or "what's on my calendar today?".`,
          "info",
        );
      } catch (err) {
        ctx.ui.notify(`Setup failed: ${err instanceof Error ? err.message : String(err)}`, "error");
      }
    },
  });

  pi.registerCommand("groupware-status", {
    description: "Show the configured pi-groupware account and connection status",
    handler: async (_args, ctx) => {
      const account = await getDefaultAccount();
      if (!account) {
        ctx.ui.notify("No account configured yet. Run /groupware-setup.", "warning");
        return;
      }
      const password = await getPassword(account.primaryEmail);
      if (!password) {
        ctx.ui.notify(
          `Account ${account.primaryEmail} is configured but no password is stored (or the OS credential store is unavailable). Run /groupware-setup again.`,
          "warning",
        );
        return;
      }
      try {
        await runVerification(account, password, ctx);
      } catch (err) {
        ctx.ui.notify(`Status check failed: ${err instanceof Error ? err.message : String(err)}`, "error");
      }
    },
  });
}
