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
  /** True when this object represents a recurring series. Updating it changes every occurrence. */
  isRecurring: boolean;
  location?: string;
  description?: string;
  organizer?: string;
  status?: string;
  /** A transparent event does not block availability. */
  transparent: boolean;
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
  /** ETag returned by calendar-list/get; prevents overwriting a newer change. */
  etag: string;
  /** Required to update a recurring series rather than a single non-recurring event. */
  allowSeriesUpdate?: boolean;
}

export interface CalendarInfo {
  url: string;
  displayName?: string;
  description?: string;
}

function assertDateRange(start: Date, end: Date): void {
  if (Number.isNaN(start.getTime()) || Number.isNaN(end.getTime()) || end <= start) {
    throw new Error("Event end must be after its start, and both must be valid dates.");
  }
}

function timezoneParts(date: Date, timezone: string): Record<string, number> {
  const parts = new Intl.DateTimeFormat("en-CA", { timeZone: timezone, year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", hourCycle: "h23" }).formatToParts(date);
  return Object.fromEntries(parts.filter((part) => part.type !== "literal").map((part) => [part.type, Number(part.value)]));
}

/** Convert a calendar date in an account timezone to its corresponding absolute midnight. */
export function accountMidnight(year: number, month: number, day: number, timezone: string): Date {
  const wanted = Date.UTC(year, month - 1, day);
  let instant = wanted;
  for (let i = 0; i < 3; i++) {
    const actual = timezoneParts(new Date(instant), timezone);
    const offset = wanted - Date.UTC(actual.year, actual.month - 1, actual.day, actual.hour, actual.minute);
    if (offset === 0) break;
    instant += offset;
  }
  return new Date(instant);
}

function timeToDate(time: ICAL.Time, timezone: string): Date {
  return time.isDate ? accountMidnight(time.year, time.month, time.day, timezone) : time.toJSDate();
}

function nextDate(time: ICAL.Time): ICAL.Time {
  const date = new Date(Date.UTC(time.year, time.month - 1, time.day + 1));
  return ICAL.Time.fromData({ year: date.getUTCFullYear(), month: date.getUTCMonth() + 1, day: date.getUTCDate(), isDate: true });
}

export function icalDate(date: Date, allDay: boolean, timezone?: string): ICAL.Time {
  if (allDay) {
    if (!timezone) throw new Error("Account timezone is required for an all-day event.");
    const parts = new Intl.DateTimeFormat("en-CA", { timeZone: timezone, year: "numeric", month: "2-digit", day: "2-digit" }).formatToParts(date);
    const values = Object.fromEntries(parts.filter((part) => part.type !== "literal").map((part) => [part.type, Number(part.value)]));
    return ICAL.Time.fromData({ year: values.year, month: values.month, day: values.day, isDate: true });
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

/** Reject server-supplied outbox URLs before credentials are attached to a request. */
export function trustedSchedulingOutboxUrl(href: string, principalUrl: string, configuredCaldavUrl: string): string {
  const outboxUrl = new URL(href, principalUrl);
  const configuredUrl = new URL(configuredCaldavUrl);
  if (outboxUrl.protocol !== "https:" || outboxUrl.origin !== configuredUrl.origin) {
    throw new Error("CalDAV server returned a scheduling outbox outside the configured HTTPS origin.");
  }
  return outboxUrl.href;
}

/** Ensure a destructive request stays inside a selected, accessible calendar collection. */
export function trustedCalendarObjectUrl(value: string, calendarUrl: string): string {
  const calendar = new URL(calendarUrl);
  const object = new URL(value, calendar);
  const calendarPath = calendar.pathname.endsWith("/") ? calendar.pathname : `${calendar.pathname}/`;
  if (object.protocol !== "https:" || object.origin !== calendar.origin || !object.pathname.startsWith(calendarPath)) {
    throw new Error("Calendar event URL is outside the selected HTTPS calendar.");
  }
  return object.href;
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
    const key = `${calendar.url}:${start.getTime()}:${end.getTime()}`;
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
    } catch (error) {
      throw new Error(`Unable to parse calendar event ${obj.url}: ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  /** Expand a single VEVENT (recurring or not) into concrete occurrences overlapping [rangeStart, rangeEnd]. */
  private expandVevent(vevent: ICAL.Component, obj: DAVCalendarObject, rangeStart: Date, rangeEnd: Date): CalendarEvent[] {
    const event = new ICAL.Event(vevent);
    const toEvent = (uid: string, summary: string | undefined, start: Date, end: Date, allDay: boolean, status?: string): CalendarEvent => ({
      uid,
      summary: summary || undefined,
      start: start.toISOString(),
      end: end.toISOString(),
      allDay,
      isRecurring: event.isRecurring(),
      location: event.location || undefined,
      description: event.description || undefined,
      organizer: stringifyPropertyValue(vevent.getFirstPropertyValue("organizer")),
      status: status ?? stringifyPropertyValue(vevent.getFirstPropertyValue("status")),
      transparent: stringifyPropertyValue(vevent.getFirstPropertyValue("transp")) === "TRANSPARENT",
      url: obj.url,
      etag: obj.etag,
    });

    if (!event.isRecurring()) {
      const start = timeToDate(event.startDate, this.account.timezone);
      const end = timeToDate(event.endDate, this.account.timezone);
      const status = stringifyPropertyValue(vevent.getFirstPropertyValue("status"));
      if (status === "CANCELLED" || end < rangeStart || start > rangeEnd) return [];
      return [toEvent(event.uid, event.summary, start, end, event.startDate.isDate, status)];
    }

    const results: CalendarEvent[] = [];
    const iterator = event.iterator();
    const MAX_OCCURRENCES = 10_000; // safety cap against pathological/unbounded recurrences
    for (let i = 0; i < MAX_OCCURRENCES; i++) {
      const next = iterator.next();
      if (!next) break;
      const details = event.getOccurrenceDetails(next);
      const occStart = timeToDate(details.startDate, this.account.timezone);
      const occEnd = timeToDate(details.endDate, this.account.timezone);
      if (occStart > rangeEnd) break; // occurrences are chronological; nothing further can match
      const status = stringifyPropertyValue(details.item.component.getFirstPropertyValue("status"));
      if (status === "CANCELLED") continue;
      if (occEnd >= rangeStart && occStart <= rangeEnd) {
        results.push(toEvent(event.uid, details.item.summary, occStart, occEnd, details.startDate.isDate, status));
      }
    }
    return results;
  }

  async createEvent(input: NewEvent, calendarUrl?: string): Promise<{ uid: string; url: string }> {
    assertDateRange(input.start, input.end);
    const client = await this.getClient();
    const calendar = await this.selectCalendar(calendarUrl);
    const uid = `${randomUUID()}@groupware`;
    const url = await this.storeEvent(calendar, client, uid, this.eventIcs(input, uid));
    return { uid, url };
  }

  async getEvent(url: string, calendarUrl?: string): Promise<CalendarEvent> {
    const calendar = await this.selectCalendar(calendarUrl);
    const client = await this.getClient();
    const safeUrl = trustedCalendarObjectUrl(url, calendar.url);
    const objects = await client.fetchCalendarObjects({ calendar, objectUrls: [safeUrl], urlFilter: () => true });
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
    const safeUrl = trustedCalendarObjectUrl(input.url, calendar.url);
    const objects = await client.fetchCalendarObjects({ calendar, objectUrls: [safeUrl], urlFilter: () => true });
    const object = objects[0];
    if (!object?.data) throw new Error("Calendar event not found.");
    const component = new ICAL.Component(ICAL.parse(object.data));
    const event = component.getFirstSubcomponent("vevent");
    if (!event) throw new Error("Calendar object has no VEVENT.");
    const existingEvent = new ICAL.Event(event);
    if (existingEvent.isRecurring() && !input.allowSeriesUpdate) {
      throw new Error("This is a recurring series. Refusing to change every occurrence without allowSeriesUpdate:true.");
    }
    const existingStart = timeToDate(existingEvent.startDate, this.account.timezone);
    const existingEnd = timeToDate(existingEvent.endDate, this.account.timezone);
    if (input.start || input.end) assertDateRange(input.start ?? existingStart, input.end ?? existingEnd);
    const set = (name: string, value: string | undefined) => {
      if (value === undefined) return;
      if (value) event.updatePropertyWithValue(name, value); else event.removeAllProperties(name);
    };
    set("summary", input.summary);
    set("location", input.location);
    set("description", input.description);
    const allDay = input.allDay ?? existingEvent.startDate.isDate;
    // A type change must rewrite both values: otherwise a DATE and DATE-TIME
    // can be mixed, or an allDay-only request can appear to succeed unchanged.
    if (input.allDay !== undefined) {
      const start = input.start ?? existingStart;
      const end = input.end ?? existingEnd;
      let startValue = icalDate(start, allDay, this.account.timezone);
      let endValue = icalDate(end, allDay, this.account.timezone);
      if (allDay && endValue.compare(startValue) <= 0) endValue = nextDate(startValue);
      event.updatePropertyWithValue("dtstart", startValue);
      event.updatePropertyWithValue("dtend", endValue);
    } else {
      if (input.start) event.updatePropertyWithValue("dtstart", icalDate(input.start, allDay, this.account.timezone));
      if (input.end) event.updatePropertyWithValue("dtend", icalDate(input.end, allDay, this.account.timezone));
    }
    event.updatePropertyWithValue("dtstamp", ICAL.Time.now());
    const sequence = Number(event.getFirstPropertyValue("sequence") ?? 0);
    event.updatePropertyWithValue("sequence", Number.isFinite(sequence) ? sequence + 1 : 1);
    object.data = component.toString();
    object.url = safeUrl;
    object.etag = input.etag;
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
    assertDateRange(input.start, input.end);
    const client = await this.getClient();
    const calendar = await this.selectCalendar();
    const uid = `${randomUUID()}@groupware`;
    const localIcs = this.eventIcs(input, uid, input.attendees);
    const url = await this.storeEvent(calendar, client, uid, localIcs);

    try {
      await this.submitScheduling(client, this.eventIcs(input, uid, input.attendees, "REQUEST"), "invitation");
    } catch (error) {
      // Do not leave an organizer event behind when its invitation was not sent.
      const created = await this.getEvent(url).catch(() => undefined);
      if (created?.etag) await this.deleteEvent(url, created.etag).catch(() => undefined);
      throw error;
    }
    return { uid, url };
  }

  /** Send an iTIP accept/decline/tentative reply through the CalDAV scheduling outbox. */
  async respondToInvite(url: string, response: "accepted" | "declined" | "tentative", calendarUrl?: string): Promise<void> {
    const calendar = await this.selectCalendar(calendarUrl);
    const client = await this.getClient();
    const safeUrl = trustedCalendarObjectUrl(url, calendar.url);
    const objects = await client.fetchCalendarObjects({ calendar, objectUrls: [safeUrl], urlFilter: () => true });
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
    object.url = safeUrl;
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
    const start = icalDate(input.start, Boolean(input.allDay), this.account.timezone);
    let end = icalDate(input.end, Boolean(input.allDay), this.account.timezone);
    if (input.allDay && end.compare(start) <= 0) end = nextDate(start);
    vevent.updatePropertyWithValue("dtstart", start);
    vevent.updatePropertyWithValue("dtend", end);
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
    if (!response.ok) throw new Error(`CalDAV server rejected event creation: HTTP ${response.status}`);
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
    if (!response.ok) throw new Error(`CalDAV scheduling outbox rejected ${label}: HTTP ${response.status}`);
  }

  private async scheduleOutboxUrl(client: DAVClient): Promise<string> {
    const resolved = resolveAccount(this.account);
    const principalUrl = client.account?.principalUrl;
    if (!principalUrl) throw new Error("CalDAV client did not discover the account principal URL.");
    const responses = await client.propfind({ url: principalUrl, depth: "0", props: { "c:schedule-outbox-URL": {} } });
    const href = responses.find((response) => response.ok)?.props?.scheduleOutboxURL?.href;
    if (typeof href !== "string" || !href) throw new Error("CalDAV server does not expose a scheduling outbox.");
    return trustedSchedulingOutboxUrl(href, principalUrl, resolved.caldavUrl);
  }

  async deleteEvent(url: string, etag: string, calendarUrl?: string): Promise<void> {
    if (!etag) throw new Error("An ETag from calendar-list/get is required to delete an event.");
    const calendar = await this.selectCalendar(calendarUrl);
    const safeUrl = trustedCalendarObjectUrl(url, calendar.url);
    const client = await this.getClient();
    const response = await client.deleteCalendarObject({ calendarObject: { url: safeUrl, etag } as DAVCalendarObject });
    if (!response.ok && response.status !== 404) {
      throw new Error(`CalDAV server rejected event deletion: HTTP ${response.status}`);
    }
    this.invalidateEventCache();
  }
}
