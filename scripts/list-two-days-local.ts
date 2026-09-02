import { getDefaultAccount } from "../src/config.ts";
import { getPassword } from "../src/secrets.ts";
import { CalendarClient } from "../src/calendar.ts";

async function main() {
  const account = await getDefaultAccount();
  if (!account) throw new Error("no account");
  const password = await getPassword(account.primaryEmail);
  if (!password) throw new Error("no password");

  const cal = new CalendarClient(account, password);
  // Full local (Europe/Berlin, currently CEST = UTC+2) calendar day for "today" and "tomorrow",
  // expressed in UTC so it lines up with khal's "Today"/"Tomorrow" day boundaries.
  const start = new Date("2026-09-02T00:00:00+02:00");
  const end = new Date("2026-09-04T00:00:00+02:00");
  const events = await cal.listEvents(start, end);
  for (const e of events) {
    const s = new Date(e.start).toLocaleString("de-DE", { timeZone: "Europe/Berlin" });
    const en = new Date(e.end).toLocaleString("de-DE", { timeZone: "Europe/Berlin" });
    console.log(`${s} - ${en}${e.allDay ? " (all-day)" : ""}: ${e.summary}`);
  }
}
main().catch((e) => {
  console.error("FAILED", e);
  process.exit(1);
});
