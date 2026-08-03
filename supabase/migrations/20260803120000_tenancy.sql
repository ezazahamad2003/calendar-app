-- ============================================================================
-- Foreman — Phase 1 · Tenancy
--
-- orgs + memberships, and the `auth_org_ids()` helper every other policy in the
-- schema is built on. See SPEC §3 "Tenancy".
--
-- A user reaches data only through `memberships`. Nothing else grants access.
-- ============================================================================

create type public.org_role as enum ('owner', 'admin', 'member');

-- ── orgs ────────────────────────────────────────────────────────────────────

create table public.orgs (
  id           uuid primary key default gen_random_uuid(),
  name         text not null check (length(trim(name)) > 0),
  company_name text,
  -- IANA zone. Every date computation resolves against this (SPEC §4): a wrong
  -- zone is exactly the UTC-drift off-by-one that makes a contractor stop
  -- trusting the app, so onboarding must set it deliberately rather than
  -- inherit a guess.
  timezone     text not null default 'UTC',
  created_at   timestamptz not null default now()
);

-- ── memberships ─────────────────────────────────────────────────────────────

create table public.memberships (
  id         uuid primary key default gen_random_uuid(),
  org_id     uuid not null references public.orgs (id) on delete cascade,
  user_id    uuid not null references auth.users (id) on delete cascade,
  role       public.org_role not null default 'member',
  created_at timestamptz not null default now(),
  unique (org_id, user_id)
);

create index memberships_user_id_idx on public.memberships (user_id);
create index memberships_org_id_idx on public.memberships (org_id);

-- ── auth_org_ids() ──────────────────────────────────────────────────────────
--
-- SECURITY DEFINER on purpose. A policy on `memberships` that subqueries
-- `memberships` recurses; running as the owner sidesteps RLS and terminates.
--
-- `search_path = ''` closes the classic definer-function hijack, where a caller
-- puts a lookalike `memberships` on their own search_path. Everything below is
-- therefore schema-qualified.
--
-- Do NOT add `force row level security` to `memberships` — that would re-apply
-- RLS to the owner and reintroduce the recursion this exists to avoid.

create or replace function public.auth_org_ids()
returns setof uuid
language sql
stable
security definer
set search_path = ''
as $$
  select m.org_id
  from public.memberships m
  where m.user_id = (select auth.uid())
$$;

revoke all on function public.auth_org_ids() from public;
grant execute on function public.auth_org_ids() to authenticated;

comment on function public.auth_org_ids() is
  'Org ids the calling user belongs to. SECURITY DEFINER to avoid RLS recursion on memberships.';

-- ── RLS ─────────────────────────────────────────────────────────────────────
--
-- Read-only from the client. Creating an org and its first membership is a
-- chicken-and-egg problem — at that instant `auth_org_ids()` is empty, so no
-- sane policy admits the insert. Rather than widen the policy (which would let
-- any user insert a membership into someone else's org and read their data),
-- onboarding runs server-side with the secret key in Phase 2.

alter table public.orgs enable row level security;
alter table public.memberships enable row level security;

create policy orgs_select_member on public.orgs
  for select to authenticated
  using (id in (select public.auth_org_ids()));

create policy memberships_select_member on public.memberships
  for select to authenticated
  using (org_id in (select public.auth_org_ids()));
