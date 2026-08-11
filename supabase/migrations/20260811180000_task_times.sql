-- ============================================================================
-- Foreman — Phase 10a · Times of day
--
-- Until now a task was a run of whole days and nothing else, so the calendar
-- could only ever be a list of names under a date. "Concrete pour at 6am,
-- inspection at 2" is an ordinary thing for a contractor to say and the app had
-- nowhere to put it — the assistant's stock answer was to schedule the day and
-- apologise for dropping the time.
--
-- The model is a DAILY WINDOW, not an instant-to-instant span: a task that runs
-- Monday to Wednesday 07:00–15:30 is on site at those hours on each of those
-- days. That is how trades are actually booked, and it is why `end_time` is
-- always later than `start_time` — the pair describes one day's shift, and the
-- date range says how many days it repeats for.
--
-- Both NULL is the all-day case and stays the default: duration_days remains
-- the unit the schedule engine cascades on. Times are presentation and
-- coordination, never arithmetic — nothing in lib/schedule reads these columns.
-- ============================================================================

alter table public.tasks
  add column start_time time,
  add column end_time   time;

-- An end without a start has nothing to anchor it: it would render as a block
-- of unknown length, and every consumer would need a branch for a state that
-- means nothing to anyone.
alter table public.tasks
  add constraint tasks_end_time_needs_start check (
    end_time is null or start_time is not null
  );

alter table public.tasks
  add constraint tasks_time_order check (
    start_time is null or end_time is null or end_time > start_time
  );

comment on column public.tasks.start_time is
  'Local start of the daily on-site window, org timezone. NULL = all-day, which is the default and still the common case.';

comment on column public.tasks.end_time is
  'Local end of the same day''s window. Always later than start_time: a task spanning several days repeats this window on each of them rather than running through the night.';

-- The calendar reads a window of days and then lays the timed ones out by
-- hour, so the ordering it wants is (org, date, time).
create index tasks_org_start_idx on public.tasks (org_id, start_date, start_time);
