-- ============================================================================
-- Foreman — Phase 1 · Grants
--
-- RLS decides which ROWS a role may see. Grants decide whether it may touch the
-- table at all. They are independent, and both must allow an operation.
--
-- This file exists because Supabase's default privileges for newly created
-- tables do NOT include select/insert/update/delete — a fresh table lands with
-- only REFERENCES, TRIGGER and TRUNCATE. Without the grants below, every query
-- fails with "permission denied for table ..." no matter how correct the
-- policies are.
--
-- The matrix deliberately mirrors the policies rather than granting broadly and
-- leaning on RLS alone. A table with only a SELECT policy gets only SELECT, so
-- both layers must independently agree before a row moves. Where they disagree,
-- the stricter one wins and the mistake surfaces as a loud error rather than a
-- silent data leak.
-- ============================================================================

grant usage on schema public to anon, authenticated, service_role;

-- ── service_role ────────────────────────────────────────────────────────────
-- The server-side identity behind SUPABASE_SECRET_KEY. Bypasses RLS by design;
-- this is the only role that may reach ms_connections (SPEC §3).

grant select, insert, update, delete on all tables in schema public to service_role;

-- ── anon ────────────────────────────────────────────────────────────────────
-- Intentionally granted nothing. Every screen in Foreman sits behind a login,
-- no table carries an `anon` policy, and sign-in runs through GoTrue rather
-- than PostgREST. An unauthenticated caller has no reason to reach any table.

-- ── authenticated ───────────────────────────────────────────────────────────

-- Read-only: creating an org and its first membership is a chicken-and-egg
-- problem that onboarding solves server-side in Phase 2.
grant select on public.orgs to authenticated;
grant select on public.memberships to authenticated;

-- The scheduling surface the app actually edits.
grant select, insert, update, delete on public.projects to authenticated;
grant select, insert, update, delete on public.tasks to authenticated;
grant select, insert, update, delete on public.task_deps to authenticated;
grant select, insert, update, delete on public.contacts to authenticated;
grant select, insert, update, delete on public.assignments to authenticated;
grant select, insert, update, delete on public.work_calendars to authenticated;
grant select, insert, update, delete on public.holidays to authenticated;

-- The Outbox is editable before send (SPEC §7).
grant select, insert, update, delete on public.outbound_messages to authenticated;

-- Append-only: no update, no delete. Matches the policies and the trigger.
grant select, insert on public.change_log to authenticated;

-- ── ms_connections ──────────────────────────────────────────────────────────
-- Re-revoked last, because `grant ... on all tables` above would otherwise have
-- swept it up. Encrypted refresh tokens are server-side only, and this table
-- has zero policies to match (SPEC §3).

revoke all on public.ms_connections from anon, authenticated;
