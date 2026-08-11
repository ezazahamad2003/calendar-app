-- ============================================================================
-- Foreman — Phase 10b · Removing things, and putting a clock on them
--
-- Two gaps closed in one place, because both are new `kind`s inside the same
-- transactional apply.
--
-- 1. DELETES. Asked to delete a job the assistant answered "I can't delete
--    projects yet — you'll have to do it manually", which is a strange thing
--    for the only interface to the schedule to say. It could create and it
--    could edit, so the schedule could only ever grow. Every mistake it made
--    was permanent unless the user went and undid it by hand.
--
--    Deleting is not treated as more dangerous than the writes already here,
--    because the safety model was never "the assistant can't do damage" — it is
--    that NOTHING happens without a human reading a diff and confirming it. A
--    delete goes through the same gate as a move, with a diff that names what
--    goes with it: dropping a project takes its tasks, their links, their
--    assignments and their calendar events.
--
--    Sent mail is deliberately exempt. outbound_messages already nulls its
--    task and contact references rather than cascading (see the Phase 1 audit
--    migration), so deleting a job never erases the record that an email went
--    out. change_log is append-only and keeps the deletion itself, including
--    the id of the row that is now gone.
--
-- 2. TIMES. insert_task and update_task carry start_time/end_time.
--
-- `removed_events` comes back alongside the temp-id map so the caller can pull
-- the same events off the connected calendar. Collected BEFORE the delete —
-- once the row is gone so is the id, and a ghost event on the contractor's own
-- calendar is exactly the kind of thing that stops them trusting the app.
-- ============================================================================

create or replace function public.apply_plan_writes(
  p_org_id     uuid,
  p_ops        jsonb,
  p_source     public.change_source default 'voice',
  p_transcript text default null
)
returns jsonb  -- { applied, task_ids: {"$t0": uuid, …}, removed_events: [{eventId, provider}] }
language plpgsql
set search_path = ''
as $$
declare
  v_op       jsonb;
  v_kind     text;
  v_data     jsonb;
  v_log      jsonb;
  v_map      jsonb := '{}'::jsonb;
  v_events   jsonb := '[]'::jsonb;
  v_children jsonb;
  v_new_id   uuid;
  v_target   uuid;
  v_count    integer := 0;
  v_task     public.tasks%rowtype;
