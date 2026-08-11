-- ============================================================================
-- Foreman — Phase 9 · Creating a project by voice
--
-- Until now the voice pipeline could do everything to a schedule except start
-- one: `planCommand` refused outright when the org had no projects, so a new
-- contractor's very first sentence hit a dead end telling them to go and use a
-- form. A scheduling app whose headline feature can't make the thing it
-- schedules is a demo, not a tool.
--
-- Two changes:
--   1. projects.color — a project's identity on the calendar.
--   2. apply_plan_writes gains insert_project, and its temp-id map is no
--      longer task-only, so "make a project called X and put framing in it"
--      applies as one transaction.
-- ============================================================================

-- ── Project color ───────────────────────────────────────────────────────────
--
-- Nullable on purpose. Trade colors (src/lib/trades.ts) are derived by hashing
-- the trade name into a fixed palette — deterministic, no storage, same color
-- on every device. Projects follow that default, so NULL means "use the hash".
--
-- The column exists for the case the hash cannot serve: the user asking for a
-- specific color out loud. Storing it only when explicitly chosen keeps the
-- zero-config behaviour for everyone who never mentions color.

alter table public.projects add column color text;

alter table public.projects
  add constraint projects_color_is_hex
  check (color is null or color ~ '^#[0-9a-fA-F]{6}$');

comment on column public.projects.color is
  'Explicit calendar color as #rrggbb. NULL = derive from the name hash (src/lib/project-color.ts).';

-- ── apply_plan_writes: insert_project + generalised temp ids ────────────────
--
-- Rewritten wholesale rather than patched: the temp-id map changes meaning
-- (tasks *and* projects now), and a reader needs to see the whole function to
-- trust that. Every existing branch is unchanged except where it resolves an
-- id through the map.
--
-- Temp ids: "$t0" for tasks (as before), "$p0" for projects. They share one
-- map because they are drawn from one numbering — the operation's index in the
-- plan — and a collision between the two prefixes is impossible.

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
  -- Membership gate up front: RLS would silently give zero-row results for a
  -- foreign org; better to fail loudly before doing any work.
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

    elsif v_kind = 'insert_task' then
      insert into public.tasks
        (org_id, project_id, name, trade, start_date, end_date,
         duration_days, status, is_milestone, notes)
      values (
        p_org_id,
        -- Resolves "$p0" to the project inserted earlier in this same batch,
        -- or passes a real uuid straight through.
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
      where id = (v_data->>'id')::uuid and org_id = p_org_id
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
          status        = coalesce((v_data->>'status')::public.task_status, status)
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
  'Applies a confirmed plan (project/contact/task creates, updates, links, assignments, queued messages) in one transaction with its change_log rows. Temp ids "$pN"/"$tN"/"$cN" resolve within the batch. SECURITY INVOKER: RLS applies.';
