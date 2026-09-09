import assert from "node:assert/strict";
import test from "node:test";

import { accountMidnight, icalDate, trustedCalendarObjectUrl, trustedSchedulingOutboxUrl } from "../src/calendar.ts";

const caldav = "https://calendar.example.test/dav/calendars/ada/";
const principal = "https://calendar.example.test/dav/principals/ada/";

test("accepts a same-origin HTTPS scheduling outbox", () => {
  assert.equal(trustedSchedulingOutboxUrl("../outbox/", principal, caldav), "https://calendar.example.test/dav/principals/outbox/");
});

test("rejects an off-origin or non-HTTPS scheduling outbox before credentials are sent", () => {
  assert.throws(() => trustedSchedulingOutboxUrl("https://attacker.example/outbox", principal, caldav), /outside the configured HTTPS origin/);
  assert.throws(() => trustedSchedulingOutboxUrl("http://calendar.example.test/outbox", principal, caldav), /outside the configured HTTPS origin/);
});

test("only permits event URLs inside the selected HTTPS calendar", () => {
  assert.equal(trustedCalendarObjectUrl("meeting.ics", caldav), "https://calendar.example.test/dav/calendars/ada/meeting.ics");
  assert.throws(() => trustedCalendarObjectUrl("https://attacker.example/x", caldav), /outside the selected HTTPS calendar/);
  assert.throws(() => trustedCalendarObjectUrl("https://calendar.example.test/dav/calendars/other/x", caldav), /outside the selected HTTPS calendar/);
});

test("all-day event dates use the account timezone rather than the host timezone", () => {
  const midnightInBerlin = accountMidnight(2026, 1, 5, "Europe/Berlin");
  assert.equal(midnightInBerlin.toISOString(), "2026-01-04T23:00:00.000Z");
  assert.equal(icalDate(midnightInBerlin, true, "Europe/Berlin").toString(), "2026-01-05");
});
