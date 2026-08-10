-- ============================================================================
-- Foreman — Phase 2 · Org onboarding
--
-- Creating an org is a chicken-and-egg problem, as 20260803120000_tenancy.sql
-- noted: at that instant `auth_org_ids()` is empty, so no RLS policy can admit
-- the membership insert, and widening one would let any user attach themselves
-- to an existing org and read its data.
--
-- That migration expected Phase 2 to solve it with the secret key from a server
-- action. This function is a deviation from that plan, for two reasons:
--
--   1. **Atomicity.** Onboarding writes three rows — org, owner membership,
--      default work calendar. Over PostgREST those are three round trips with
--      no shared transaction. A failure after the first leaves an orphan org
--      that its creator has no membership for, so it is invisible to them and
--      un-fixable from the UI. Here they are one statement block: all three or
--      none.
--
--   2. **No secret key on the path.** SECURITY DEFINER plus `auth.uid()` gets
--      the same privilege escalation, but scoped to exactly this operation and
--      with the acting user read from the verified JWT rather than passed in
--      by the caller. A `p_user_id` parameter would have been spoofable by
--      anything holding the secret key; `auth.uid()` is not spoofable at all.
--
-- The safety property the original note cared about is preserved: this can only
-- ever create a *brand new* org and make the caller its owner. There is no code
-- path here that joins a caller to an org that already exists.
-- ============================================================================

create or replace function public.create_org_with_owner(
  p_name         text,
  p_company_name text default null,
  p_timezone     text default 'UTC'
)
returns uuid
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_user_id uuid := (select auth.uid());
  v_org_id  uuid;
begin
  if v_user_id is null then
    raise exception 'Not signed in'
      using errcode = 'insufficient_privilege';
  end if;

  if trim(coalesce(p_name, '')) = '' then
    raise exception 'Company name is required'
      using errcode = 'check_violation';
  end if;

  -- SPEC scopes v1 to one org per user. Without this, a double-submitted form
  -- creates a second org and `getMembership()` — which takes the earliest —
  -- would quietly ignore it, leaving a confusing orphan behind.
  if exists (select 1 from public.memberships m where m.user_id = v_user_id) then
    raise exception 'You already belong to an organisation'
      using errcode = 'unique_violation';
  end if;

  -- Validated here rather than trusted: a bad zone is exactly the UTC-drift
  -- off-by-one SPEC §4 warns makes a contractor stop trusting the app, and it
  -- would not surface until a date computation went wrong weeks later.
  if p_timezone is null or not exists (
    select 1 from pg_catalog.pg_timezone_names z where z.name = p_timezone
  ) then
    raise exception 'Unknown timezone: %', coalesce(p_timezone, '(null)')
      using errcode = 'check_violation',
            hint = 'Use an IANA zone name, e.g. America/Denver.';
  end if;

  insert into public.orgs (name, company_name, timezone)
  values (trim(p_name), nullif(trim(coalesce(p_company_name, '')), ''), p_timezone)
  returning id into v_org_id;

  insert into public.memberships (org_id, user_id, role)
  values (v_org_id, v_user_id, 'owner');

  -- Every date computation resolves against a calendar (SPEC §4), so an org
  -- without one is a broken org. Mon-Fri default, per SPEC §3.
  insert into public.work_calendars (org_id, name, working_days)
  values (v_org_id, 'Standard', '{1,2,3,4,5}');

  return v_org_id;
end
$$;

revoke all on function public.create_org_with_owner(text, text, text) from public;
revoke all on function public.create_org_with_owner(text, text, text) from anon;
grant execute on function public.create_org_with_owner(text, text, text) to authenticated;

comment on function public.create_org_with_owner(text, text, text) is
  'Creates an org, makes the calling user its owner, and seeds a Mon-Fri work calendar. Atomic. SECURITY DEFINER because auth_org_ids() is necessarily empty at this point.';
