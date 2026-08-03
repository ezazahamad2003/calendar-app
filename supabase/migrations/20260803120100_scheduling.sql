-- ============================================================================
-- Foreman — Phase 1 · Scheduling
--
-- projects, tasks, task_deps, contacts, assignments. See SPEC §3 "Scheduling".
--
-- Cross-org integrity: every table carries `org_id` AND a `unique (org_id, id)`,
-- so child rows reference parents by the *composite* key. A task therefore
-- cannot belong to another org's project, and a dependency cannot span two orgs
-- — enforced by the key itself, not by a policy or a trigger. RLS stops you
-- reading across the boundary; this stops the row existing in the first place.
-- ============================================================================

create type public.project_status as enum ('active', 'complete', 'on_hold');
create type public.task_status    as enum ('planned', 'active', 'blocked', 'done');
create type public.dep_type       as enum ('FS', 'SS', 'FF', 'SF');

-- ── projects ────────────────────────────────────────────────────────────────

create table public.projects (
  id          uuid primary key default gen_random_uuid(),
  org_id      uuid not null references public.orgs (id) on delete cascade,
  name        text not null check (length(trim(name)) > 0),
  job_number  text,
  client_name text,
  address     text,
  status      public.project_status not null default 'active',
  starts_on   date,
  meta        jsonb not null default '{}'::jsonb,
  created_at  timestamptz not null default now(),
  unique (org_id, id)
);

create index projects_org_id_idx on public.projects (org_id);
create index projects_org_status_idx on public.projects (org_id, status);

-- ── tasks ───────────────────────────────────────────────────────────────────

create table public.tasks (
  id            uuid primary key default gen_random_uuid(),
  org_id        uuid not null references public.orgs (id) on delete cascade,
  project_id    uuid not null,
  name          text not null check (length(trim(name)) > 0),
  trade         text,

  -- Real date columns, never JSONB: the Gantt and the month grid filter and
  -- sort on these (SPEC §3).
  start_date    date,
  -- Derived finish, written by the date engine (SPEC §4). Not computable as a
  -- generated column — work-day arithmetic needs the org's calendar and its
  -- holidays, which live in another table.
  end_date      date,

  -- WORK days, never calendar days (SPEC §3). 0 is legal and means a milestone.
  duration_days integer not null default 1 check (duration_days >= 0),

  status        public.task_status not null default 'planned',
  notes         text,
  is_milestone  boolean not null default false,
  sort_order    integer not null default 0,
  meta          jsonb not null default '{}'::jsonb,
  created_at    timestamptz not null default now(),

  constraint tasks_end_after_start check (
    start_date is null or end_date is null or end_date >= start_date
  ),
  foreign key (org_id, project_id) references public.projects (org_id, id) on delete cascade,
  unique (org_id, id)
);

create index tasks_project_id_idx on public.tasks (project_id);
create index tasks_org_start_date_idx on public.tasks (org_id, start_date);
create index tasks_project_sort_idx on public.tasks (project_id, sort_order);

-- ── task_deps ───────────────────────────────────────────────────────────────

create table public.task_deps (
  id             uuid primary key default gen_random_uuid(),
  org_id         uuid not null references public.orgs (id) on delete cascade,
  predecessor_id uuid not null,
  successor_id   uuid not null,
  dep_type       public.dep_type not null default 'FS',
  -- Negative lag is legal: a successor may overlap its predecessor (SPEC §4).
  lag_days       integer not null default 0,
  created_at     timestamptz not null default now(),

  constraint task_deps_no_self_reference check (predecessor_id <> successor_id),
  unique (predecessor_id, successor_id),
  foreign key (org_id, predecessor_id) references public.tasks (org_id, id) on delete cascade,
  foreign key (org_id, successor_id)   references public.tasks (org_id, id) on delete cascade
);

create index task_deps_successor_idx on public.task_deps (successor_id);
create index task_deps_predecessor_idx on public.task_deps (predecessor_id);

comment on constraint task_deps_no_self_reference on public.task_deps is
  'Blocks the trivial 1-cycle. Longer cycles are rejected at write time by detectCycle() (SPEC §4).';

-- ── contacts ────────────────────────────────────────────────────────────────

create table public.contacts (
  id         uuid primary key default gen_random_uuid(),
  org_id     uuid not null references public.orgs (id) on delete cascade,
  name       text not null check (length(trim(name)) > 0),
  company    text,
  trade      text,
  email      text,
  phone      text,
  meta       jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  unique (org_id, id)
);

create index contacts_org_id_idx on public.contacts (org_id);
create index contacts_org_trade_idx on public.contacts (org_id, trade);

-- ── assignments ─────────────────────────────────────────────────────────────

create table public.assignments (
  id         uuid primary key default gen_random_uuid(),
  org_id     uuid not null references public.orgs (id) on delete cascade,
  task_id    uuid not null,
  contact_id uuid not null,
  role       text,
  created_at timestamptz not null default now(),

  unique (task_id, contact_id),
  foreign key (org_id, task_id)    references public.tasks (org_id, id) on delete cascade,
  foreign key (org_id, contact_id) references public.contacts (org_id, id) on delete cascade
);

create index assignments_contact_idx on public.assignments (contact_id);
create index assignments_task_idx on public.assignments (task_id);

-- ── RLS ─────────────────────────────────────────────────────────────────────
--
-- Full CRUD for members of the owning org. Mutations still run through server
-- actions (SPEC §8), but those act with the *user's* session, not the secret
-- key — so these policies are load-bearing, not decoration.
--
-- `org_id in (select public.auth_org_ids())` is wrapped in a scalar subquery so
-- the planner evaluates it once per statement rather than once per row.

do $$
declare
  t text;
begin
  foreach t in array array['projects', 'tasks', 'task_deps', 'contacts', 'assignments']
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
