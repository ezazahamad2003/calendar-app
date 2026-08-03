-- ============================================================================
-- Foreman — Phase 1 · Work calendar
--
-- work_calendars + holidays. See SPEC §3 "Work calendar".
--
-- Every date computation resolves against the org's calendar (SPEC §4). A task
-- starting Friday with 3 work days finishes Tuesday.
-- ============================================================================

create table public.work_calendars (
  id           uuid primary key default gen_random_uuid(),
  org_id       uuid not null references public.orgs (id) on delete cascade,
  name         text not null check (length(trim(name)) > 0),

  -- ISO weekday numbers, 1=Mon .. 7=Sun. Default Mon–Fri (SPEC §3).
  working_days integer[] not null default '{1,2,3,4,5}',

  created_at   timestamptz not null default now(),

  -- An empty or out-of-range set would send addWorkDays() into an infinite
  -- search for the next working day. Cheap to forbid here; expensive to debug
  -- from a hung request.
  constraint work_calendars_working_days_valid check (
    cardinality(working_days) between 1 and 7
    and working_days <@ array[1, 2, 3, 4, 5, 6, 7]
  ),
  unique (org_id, id)
);

create index work_calendars_org_id_idx on public.work_calendars (org_id);

create table public.holidays (
  id          uuid primary key default gen_random_uuid(),
  org_id      uuid not null references public.orgs (id) on delete cascade,
  calendar_id uuid not null,
  "date"      date not null,
  label       text,
  created_at  timestamptz not null default now(),

  unique (calendar_id, "date"),
  foreign key (org_id, calendar_id)
    references public.work_calendars (org_id, id) on delete cascade
);

create index holidays_calendar_date_idx on public.holidays (calendar_id, "date");

-- ── RLS ─────────────────────────────────────────────────────────────────────

do $$
declare
  t text;
begin
  foreach t in array array['work_calendars', 'holidays']
  loop
    execute format('alter table public.%I enable row level security', t);

    execute format($p$
      create policy %I on public.%I
        for select to authenticated
        using (org_id in (select public.auth_org_ids()))
    $p$, t || '_select_member', t);

    execute format($p$
      create policy %I on public.%I
        for insert to authenticated
        with check (org_id in (select public.auth_org_ids()))
    $p$, t || '_insert_member', t);

    execute format($p$
      create policy %I on public.%I
        for update to authenticated
        using (org_id in (select public.auth_org_ids()))
        with check (org_id in (select public.auth_org_ids()))
    $p$, t || '_update_member', t);

    execute format($p$
      create policy %I on public.%I
        for delete to authenticated
        using (org_id in (select public.auth_org_ids()))
    $p$, t || '_delete_member', t);
  end loop;
end $$;
