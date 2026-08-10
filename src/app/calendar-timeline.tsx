"use client";

import { useEffect, useMemo, useRef } from "react";

type Project = { id: string; name: string; location: string; color: string };
type Person = { id: string; name: string; email: string; role: string; initials: string };
type ScheduleEvent = { id: string; title: string; projectId: string; assigneeIds: string[]; date: string; startTime: string; durationMinutes: number; trade: string; notes: string; createdAt: string };

const HOUR_HEIGHT = 58;
const HOURS = Array.from({ length: 24 }, (_, index) => index);

function dateKey(date: Date) {
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, "0")}-${String(date.getDate()).padStart(2, "0")}`;
}

function weekDays(cursor: Date) {
  const start = new Date(cursor);
  start.setHours(12, 0, 0, 0);
  start.setDate(start.getDate() - ((start.getDay() + 6) % 7));
  return Array.from({ length: 7 }, (_, index) => {
    const date = new Date(start);
    date.setDate(start.getDate() + index);
    return date;
  });
}

function timeLabel(hour: number) {
  if (hour === 0) return "12 AM";
  if (hour === 12) return "12 PM";
  return `${hour % 12} ${hour < 12 ? "AM" : "PM"}`;
}

function minutes(value: string) {
  const [hour, minute] = value.split(":").map(Number);
  return hour * 60 + minute;
}

function displayTime(totalMinutes: number) {
  const safe = ((totalMinutes % 1440) + 1440) % 1440;
  const hour = Math.floor(safe / 60);
  const minute = safe % 60;
  return `${hour % 12 || 12}${minute ? `:${String(minute).padStart(2, "0")}` : ""} ${hour >= 12 ? "PM" : "AM"}`;
}

function timezoneLabel(timezone: string) {
  return new Intl.DateTimeFormat("en-US", { timeZone: timezone, timeZoneName: "shortOffset" })
    .formatToParts(new Date())
    .find((part) => part.type === "timeZoneName")?.value ?? timezone;
}

export default function CalendarTimeline({
  mode,
  cursor,
  events,
  projects,
  people,
  timezone,
  onSelect,
}: {
  mode: "day" | "week";
  cursor: Date;
  events: ScheduleEvent[];
  projects: Map<string, Project>;
  people: Map<string, Person>;
  timezone: string;
  onSelect: (event: ScheduleEvent) => void;
}) {
  const scrollerRef = useRef<HTMLDivElement>(null);
  const days = useMemo(() => mode === "week" ? weekDays(cursor) : [new Date(cursor)], [cursor, mode]);
  const today = dateKey(new Date());
  const now = new Date();
  const nowTop = ((now.getHours() * 60 + now.getMinutes()) / 60) * HOUR_HEIGHT;

  useEffect(() => {
    if (scrollerRef.current) scrollerRef.current.scrollTop = 6.5 * HOUR_HEIGHT;
  }, [mode, cursor]);

  return (
    <div className={`time-calendar ${mode}`}>
      <div className="time-calendar-head" style={{ "--day-count": days.length } as React.CSSProperties}>
        <div className="timezone-cell">{timezoneLabel(timezone)}</div>
        {days.map((day) => {
          const key = dateKey(day);
          return (
            <div className={key === today ? "timeline-day-head current" : "timeline-day-head"} key={key}>
              <span>{day.toLocaleDateString("en-US", { weekday: "short" })}</span>
              <strong>{day.getDate()}</strong>
              {mode === "day" && <small>{day.toLocaleDateString("en-US", { month: "long", year: "numeric" })}</small>}
            </div>
          );
        })}
      </div>

      <div className="time-calendar-scroll" ref={scrollerRef}>
        <div className="time-calendar-body" style={{ height: HOUR_HEIGHT * 24 }}>
          <div className="time-labels">
            {HOURS.map((hour) => <time key={hour} style={{ top: hour * HOUR_HEIGHT }}>{timeLabel(hour)}</time>)}
          </div>
          <div className="timeline-columns" style={{ "--day-count": days.length, "--hour-height": `${HOUR_HEIGHT}px` } as React.CSSProperties}>
            {days.map((day) => {
              const key = dateKey(day);
              const dayEvents = events.filter((event) => event.date === key);
              return (
                <div className={key === today ? "timeline-column current" : "timeline-column"} key={key}>
                  {key === today && <div className="current-time-line" style={{ top: nowTop }}><i /></div>}
                  {dayEvents.map((event) => {
                    const start = minutes(event.startTime);
                    const end = start + event.durationMinutes;
                    const project = projects.get(event.projectId);
                    const crew = event.assigneeIds.map((id) => people.get(id)?.name.split(" ")[0]).filter(Boolean).join(", ");
                    return (
                      <button
                        className="timeline-event"
                        key={event.id}
                        onClick={() => onSelect(event)}
                        style={{
                          top: (start / 60) * HOUR_HEIGHT + 2,
                          height: Math.max((event.durationMinutes / 60) * HOUR_HEIGHT - 4, 25),
                          "--event-color": project?.color ?? "#447a72",
                        } as React.CSSProperties}
                        aria-label={`Open ${event.title}, ${displayTime(start)} to ${displayTime(end)}`}
                      >
                        <strong>{event.title}</strong>
                        <span>{displayTime(start)} – {displayTime(end)}</span>
                        {event.durationMinutes >= 75 && <small>{crew || "Unassigned"}</small>}
                      </button>
                    );
                  })}
                </div>
              );
            })}
          </div>
        </div>
      </div>
    </div>
  );
}
