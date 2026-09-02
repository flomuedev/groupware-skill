import { getDefaultAccount } from "../src/config.ts";
import { getPassword, keyringAvailable } from "../src/secrets.ts";
import { MailClient } from "../src/mail.ts";
import { CalendarClient } from "../src/calendar.ts";

async function main() {
  console.log("keyring available:", await keyringAvailable());
  const account = await getDefaultAccount();
  console.log("account:", account?.primaryEmail);
  const password = account ? await getPassword(account.primaryEmail) : undefined;
  console.log("password retrieved:", password ? `yes (${password.length} chars)` : "no");
  if (!account || !password) return;

  const mail = new MailClient(account, password);
  const folders = await mail.listFolders();
  console.log("IMAP OK,", folders.length, "folders");

  const msgs = await mail.listMessages("inbox", 3);
  console.log(
    "Inbox sample:",
    msgs.map((m) => `${m.date} ${m.from} - ${m.subject}`),
  );

  const cal = new CalendarClient(account, password);
  const now = new Date();
  const in7 = new Date(now.getTime() + 7 * 24 * 3600 * 1000);
  const events = await cal.listEvents(now, in7);
  console.log("Calendar OK,", events.length, "events in next 7 days");
}

main().catch((e) => {
  console.error("FAILED:", e);
  process.exit(1);
});
