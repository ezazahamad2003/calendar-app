import Link from "next/link";

import { requireMembership } from "@/lib/auth/dal";
import { tasksOverlapping } from "@/lib/org/queries";
import { todayInZone } from "@/lib/schedule";
import { monthGrid } from "@/lib/month";
import { tradeColor } from "@/lib/trades";

/** Month calendar (SPEC §7): everything active on each day, org-wide. */
export default async function CalendarPage({
  searchParams,
}: {
  searchParams: Promise<{ m?: string }>;
}) {
  const { m: monthParam } = await searchParams;
  const membership = await requireMembership();
  const today = todayInZone(membership.timezone);

  const month =
    monthParam && /^\d{4}-(0[1-9]|1[0-2])$/.test(monthParam)
      ? monthParam
      : today.slice(0, 7);
  const grid = monthGrid(month);

  const tasks = await tasksOverlapping(membership.orgId, grid.firstDay, grid.lastDay);

  const byDay = new Map<string, typeof tasks>();
  for (const t of tasks) {
    if (!t.start_date || !t.end_date) continue;
    for (const week of grid.weeks) {
      for (const day of week) {
        if (day >= t.start_date && day <= t.end_date) {
          const list = byDay.get(day);
          if (list) list.push(t);
          else byDay.set(day, [t]);
        }
      }
    }
  }

  return (
    <main className="page">
      <header className="page-head">
        <div>
          <p className="page-eyebrow">{membership.orgName}</p>
          <h1 className="page-title">{grid.label}</h1>
        </div>
        <nav className="zoom" aria-label="Month navigation">
          <Link className="zoom-link" href={`/calendar?m=${grid.prevMonth}`}>
            ← prev
          </Link>
          <Link className="zoom-link" href={`/calendar?m=${today.slice(0, 7)}`}>
            today
          </Link>
          <Link className="zoom-link" href={`/calendar?m=${grid.nextMonth}`}>
            next →
          </Link>
        </nav>
      </header>

      <div className="cal">
        {["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"].map((d) => (
          <span key={d} className="cal-dow">
            {d}
          </span>
        ))}
        {grid.weeks.flat().map((day) => {
          const inMonth = day.slice(0, 7) === grid.month;
          const list = byDay.get(day) ?? [];
          const shown = list.slice(0, 3);
          return (
            <div
              key={day}
              className={[
                "cal-day",
                inMonth ? "" : "cal-day--out",
                day === today ? "cal-day--today" : "",
              ].join(" ")}
            >
              <span className="cal-date">{Number(day.slice(8, 10))}</span>
              {shown.map((t) => {
                const color = tradeColor(t.trade);
                return (
                  <Link
                    key={`${t.id}-${day}`}
                    href={`/projects/${t.project_id}`}
                    className="cal-chip"
                    style={{ background: color.fill, color: color.text }}
                    title={`${t.name} — ${t.project_name}`}
                  >
                    {t.is_milestone ? "◆ " : ""}
                    {t.name}
                  </Link>
                );
              })}
              {list.length > shown.length ? (
                <span className="cal-more">+{list.length - shown.length} more</span>
              ) : null}
            </div>
          );
        })}
      </div>
    </main>
  );
}
