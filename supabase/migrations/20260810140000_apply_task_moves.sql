-- ============================================================================
-- Foreman — Phase 3 · Atomic schedule apply
--
-- Moving one bar can cascade into a dozen tasks. Over PostgREST those would be
-- a dozen independent UPDATEs — a crash midway leaves the schedule half-moved,
-- which is worse than not moving it at all. A plpgsql function runs in one
-- transaction: every move lands, or none do.
--
-- SECURITY INVOKER, deliberately (contrast create_org_with_owner): the caller
-- is a signed-in member and RLS must apply. An UPDATE that matches zero rows —
-- someone else's task id, a stale id — is caught and aborts the whole call
-- rather than silently applying a partial set.
--
-- Writes the change_log rows in the same transaction (SPEC §3: the audit trail
-- is a product feature; a move that commits without its log entry is a dispute
-- waiting to happen). SPEC §5's voice-confirm apply reuses this function.
-- ============================================================================

create or replace function public.apply_task_moves(
  p_moves      jsonb,               -- [{"task_id": uuid, "start_date": date, "end_date": date}]
  p_source     public.change_source default 'ui',
  p_transcript text default null
)
returns integer
language plpgsql
set search_path = ''
as $$
declare
  v_move  jsonb;
  v_old   public.tasks%rowtype;
  v_new   public.tasks%rowtype;
  v_count integer := 0;
begin
  if p_moves is null or jsonb_typeof(p_moves) <> 'array' then
    raise exception 'apply_task_moves expects a JSON array of moves'
      using errcode = 'invalid_parameter_value';
  end if;

  for v_move in select * from jsonb_array_elements(p_moves)
  loop
    select * into v_old
    from public.tasks
    where id = (v_move->>'task_id')::uuid
    for update;

    if not found then
      -- Either the id is stale or RLS filtered it (not the caller's org).
      -- Both mean the plan no longer matches reality: abort everything.
      raise exception 'Task % not found — the schedule changed under you. Reload and retry.',
        v_move->>'task_id'
        using errcode = 'no_data_found';
    end if;

    update public.tasks
    set start_date = (v_move->>'start_date')::date,
        end_date   = (v_move->>'end_date')::date
    where id = v_old.id
    returning * into v_new;

    insert into public.change_log
      (org_id, actor_user_id, entity_type, entity_id, action, before, after, source, transcript)
    values (
      v_old.org_id,
      (select auth.uid()),
      'task',
      v_old.id,
      'move',
      jsonb_build_object('start_date', v_old.start_date, 'end_date', v_old.end_date),
      jsonb_build_object('start_date', v_new.start_date, 'end_date', v_new.end_date),
      p_source,
      p_transcript
    );

    v_count := v_count + 1;
  end loop;

  return v_count;
end
$$;

revoke all on function public.apply_task_moves(jsonb, public.change_source, text) from public;
revoke all on function public.apply_task_moves(jsonb, public.change_source, text) from anon;
grant execute on function public.apply_task_moves(jsonb, public.change_source, text) to authenticated;

comment on function public.apply_task_moves(jsonb, public.change_source, text) is
  'Applies a batch of task date moves atomically, logging each to change_log. SECURITY INVOKER: RLS applies; any unmatched task aborts the batch.';
