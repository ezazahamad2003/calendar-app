-- ============================================================================
-- Foreman — Phase 1 hardening
--
-- Two findings from the Supabase database linter after Phase 1 landed. Neither
-- is exploitable today; both are one line to close and both are the same class
-- of mistake the tenancy migration already guarded against.
--
-- Deliberately NOT "fixed" here:
--
--   * `ms_connections` has RLS enabled and zero policies (linter INFO
--     0008_rls_enabled_no_policy). That is the design, not an oversight —
--     SPEC §3 requires that no policy ever expose the table to the client role.
--     Adding one to silence the linter would be the bug.
--
--   * `auth_org_ids()` is executable by `authenticated` (linter WARN 0029).
--     Intentional: every RLS policy in the schema calls it.
-- ============================================================================

-- ── 1. auth_org_ids() should not be reachable by anonymous callers ──────────
--
-- The tenancy migration did `revoke all ... from public`, but Supabase grants
-- EXECUTE on new public-schema functions to `anon` and `authenticated`
-- directly, and a revoke from PUBLIC does not remove a direct grant. So the
-- function stayed callable unauthenticated via /rest/v1/rpc/auth_org_ids.
--
-- Impact was nil — `auth.uid()` is null for `anon`, so it returned an empty
-- set — but an unauthenticated, publicly-callable SECURITY DEFINER function is
-- not something to leave lying around on the assumption it stays harmless.

revoke execute on function public.auth_org_ids() from anon;

-- ── 2. Pin the append-only trigger's search_path ────────────────────────────
--
-- `auth_org_ids()` was careful to set `search_path = ''`; this one was missed.
-- It is a lesser exposure — the function is SECURITY INVOKER and its body only
-- raises, referencing no tables — but a mutable search_path on a trigger that
-- fires for every role is worth closing while it is still trivial.
--
-- Body is unchanged from 20260803120300_microsoft_audit.sql.

create or replace function public.change_log_append_only()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  raise exception 'change_log is append-only; % is not permitted', tg_op
    using errcode = 'restrict_violation',
          hint = 'Record a correction as a new change_log row. Never edit history.';
end
$$;