begin
  if not exists (select 1 from public.auth_org_ids() ids where ids = p_org_id) then
    raise exception 'Not a member of that organisation'
      using errcode = 'insufficient_privilege';
  end if;

  if p_ops is null or jsonb_typeof(p_ops) <> 'array' then
    raise exception 'apply_plan_writes expects a JSON array of operations'
      using errcode = 'invalid_parameter_value';
  end if;

  for v_op in select * from jsonb_array_elements(p_ops)
  loop
    v_kind := v_op->>'kind';
    v_data := v_op->'data';
    v_log  := v_op->'log';

    -- Cleared every iteration. `RETURNING ... INTO` leaves the variable
    -- untouched when no row matches, so without this an UPDATE that hit
    -- nothing, or the `on conflict do nothing` assignment below, would carry
    -- the PREVIOUS operation's id — into the not-found checks and, worse, into
    -- change_log.entity_id, silently attributing a change to the wrong row.
    v_new_id := null;

    if v_kind = 'insert_project' then
      insert into public.projects
        (org_id, name, job_number, client_name, address, starts_on, color)
      values (
        p_org_id,
        v_data->>'name',
        nullif(v_data->>'job_number', ''),
        nullif(v_data->>'client_name', ''),
        nullif(v_data->>'address', ''),
        (nullif(v_data->>'starts_on', ''))::date,
        nullif(v_data->>'color', '')
      )
      returning id into v_new_id;

      if v_op ? 'temp_id' then
        v_map := v_map || jsonb_build_object(v_op->>'temp_id', v_new_id::text);
      end if;

    elsif v_kind = 'update_project' then
      update public.projects
      set name        = case when v_data ? 'name'
                          then v_data->>'name' else name end,
          job_number  = case when v_data ? 'job_number'
                          then nullif(v_data->>'job_number', '') else job_number end,
          client_name = case when v_data ? 'client_name'
                          then nullif(v_data->>'client_name', '') else client_name end,
          address     = case when v_data ? 'address'
                          then nullif(v_data->>'address', '') else address end,
          status      = case when v_data ? 'status'
                          then (v_data->>'status')::public.project_status else status end,
          color       = case when v_data ? 'color'
                          then nullif(v_data->>'color', '') else color end
      where id = coalesce((v_map->>(v_data->>'id'))::uuid, (v_data->>'id')::uuid)
        and org_id = p_org_id
      returning id into v_new_id;

      if v_new_id is null then
        raise exception 'Project % not found.', v_data->>'id'
          using errcode = 'no_data_found';
      end if;

    elsif v_kind = 'delete_project' then
      v_target := coalesce((v_map->>(v_data->>'id'))::uuid, (v_data->>'id')::uuid);

      -- Every event this job put on the connected calendar, gathered while the
      -- tasks still exist. The cascade below takes the rows with it.
      select coalesce(
               jsonb_agg(jsonb_build_object(
                 'eventId', t.calendar_event_id,
                 'provider', t.calendar_provider
               )),
               '[]'::jsonb
             )
      into v_children
      from public.tasks t
      where t.org_id = p_org_id
        and t.project_id = v_target
        and t.calendar_event_id is not null;

      v_events := v_events || v_children;

      delete from public.projects
      where id = v_target and org_id = p_org_id
      returning id into v_new_id;

      if v_new_id is null then
        raise exception 'Project % not found — it may already be gone.', v_data->>'id'
          using errcode = 'no_data_found';
      end if;

    elsif v_kind = 'insert_contact' then
      insert into public.contacts (org_id, name, company, trade, email, phone)
      values (
        p_org_id,
        v_data->>'name',
        nullif(v_data->>'company', ''),
        nullif(v_data->>'trade', ''),
        nullif(v_data->>'email', ''),
        nullif(v_data->>'phone', '')
      )
      returning id into v_new_id;

      if v_op ? 'temp_id' then
        v_map := v_map || jsonb_build_object(v_op->>'temp_id', v_new_id::text);
      end if;

    elsif v_kind = 'update_contact' then
      update public.contacts
      set name    = case when v_data ? 'name'    then v_data->>'name' else name end,
          company = case when v_data ? 'company'
                      then nullif(v_data->>'company', '') else company end,
          trade   = case when v_data ? 'trade'
                      then nullif(v_data->>'trade', '') else trade end,
          email   = case when v_data ? 'email'
                      then nullif(v_data->>'email', '') else email end,
          phone   = case when v_data ? 'phone'
                      then nullif(v_data->>'phone', '') else phone end
      where id = coalesce((v_map->>(v_data->>'id'))::uuid, (v_data->>'id')::uuid)
        and org_id = p_org_id
      returning id into v_new_id;

      if v_new_id is null then
        raise exception 'Contact % not found.', v_data->>'id'
          using errcode = 'no_data_found';
      end if;

    elsif v_kind = 'delete_contact' then
      delete from public.contacts
      where id = coalesce((v_map->>(v_data->>'id'))::uuid, (v_data->>'id')::uuid)
        and org_id = p_org_id
      returning id into v_new_id;

      if v_new_id is null then
        raise exception 'Contact % not found — they may already be gone.', v_data->>'id'
          using errcode = 'no_data_found';
      end if;

    elsif v_kind = 'insert_task' then
      insert into public.tasks
        (org_id, project_id, name, trade, start_date, end_date, start_time, end_time,
         duration_days, status, is_milestone, notes)
      values (
        p_org_id,
        coalesce((v_map->>(v_data->>'project_id'))::uuid,
                 (v_data->>'project_id')::uuid),
        v_data->>'name',
        nullif(v_data->>'trade', ''),
        (v_data->>'start_date')::date,
        (v_data->>'end_date')::date,
        (nullif(v_data->>'start_time', ''))::time,
        (nullif(v_data->>'end_time', ''))::time,
        coalesce((v_data->>'duration_days')::int, 1),
        coalesce(v_data->>'status', 'planned')::public.task_status,
        coalesce((v_data->>'is_milestone')::boolean, false),
        nullif(v_data->>'notes', '')
      )
      returning id into v_new_id;

      if v_op ? 'temp_id' then
        v_map := v_map || jsonb_build_object(v_op->>'temp_id', v_new_id::text);
      end if;

    elsif v_kind = 'update_task' then
      select * into v_task
      from public.tasks
      where id = coalesce((v_map->>(v_data->>'id'))::uuid, (v_data->>'id')::uuid)
        and org_id = p_org_id
      for update;

      if not found then
        raise exception 'Task % not found — the schedule changed under you. Reload and retry.',
          v_data->>'id' using errcode = 'no_data_found';
      end if;

      update public.tasks
      set start_date    = case when v_data ? 'start_date'
                            then (v_data->>'start_date')::date else start_date end,
          end_date      = case when v_data ? 'end_date'
                            then (v_data->>'end_date')::date else end_date end,
          -- Presence, not coalesce: '' clears the time back to all-day, which
          -- is a thing people ask for ("just make it any time that day").
          start_time    = case when v_data ? 'start_time'
                            then (nullif(v_data->>'start_time', ''))::time else start_time end,
          end_time      = case when v_data ? 'end_time'
                            then (nullif(v_data->>'end_time', ''))::time else end_time end,
          duration_days = coalesce((v_data->>'duration_days')::int, duration_days),
          status        = coalesce((v_data->>'status')::public.task_status, status),
          name          = case when v_data ? 'name'
                            then v_data->>'name' else name end,
          trade         = case when v_data ? 'trade'
                            then nullif(v_data->>'trade', '') else trade end
      where id = v_task.id;
      v_new_id := v_task.id;

    elsif v_kind = 'delete_task' then
      select * into v_task
      from public.tasks
      where id = coalesce((v_map->>(v_data->>'id'))::uuid, (v_data->>'id')::uuid)
        and org_id = p_org_id
      for update;

      if not found then
        raise exception 'Task % not found — it may already be gone. Reload and retry.',
          v_data->>'id' using errcode = 'no_data_found';
      end if;

      if v_task.calendar_event_id is not null then
        v_events := v_events || jsonb_build_object(
          'eventId', v_task.calendar_event_id,
          'provider', v_task.calendar_provider
        );
      end if;

      delete from public.tasks where id = v_task.id;
      v_new_id := v_task.id;

    elsif v_kind = 'insert_dep' then
      insert into public.task_deps
        (org_id, predecessor_id, successor_id, dep_type, lag_days)
      values (
        p_org_id,
        coalesce((v_map->>(v_data->>'predecessor_id'))::uuid,
                 (v_data->>'predecessor_id')::uuid),
        coalesce((v_map->>(v_data->>'successor_id'))::uuid,
                 (v_data->>'successor_id')::uuid),
        coalesce(v_data->>'dep_type', 'FS')::public.dep_type,
        coalesce((v_data->>'lag_days')::int, 0)
      )
      returning id into v_new_id;

    elsif v_kind = 'delete_dep' then
      delete from public.task_deps
      where org_id = p_org_id
        and predecessor_id = coalesce((v_map->>(v_data->>'predecessor_id'))::uuid,
                                      (v_data->>'predecessor_id')::uuid)
        and successor_id   = coalesce((v_map->>(v_data->>'successor_id'))::uuid,
                                      (v_data->>'successor_id')::uuid)
      returning id into v_new_id;

      if v_new_id is null then
        raise exception 'Those two tasks are not linked.'
          using errcode = 'no_data_found';
      end if;

    elsif v_kind = 'insert_assignment' then
      insert into public.assignments (org_id, task_id, contact_id)
      values (
        p_org_id,
        coalesce((v_map->>(v_data->>'task_id'))::uuid, (v_data->>'task_id')::uuid),
        coalesce((v_map->>(v_data->>'contact_id'))::uuid,
                 (v_data->>'contact_id')::uuid)
      )
      on conflict (task_id, contact_id) do nothing
      returning id into v_new_id;

    elsif v_kind = 'delete_assignment' then
      delete from public.assignments
      where org_id = p_org_id
        and task_id    = coalesce((v_map->>(v_data->>'task_id'))::uuid,
                                  (v_data->>'task_id')::uuid)
        and contact_id = coalesce((v_map->>(v_data->>'contact_id'))::uuid,
                                  (v_data->>'contact_id')::uuid)
      returning id into v_new_id;

      if v_new_id is null then
        raise exception 'That person is not on that task.'
          using errcode = 'no_data_found';
      end if;

    elsif v_kind = 'insert_message' then
      insert into public.outbound_messages
        (org_id, task_id, contact_id, channel, subject, body, status, idempotency_key)
      values (
        p_org_id,
        coalesce((v_map->>(v_data->>'task_id'))::uuid, (v_data->>'task_id')::uuid),
        coalesce((v_map->>(v_data->>'contact_id'))::uuid,
                 (v_data->>'contact_id')::uuid),
        coalesce(v_data->>'channel', 'email')::public.message_channel,
        v_data->>'subject',
        v_data->>'body',
        'queued',
        v_data->>'idempotency_key'
      )
      returning id into v_new_id;

    else
      raise exception 'Unknown operation kind: %', v_kind
        using errcode = 'invalid_parameter_value';
    end if;

    if v_log is not null then
      insert into public.change_log
        (org_id, actor_user_id, entity_type, entity_id, action,
         before, after, source, transcript)
      values (
        p_org_id,
        (select auth.uid()),
        v_log->>'entity_type',
        v_new_id,
        v_log->>'action',
        v_log->'before',
        v_log->'after',
        p_source,
        p_transcript
      );
    end if;

    v_count := v_count + 1;
  end loop;

  return jsonb_build_object(
    'applied', v_count,
    'task_ids', v_map,
    'removed_events', v_events
  );
end
$$;

revoke all on function public.apply_plan_writes(uuid, jsonb, public.change_source, text) from public;
revoke all on function public.apply_plan_writes(uuid, jsonb, public.change_source, text) from anon;
grant execute on function public.apply_plan_writes(uuid, jsonb, public.change_source, text)
  to authenticated;

comment on function public.apply_plan_writes(uuid, jsonb, public.change_source, text) is
  'Applies a confirmed plan — creates, edits, deletes, moves, links, assignments and queued messages — in one transaction with its change_log rows. Temp ids "$pN"/"$tN"/"$cN" resolve within the batch. Returns the temp-id map and any calendar events whose rows were deleted. SECURITY INVOKER: RLS applies.';
