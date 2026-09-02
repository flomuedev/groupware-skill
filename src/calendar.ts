import { DAVClient, type DAVCalendar, type DAVCalendarObject } from "tsdav";
import ICAL from "ical.js";
import { randomUUID } from "node:crypto";

import type { AccountConfig } from "./config.ts";
import { resolveAccount } from "./config.ts";

export interface CalendarEvent {
  uid: string;
  summary?: string;
  start: string; // ISO string
  end: string; // ISO string
  allDay: boolean;
  location?: string;
  description?: string;
  organizer?: string;
  status?: string;
  /** URL and etag of the underlying calendar object, needed to delete/update it. */
  url: string;
  etag?: string;
}

export interface NewEvent {
  summary: string;
  start: Date;
  end: Date;
  allDay?: boolean;
  location?: string;
  description?: string;
}

function icalDate(date: Date, allDay: boolean): ICAL.Time {
  if (allDay) {
    return ICAL.Time.fromData({
      year: date.getFullYear(),
      month: date.getMonth() + 1,
      day: date.getDate(),
      isDate: true,
    });
  }
  // Always emit an absolute UTC instant ("...Z"). This avoids depending on the
  // VTIMEZONE database being registered and is unambiguous for any CalDAV server.
  return ICAL.Time.fromJSDate(date, true);
}

function stringifyPropertyValue(value: unknown): string | undefined {
  if (value === null || value === undefined) return undefined;
  if (typeof value === "string") return value;
  if (typeof value === "object" && "toString" in value) return String(value);
  return undefined;
}

export class CalendarClient {
  private account: AccountConfig;
  private password: string;
  private client?: DAVClient;
  private calendarsCache?: DAVCalendar[];

  constructor(account: AccountConfig, password: string) {
    this.account = account;
    this.password = password;
  }

  private async getClient(): Promise<DAVClient> {
    if (this.client) return this.client;
    const resolved = resolveAccount(this.account);
    const client = new DAVClient({
      serverUrl: resolved.caldavUrl,
      credentials: { username: resolved.caldavUser, password: this.password },
      authMethod: "Basic",
      defaultAccountType: "caldav",
    });
    await client.login();
    this.client = client;
    return client;
  }

  async listCalendars(): Promise<DAVCalendar[]> {
    if (this.calendarsCache) return this.calendarsCache;
    const client = await this.getClient();
    this.calendarsCache = await client.fetchCalendars();
    return this.calendarsCache;
  }

  private async primaryCalendar(): Promise<DAVCalendar> {
    const calendars = await this.listCalendars();
    if (calendars.length === 0) throw new Error("No CalDAV calendars found for this account.");
    // Prefer a calendar whose URL matches the configured account URL (the user's own primary calendar).
    const resolved = resolveAccount(this.account);
    const exact = calendars.find((c) => c.url.replace(/\/$/, "") === resolved.caldavUrl.replace(/\/$/, ""));
    return exact ?? calendars[0];
  }

  async listEvents(start: Date, end: Date): Promise<CalendarEvent[]> {
    const client = await this.getClient();
    const calendar = await this.primaryCalendar();
    const objects = await client.fetchCalendarObjects({
      calendar,
      timeRange: { start: start.toISOString(), end: end.toISOString() },
      expand: true,
    });
    return objects.flatMap((obj) => this.parseObject(obj)).sort((a, b) => a.start.localeCompare(b.start));
  }

  private parseObject(obj: DAVCalendarObject): CalendarEvent[] {
    if (!obj.data) return [];
    try {
      const jcal = ICAL.parse(obj.data);
      const comp = new ICAL.Component(jcal);
      // Register any embedded VTIMEZONE definitions so TZID-based DTSTART/DTEND
      // values resolve correctly instead of falling back to floating time.
      for (const vtimezone of comp.getAllSubcomponents("vtimezone")) {
        try {
          ICAL.TimezoneService.register(vtimezone);
        } catch {
          // ignore malformed/duplicate timezone definitions
        }
      }
      const vevents = comp.getAllSubcomponents("vevent");
      return vevents.map((vevent) => {
        const event = new ICAL.Event(vevent);
        const start = event.startDate.toJSDate();
        const end = event.endDate.toJSDate();
        return {
          uid: event.uid,
          summary: event.summary || undefined,
          start: start.toISOString(),
          end: end.toISOString(),
          allDay: event.startDate.isDate,
          location: event.location || undefined,
          description: event.description || undefined,
          organizer: stringifyPropertyValue(vevent.getFirstPropertyValue("organizer")),
          status: stringifyPropertyValue(vevent.getFirstPropertyValue("status")),
          url: obj.url,
          etag: obj.etag,
        } satisfies CalendarEvent;
      });
    } catch {
      return [];
    }
  }

  async createEvent(input: NewEvent): Promise<{ uid: string; url: string }> {
    const client = await this.getClient();
    const calendar = await this.primaryCalendar();
    const allDay = Boolean(input.allDay);
    const uid = `${randomUUID()}@pi-groupware`;

    const comp = new ICAL.Component(["vcalendar", [], []]);
    comp.updatePropertyWithValue("prodid", "-//pi-groupware//EN");
    comp.updatePropertyWithValue("version", "2.0");

    const vevent = new ICAL.Component("vevent");
    vevent.updatePropertyWithValue("uid", uid);
    vevent.updatePropertyWithValue("summary", input.summary);
    vevent.updatePropertyWithValue("dtstamp", ICAL.Time.now());
    vevent.updatePropertyWithValue("dtstart", icalDate(input.start, allDay));
    vevent.updatePropertyWithValue("dtend", icalDate(input.end, allDay));
    if (input.location) vevent.updatePropertyWithValue("location", input.location);
    if (input.description) vevent.updatePropertyWithValue("description", input.description);
    comp.addSubcomponent(vevent);

    const filename = `${uid}.ics`;
    const response = await client.createCalendarObject({
      calendar,
      iCalString: comp.toString(),
      filename,
    });
    if (!response.ok) {
      throw new Error(`CalDAV server rejected event creation: HTTP ${response.status} ${await response.text()}`);
    }
    return { uid, url: new URL(filename, calendar.url).href };
  }

  async deleteEvent(url: string, etag?: string): Promise<void> {
    const client = await this.getClient();
    const response = await client.deleteCalendarObject({ calendarObject: { url, etag: etag ?? "" } as DAVCalendarObject });
    if (!response.ok && response.status !== 404) {
      throw new Error(`CalDAV server rejected event deletion: HTTP ${response.status}`);
    }
  }
}
