-- ============================================================================
-- Foreman — Phase 1 · Microsoft connections + audit
--
-- ms_connections, outbound_messages, change_log. See SPEC §3 "Microsoft + audit".
-- ============================================================================

create type public.ms_connection_status as enum ('active', 'needs_reauth');
create type public.message_channel      as enum ('email', 'calendar');
create type public.message_status       as enum ('draft', 'queued', 'sent', 'failed');
create type public.change_source        as enum ('voice', 'ui', 'system');

-- ── ms_connections ──────────────────────────────────────────────────────────
--
-- Holds an AES-256-GCM encrypted Microsoft refresh token. A leak here is a
-- full mailbox and calendar compromise for a real business.
--
-- SPEC §3: "No RLS policy may ever expose ms_connections to the client role."
-- Enforced twice over, because one layer is not enough for this table:
--   1. RLS is enabled with ZERO policies — deny-by-default for every role that
--      is not BYPASSRLS.
--   2. The grants themselves are revoked from anon/authenticated, so even a
--      future migration that mistakenly adds a permissive policy still yields
--      no access.
-- Reach this table only server-side via the secret key (service_role).

create table public.ms_connections (
  id                      uuid primary key default gen_random_uuid(),
  org_id                  uuid not null references public.orgs (id) on delete cascade,
  user_id                 uuid not null references auth.users (id) on delete cascade,
  ms_user_id              text,
  email                   text,
  refresh_token_encrypted text,
  scopes                  text[] not null default '{}',
  connected_at            timestamptz not null default now(),
  last_refreshed_at       timestamptz,
  status                  public.ms_connection_status not null default 'active',
  unique (org_id, user_id)
);

create index ms_connections_org_id_idx on public.ms_connections (org_id);

alter table public.ms_connections enable row level security;
-- Deliberately no policies. Do not add any.

revoke all on public.ms_connections from anon, authenticated;

comment on table public.ms_connections is
  'Encrypted Microsoft refresh tokens. Server-side/service_role only — RLS enabled with no policies AND grants revoked. Never add a client-facing policy (SPEC §3).';

-- ── outbound_messages ───────────────────────────────────────────────────────

create table public.outbound_messages (
  id              uuid primary key default gen_random_uuid(),
  org_id          uuid not null references public.orgs (id) on delete cascade,
  task_id         uuid,
  contact_id      uuid,
  channel         public.message_channel not null,
  subject         text,
  body            text,
  status          public.message_status not null default 'draft',

  -- Written BEFORE the Graph call, checked on retry (SPEC §6). A duplicate
  -- invite to a subcontractor is a support call. NULL is allowed so a draft can
  -- exist before it is queued; Postgres does not collide NULLs in a unique index.
  idempotency_key text unique,

  ms_message_id   text,
  ms_event_id     text,
  error           text,
  created_at      timestamptz not null default now(),
  sent_at         timestamptz,

  -- A sent message outlives the task or contact it referred to — deleting a
  -- task must not erase the record that an email went out.
  --
  -- The trailing column list is load-bearing: a plain ON DELETE SET NULL on a
  -- composite key nulls *every* referencing column, org_id included, which is
  -- NOT NULL — so deleting a task would fail on a not-null violation instead.
  -- Narrowing it to the child column keeps org_id intact. (PostgreSQL 15+.)
  foreign key (org_id, task_id)
    references public.tasks (org_id, id) on delete set null (task_id),
  foreign key (org_id, contact_id)
    references public.contacts (org_id, id) on delete set null (contact_id)
);

create index outbound_messages_org_status_idx on public.outbound_messages (org_id, status);
create index outbound_messages_task_idx on public.outbound_messages (task_id);

alter table public.outbound_messages enable row level security;

create policy outbound_messages_select_member on public.outbound_messages
  for select to authenticated
  using (org_id in (select public.auth_org_ids()));

create policy outbound_messages_insert_member on public.outbound_messages
  for insert to authenticated
  with check (org_id in (select public.auth_org_ids()));

-- The Outbox is editable before send (SPEC §7).
create policy outbound_messages_update_member on public.outbound_messages
  for update to authenticated
  using (org_id in (select public.auth_org_ids()))
  with check (org_id in (select public.auth_org_ids()));

create policy outbound_messages_delete_member on public.outbound_messages
  for delete to authenticated
  using (org_id in (select public.auth_org_ids()));

-- ── change_log ──────────────────────────────────────────────────────────────
--
-- SPEC §3: append-only, and "a product feature, not debug logging" — this is
-- the record that settles a date dispute with a subcontractor. So it has to
-- resist the application itself, not just the client.
--
-- `actor_user_id` and `entity_id` are intentionally bare uuids with no foreign
-- key. An audit row records who did what at a point in time; deleting the user
-- account later must not rewrite or erase that history. (A FK with ON DELETE
-- SET NULL would issue an UPDATE, which the append-only trigger below rejects
-- anyway — so the account deletion would fail instead.)

create table public.change_log (
  id             uuid primary key default gen_random_uuid(),
  org_id         uuid not null references public.orgs (id) on delete cascade,
  actor_user_id  uuid,
  entity_type    text not null,
  entity_id      uuid,
  action         text not null,
  "before"       jsonb,
  "after"        jsonb,
  source         public.change_source not null default 'ui',
  transcript     text,
  created_at     timestamptz not null default now()
);

create index change_log_org_created_idx on public.change_log (org_id, created_at desc);
create index change_log_entity_idx on public.change_log (entity_type, entity_id);

create or replace function public.change_log_append_only()
returns trigger
language plpgsql
as $$
begin
  raise exception 'change_log is append-only; % is not permitted', tg_op
    using errcode = 'restrict_violation',
          hint = 'Record a correction as a new change_log row. Never edit history.';
end
$$;

-- Applies to every role, service_role included. Deleting an org will therefore
-- fail on the cascade rather than silently shredding its audit trail; purging
-- history has to be a deliberate act, not a side effect.
create trigger change_log_block_update
  before update on public.change_log
  for each row execute function public.change_log_append_only();

create trigger change_log_block_delete
  before delete on public.change_log
  for each row execute function public.change_log_append_only();

alter table public.change_log enable row level security;

-- Read and append only. The absence of UPDATE/DELETE policies is the point.
create policy change_log_select_member on public.change_log
  for select to authenticated
  using (org_id in (select public.auth_org_ids()));

create policy change_log_insert_member on public.change_log
  for insert to authenticated
  with check (org_id in (select public.auth_org_ids()));

comment on table public.change_log is
  'Append-only audit trail (SPEC §3). Enforced by trigger for all roles, not just RLS.';
