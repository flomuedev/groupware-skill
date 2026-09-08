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

export interface EventUpdate extends Partial<NewEvent> {
  url: string;
  etag?: string;
}

export interface CalendarInfo {
  url: string;
  displayName?: string;
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
  private calendarsCache?: { fetchedAt: number; calendars: DAVCalendar[] };
  private rangeFetches = new Map<string, Promise<DAVCalendarObject[]>>();
  private eventsCache = new Map<string, { fetchedAt: number; events: CalendarEvent[] }>();

  private static readonly EVENT_CACHE_MS = 60_000;
  private static readonly CALENDAR_CACHE_MS = 60_000;

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
    if (this.calendarsCache && Date.now() - this.calendarsCache.fetchedAt < CalendarClient.CALENDAR_CACHE_MS) {
      return this.calendarsCache.calendars;
    }
    const client = await this.getClient();
    const calendars = await client.fetchCalendars();
    this.calendarsCache = { fetchedAt: Date.now(), calendars };
    return calendars;
  }

  async calendarInfos(): Promise<CalendarInfo[]> {
    return (await this.listCalendars()).map((calendar) => ({ url: calendar.url, displayName: stringifyPropertyValue(calendar.displayName), description: calendar.description }));
  }

  private async selectCalendar(calendarUrl?: string): Promise<DAVCalendar> {
    const calendars = await this.listCalendars();
    if (calendars.length === 0) throw new Error("No CalDAV calendars found for this account.");
    if (calendarUrl) {
      const selected = calendars.find((calendar) => calendar.url.replace(/\/$/, "") === calendarUrl.replace(/\/$/, ""));
      if (!selected) throw new Error("Calendar not found or not accessible to this account.");
      return selected;
    }
    const resolved = resolveAccount(this.account);
    return calendars.find((c) => c.url.replace(/\/$/, "") === resolved.caldavUrl.replace(/\/$/, "")) ?? calendars[0];
  }

  async listEvents(start: Date, end: Date, calendarUrl?: string): Promise<CalendarEvent[]> {
    const calendar = await this.selectCalendar(calendarUrl);
    const cacheKey = `${calendar.url}:${start.getTime()}:${end.getTime()}`;
    const cached = this.eventsCache.get(cacheKey);
    if (cached && Date.now() - cached.fetchedAt < CalendarClient.EVENT_CACHE_MS) return cached.events;

    const client = await this.getClient();
    // Exchange correctly honors a nested VEVENT time-range filter. Its objects
    // use .EML rather than .ics URLs, so override tsdav's .ics-only default.
    // The server returns recurring masters that overlap the range; ical.js still
    // expands them locally to preserve exceptions, EXDATEs, and reschedules.
    const objects = await this.fetchRangeObjects(calendar, client, start, end);
    const events = objects.flatMap((obj) => this.parseObject(obj, start, end)).sort((a, b) => a.start.localeCompare(b.start));
    this.eventsCache.set(cacheKey, { fetchedAt: Date.now(), events });
    return events;
  }

  /** Search event fields after recurrence expansion, preserving the same date-range semantics as listEvents. */
  async searchEvents(start: Date, end: Date, text: string, calendarUrl?: string): Promise<CalendarEvent[]> {
    const needle = text.trim().toLowerCase();
    if (!needle) throw new Error("Search text is required.");
    return (await this.listEvents(start, end, calendarUrl)).filter((event) =>
      [event.summary, event.location, event.description, event.organizer].some((value) => value?.toLowerCase().includes(needle)),
    );
  }

  /** Clear the short-lived in-memory event cache after a calendar mutation. */
  invalidateEventCache(): void {
    this.eventsCache.clear();
  }

  private async fetchRangeObjects(
    calendar: DAVCalendar,
    client: DAVClient,
    start: Date,
    end: Date,
  ): Promise<DAVCalendarObject[]> {
    const key = `${start.getTime()}:${end.getTime()}`;
    const inFlight = this.rangeFetches.get(key);
    if (inFlight) return inFlight;

    const fetch = client
      .fetchCalendarObjects({
        calendar,
        timeRange: { start: start.toISOString(), end: end.toISOString() },
        urlFilter: () => true,
      })
      .finally(() => this.rangeFetches.delete(key));
    this.rangeFetches.set(key, fetch);
    return fetch;
  }

  private parseObject(obj: DAVCalendarObject, rangeStart: Date, rangeEnd: Date): CalendarEvent[] {
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
      return vevents.flatMap((vevent) => this.expandVevent(vevent, obj, rangeStart, rangeEnd));
    } catch {
      return [];
    }
  }

  /** Expand a single VEVENT (recurring or not) into concrete occurrences overlapping [rangeStart, rangeEnd]. */
  private expandVevent(vevent: ICAL.Component, obj: DAVCalendarObject, rangeStart: Date, rangeEnd: Date): CalendarEvent[] {
    const event = new ICAL.Event(vevent);
    const toEvent = (uid: string, summary: string | undefined, start: Date, end: Date, allDay: boolean): CalendarEvent => ({
      uid,
      summary: summary || undefined,
      start: start.toISOString(),
      end: end.toISOString(),
      allDay,
      location: event.location || undefined,
      description: event.description || undefined,
      organizer: stringifyPropertyValue(vevent.getFirstPropertyValue("organizer")),
      status: stringifyPropertyValue(vevent.getFirstPropertyValue("status")),
      url: obj.url,
      etag: obj.etag,
    });

    if (!event.isRecurring()) {
      const start = event.startDate.toJSDate();
      const end = event.endDate.toJSDate();
      if (end < rangeStart || start > rangeEnd) return [];
      return [toEvent(event.uid, event.summary, start, end, event.startDate.isDate)];
    }

    const results: CalendarEvent[] = [];
    const iterator = event.iterator();
    const MAX_OCCURRENCES = 10_000; // safety cap against pathological/unbounded recurrences
    for (let i = 0; i < MAX_OCCURRENCES; i++) {
      const next = iterator.next();
      if (!next) break;
      const details = event.getOccurrenceDetails(next);
      const occStart = details.startDate.toJSDate();
      const occEnd = details.endDate.toJSDate();
      if (occStart > rangeEnd) break; // occurrences are chronological; nothing further can match
      const status = stringifyPropertyValue(details.item.component.getFirstPropertyValue("status"));
      if (status === "CANCELLED") continue;
      if (occEnd >= rangeStart && occStart <= rangeEnd) {
        results.push(toEvent(event.uid, details.item.summary, occStart, occEnd, details.startDate.isDate));
      }
    }
    return results;
  }

  async createEvent(input: NewEvent, calendarUrl?: string): Promise<{ uid: string; url: string }> {
    const client = await this.getClient();
    const calendar = await this.selectCalendar(calendarUrl);
    const uid = `${randomUUID()}@groupware`;
    const url = await this.storeEvent(calendar, client, uid, this.eventIcs(input, uid));
    return { uid, url };
  }

  async getEvent(url: string, calendarUrl?: string): Promise<CalendarEvent> {
    const calendar = await this.selectCalendar(calendarUrl);
    const client = await this.getClient();
    const objects = await client.fetchCalendarObjects({ calendar, objectUrls: [url], urlFilter: () => true });
    const object = objects[0];
    if (!object) throw new Error("Calendar event not found.");
    const event = this.parseObject(object, new Date("1970-01-01T00:00:00.000Z"), new Date("2100-01-01T00:00:00.000Z"))[0];
    if (!event) throw new Error("Calendar object does not contain a readable event.");
    return event;
  }

  /** Update the master event while preserving recurrence rules and attendees. */
  async updateEvent(input: EventUpdate, calendarUrl?: string): Promise<void> {
    const calendar = await this.selectCalendar(calendarUrl);
    const client = await this.getClient();
    const objects = await client.fetchCalendarObjects({ calendar, objectUrls: [input.url], urlFilter: () => true });
    const object = objects[0];
    if (!object?.data) throw new Error("Calendar event not found.");
    const component = new ICAL.Component(ICAL.parse(object.data));
    const event = component.getFirstSubcomponent("vevent");
    if (!event) throw new Error("Calendar object has no VEVENT.");
    const set = (name: string, value: string | undefined) => {
      if (value === undefined) return;
      if (value) event.updatePropertyWithValue(name, value); else event.removeAllProperties(name);
    };
    set("summary", input.summary);
    set("location", input.location);
    set("description", input.description);
    if (input.start) event.updatePropertyWithValue("dtstart", icalDate(input.start, Boolean(input.allDay)));
    if (input.end) event.updatePropertyWithValue("dtend", icalDate(input.end, Boolean(input.allDay)));
    event.updatePropertyWithValue("dtstamp", ICAL.Time.now());
    object.data = component.toString();
    object.etag = input.etag ?? object.etag;
    const response = await client.updateCalendarObject({ calendarObject: object });
    if (!response.ok) throw new Error(`CalDAV server rejected event update: HTTP ${response.status}`);
    this.invalidateEventCache();
  }

  /**
   * Create an organizer copy, then use DavMail's schedule-outbox extension
   * to submit a MIME meeting request through Exchange.
   */
  async sendInvite(input: NewEvent & { attendees: string[] }): Promise<{ uid: string; url: string }> {
    if (input.attendees.length === 0) throw new Error("At least one attendee is required.");
    const client = await this.getClient();
    const calendar = await this.selectCalendar();
    const uid = `${randomUUID()}@groupware`;
    const localIcs = this.eventIcs(input, uid, input.attendees);
    const url = await this.storeEvent(calendar, client, uid, localIcs);

    try {
      await this.submitScheduling(client, this.eventIcs(input, uid, input.attendees, "REQUEST"), "invitation");
    } catch (error) {
      // Do not leave an organizer event behind when its invitation was not sent.
      await this.deleteEvent(url).catch(() => undefined);
      throw error;
    }
    return { uid, url };
  }

  /** Send an iTIP accept/decline/tentative reply through the CalDAV scheduling outbox. */
  async respondToInvite(url: string, response: "accepted" | "declined" | "tentative", calendarUrl?: string): Promise<void> {
    const calendar = await this.selectCalendar(calendarUrl);
    const client = await this.getClient();
    const objects = await client.fetchCalendarObjects({ calendar, objectUrls: [url], urlFilter: () => true });
    const object = objects[0];
    if (!object?.data) throw new Error("Calendar event not found.");

    const originalCalendar = new ICAL.Component(ICAL.parse(object.data));
    const original = originalCalendar.getFirstSubcomponent("vevent");
    if (!original) throw new Error("Calendar object has no VEVENT.");
    const uid = stringifyPropertyValue(original.getFirstPropertyValue("uid"));
    const organizer = original.getFirstProperty("organizer");
    if (!uid || !organizer) throw new Error("This calendar event has no organizer and cannot be answered as an invitation.");

    const replyCalendar = new ICAL.Component(["vcalendar", [], []]);
    replyCalendar.updatePropertyWithValue("prodid", "-//groupware//EN");
    replyCalendar.updatePropertyWithValue("version", "2.0");
    replyCalendar.updatePropertyWithValue("method", "REPLY");
    const reply = new ICAL.Component("vevent");
    for (const name of ["uid", "dtstart", "dtend", "organizer"]) {
      const property = original.getFirstProperty(name);
      if (property) reply.addProperty(new ICAL.Property(JSON.parse(JSON.stringify(property.toJSON()))));
    }
    reply.updatePropertyWithValue("dtstamp", ICAL.Time.now());
    const attendee = reply.addPropertyWithValue("attendee", `mailto:${this.account.primaryEmail.toLowerCase()}`);
    attendee.setParameter("partstat", response.toUpperCase());
    replyCalendar.addSubcomponent(reply);

    await this.submitScheduling(client, replyCalendar.toString(), "response");
    const ownAttendee = original.getAllProperties("attendee").find((property) =>
      String(property.getFirstValue()).replace(/^mailto:/i, "").toLowerCase() === this.account.primaryEmail.toLowerCase(),
    );
    if (ownAttendee) ownAttendee.setParameter("partstat", response.toUpperCase());
    else {
      const localAttendee = original.addPropertyWithValue("attendee", `mailto:${this.account.primaryEmail.toLowerCase()}`);
      localAttendee.setParameter("partstat", response.toUpperCase());
    }
    original.updatePropertyWithValue("dtstamp", ICAL.Time.now());
    object.data = originalCalendar.toString();
    const update = await client.updateCalendarObject({ calendarObject: object });
    if (!update.ok) throw new Error(`CalDAV server accepted the response but rejected the local status update: HTTP ${update.status}`);
    this.invalidateEventCache();
  }

  private eventIcs(input: NewEvent, uid: string, attendees?: string[], method?: "REQUEST"): string {
    const comp = new ICAL.Component(["vcalendar", [], []]);
    comp.updatePropertyWithValue("prodid", "-//groupware//EN");
    comp.updatePropertyWithValue("version", "2.0");
    if (method) comp.updatePropertyWithValue("method", method);

    const vevent = new ICAL.Component("vevent");
    vevent.updatePropertyWithValue("uid", uid);
    vevent.updatePropertyWithValue("summary", input.summary);
    vevent.updatePropertyWithValue("dtstamp", ICAL.Time.now());
    vevent.updatePropertyWithValue("dtstart", icalDate(input.start, Boolean(input.allDay)));
    vevent.updatePropertyWithValue("dtend", icalDate(input.end, Boolean(input.allDay)));
    if (input.location) vevent.updatePropertyWithValue("location", input.location);
    if (input.description) vevent.updatePropertyWithValue("description", input.description);
    if (attendees?.length) {
      vevent.updatePropertyWithValue("organizer", `mailto:${this.account.primaryEmail}`);
      for (const email of attendees) {
        const attendee = vevent.addPropertyWithValue("attendee", `mailto:${email}`);
        attendee.setParameter("partstat", "NEEDS-ACTION");
        attendee.setParameter("rsvp", "TRUE");
      }
    }
    comp.addSubcomponent(vevent);
    return comp.toString();
  }

  private async storeEvent(calendar: DAVCalendar, client: DAVClient, uid: string, iCalString: string): Promise<string> {
    const filename = `${uid}.ics`;
    const response = await client.createCalendarObject({ calendar, iCalString, filename });
    if (!response.ok) throw new Error(`CalDAV server rejected event creation: HTTP ${response.status} ${await response.text()}`);
    this.invalidateEventCache();
    return new URL(filename, calendar.url).href;
  }

  private async submitScheduling(client: DAVClient, iCalString: string, label: string): Promise<void> {
    const outboxUrl = await this.scheduleOutboxUrl(client);
    const resolved = resolveAccount(this.account);
    const authorization = Buffer.from(`${resolved.caldavUser}:${this.password}`).toString("base64");
    const response = await fetch(outboxUrl, {
      method: "POST",
      headers: { Authorization: `Basic ${authorization}`, "Content-Type": "text/calendar; charset=utf-8" },
      body: iCalString,
    });
    if (!response.ok) throw new Error(`CalDAV scheduling outbox rejected ${label}: HTTP ${response.status} ${await response.text()}`);
  }

  private async scheduleOutboxUrl(client: DAVClient): Promise<string> {
    const resolved = resolveAccount(this.account);
    const principalUrl = new URL(`/principals/users/${this.account.primaryEmail.toLowerCase()}/`, resolved.caldavUrl).href;
    const responses = await client.propfind({ url: principalUrl, depth: "0", props: { "c:schedule-outbox-URL": {} } });
    const href = responses.find((response) => response.ok)?.props?.scheduleOutboxURL?.href;
    if (typeof href !== "string" || !href) throw new Error("CalDAV server does not expose a scheduling outbox.");
    return new URL(href, principalUrl).href;
  }

  async deleteEvent(url: string, etag?: string): Promise<void> {
    const client = await this.getClient();
    const response = await client.deleteCalendarObject({ calendarObject: { url, etag: etag ?? "" } as DAVCalendarObject });
    if (!response.ok && response.status !== 404) {
      throw new Error(`CalDAV server rejected event deletion: HTTP ${response.status}`);
    }
    this.invalidateEventCache();
  }
}
