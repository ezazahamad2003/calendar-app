-- ============================================================================
-- Foreman — Phase 8 · Two mail/calendar providers instead of one
--
-- `ms_connections` was built when Outlook was the only option: one row per
-- user, Microsoft assumed everywhere in the column names. Google (Gmail +
-- Google Calendar) is now a peer, and a user may connect either, both, or
-- neither. This migration generalises the table rather than adding a parallel
-- `google_connections` next to it — two tables holding the same encrypted
-- refresh token under different names is the shape that rots.
--
-- Nothing here weakens the Phase 1 guarantee. This table still holds refresh
-- tokens whose leak is a full mailbox compromise, so it keeps RLS-enabled-with-
-- zero-policies AND revoked grants, and it stays reachable only through the
-- secret key (SPEC §3). A rename does not carry policies or grants back in.
-- ============================================================================

-- ── Which provider a row belongs to ─────────────────────────────────────────

create type public.oauth_provider as enum ('microsoft', 'google');

-- The status enum was never Microsoft-specific in substance, only in name.
-- ('active' | 'needs_reauth' describes a dead Google grant just as well.)
alter type public.ms_connection_status rename to connection_status;

-- ── Table + columns ─────────────────────────────────────────────────────────

alter table public.ms_connections rename to provider_connections;
alter table public.provider_connections rename column ms_user_id to provider_user_id;

-- Existing rows are all Outlook connections, which is exactly what the default
-- says, so the backfill is implicit. The default is dropped afterwards: a new
-- row must name its provider rather than silently inheriting Microsoft.
alter table public.provider_connections
  add column provider public.oauth_provider not null default 'microsoft';

alter table public.provider_connections alter column provider drop default;

-- ── One primary per user, across providers ──────────────────────────────────
--
-- A user with both accounts connected still has exactly one place that mail
-- goes out from and events land in. `is_primary` is that choice; the connect
-- route sets it on the first connection and the user can move it afterwards.
--
-- Enforced as a partial unique index rather than left to application code,
-- because "two primaries" is the state where the app cannot answer "send from
-- where?" and would have to guess.

alter table public.provider_connections
  add column is_primary boolean not null default false;

update public.provider_connections set is_primary = true;

create unique index provider_connections_one_primary_idx
  on public.provider_connections (org_id, user_id)
  where is_primary;

-- ── Uniqueness widened to include the provider ──────────────────────────────
--
-- Was unique (org_id, user_id) — one connection per user, full stop. Now one
-- connection per user *per provider*, which is what makes "connect both"
-- expressible. Both callback routes upsert on this triple.

alter table public.provider_connections
  drop constraint if exists ms_connections_org_id_user_id_key;

alter table public.provider_connections
  add constraint provider_connections_org_user_provider_key
  unique (org_id, user_id, provider);

-- ── Index and comment carried over under the new name ───────────────────────

alter index ms_connections_org_id_idx rename to provider_connections_org_id_idx;

comment on table public.provider_connections is
  'Encrypted OAuth refresh tokens for Microsoft and Google. Server-side/service_role only — RLS enabled with no policies AND grants revoked. Never add a client-facing policy (SPEC §3).';

-- Re-asserted, not assumed. The revoke followed the rename, but this table is
-- the one place in the schema where a silent regression is unacceptable, and
-- re-running a revoke costs nothing.
revoke all on public.provider_connections from anon, authenticated;
