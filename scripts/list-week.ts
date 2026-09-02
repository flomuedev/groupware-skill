import { getDefaultAccount } from "../src/config.ts";
import { getPassword } from "../src/secrets.ts";
import { CalendarClient } from "../src/calendar.ts";

async function main() {
  const account = await getDefaultAccount();
  if (!account) throw new Error("no account");
  const password = await getPassword(account.primaryEmail);
  if (!password) throw new Error("no password");

  const cal = new CalendarClient(account, password);
  const start = new Date();
  const end = new Date(start.getTime() + 7 * 24 * 3600 * 1000);
  const events = await cal.listEvents(start, end);
  for (const e of events) {
    console.log(`${e.start} - ${e.end}${e.allDay ? " (all-day)" : ""}: ${e.summary}`);
  }
}
main().catch((e) => {
  console.error("FAILED", e);
  process.exit(1);
});
