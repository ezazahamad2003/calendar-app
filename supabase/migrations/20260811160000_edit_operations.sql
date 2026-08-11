-- ============================================================================
-- Foreman — Phase 9b · Editing things that already exist
--
-- The assistant could create a project, a task and a contact, and could move
-- and resize a task, but could not rename any of them. Asked to rename a job
-- it did the only thing it had words for: it made a second one, having first
-- told the user it was renaming the first. A missing capability turned into a
-- confident falsehood, which is worse than a refusal.
--
-- Three additions to apply_plan_writes:
--   * update_project  — name, client, address, job number, status, colour
--   * update_contact  — name, company, trade, email, phone
--   * update_task     — gains name and trade alongside its existing dates
--
-- Every field is applied only when the key is PRESENT in the payload, using
-- `v_data ? 'key'` rather than coalesce-on-null. The difference matters: a
-- rename must not blank the client name just because the operation didn't
-- mention it, and an explicit null must still be able to clear a field.
-- ============================================================================

create or replace function public.apply_plan_writes(
  p_org_id     uuid,
  p_ops        jsonb,
  p_source     public.change_source default 'voice',
  p_transcript text default null
)
returns jsonb  -- { "applied": n, "task_ids": { "$t0": uuid, "$p0": uuid, … } }
language plpgsql
set search_path = ''
as $$
declare
  v_op      jsonb;
  v_kind    text;
  v_data    jsonb;
  v_log     jsonb;
  v_map     jsonb := '{}'::jsonb;
  v_new_id  uuid;
  v_count   integer := 0;
  v_task    public.tasks%rowtype;
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

    elsif v_kind = 'insert_task' then
      insert into public.tasks
        (org_id, project_id, name, trade, start_date, end_date,
         duration_days, status, is_milestone, notes)
      values (
        p_org_id,
        coalesce((v_map->>(v_data->>'project_id'))::uuid,
                 (v_data->>'project_id')::uuid),
        v_data->>'name',
        nullif(v_data->>'trade', ''),
        (v_data->>'start_date')::date,
        (v_data->>'end_date')::date,
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
          duration_days = coalesce((v_data->>'duration_days')::int, duration_days),
          status        = coalesce((v_data->>'status')::public.task_status, status),
          name          = case when v_data ? 'name'
                            then v_data->>'name' else name end,
          trade         = case when v_data ? 'trade'
                            then nullif(v_data->>'trade', '') else trade end
      where id = v_task.id;
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

  return jsonb_build_object('applied', v_count, 'task_ids', v_map);
end
$$;

revoke all on function public.apply_plan_writes(uuid, jsonb, public.change_source, text) from public;
revoke all on function public.apply_plan_writes(uuid, jsonb, public.change_source, text) from anon;
grant execute on function public.apply_plan_writes(uuid, jsonb, public.change_source, text)
  to authenticated;

comment on function public.apply_plan_writes(uuid, jsonb, public.change_source, text) is
  'Applies a confirmed plan (project/contact/task creates and edits, moves, links, assignments, queued messages) in one transaction with its change_log rows. Temp ids "$pN"/"$tN"/"$cN" resolve within the batch. SECURITY INVOKER: RLS applies.';
