import { getDefaultAccount } from "../src/config.ts";
import { getPassword } from "../src/secrets.ts";
import { MailClient } from "../src/mail.ts";

async function main() {
  const account = await getDefaultAccount();
  if (!account) throw new Error("no account");
  const password = await getPassword(account.primaryEmail);
  if (!password) throw new Error("no password");

  const mail = new MailClient(account, password);
  const msgs = await mail.listMessages("inbox", 10);
  for (const m of msgs) {
    console.log(`[uid ${m.uid}] ${m.date} ${m.from} — ${m.subject}${m.flags.includes("\Seen") ? "" : " [unread]"}`);
  }
}
main().catch((e) => {
  console.error("FAILED", e);
  process.exit(1);
});
