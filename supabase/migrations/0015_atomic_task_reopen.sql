-- Reopening a completed task must atomically remove its completion date.
-- Normalise the one legacy state this constraint now rejects, then make the
-- invariant impossible to violate through either the CLI or direct RPC calls.

begin;

update public.tasks
set actual_end_date = null
where status <> 'completed' and actual_end_date is not null;

alter table public.tasks drop constraint if exists tasks_completed_actual_ck;
alter table public.tasks drop constraint if exists tasks_actual_completion_state_ck;
alter table public.tasks add constraint tasks_actual_completion_state_ck
  check ((status = 'completed') = (actual_end_date is not null));

create or replace function public.apply_task_update(
  p_task_id uuid,
  p_patch jsonb,
  p_type text default 'note',
  p_content text default '',
  p_old_date date default null,
  p_new_date date default null,
  p_created_by text default 'agent',
  p_notify_mode text default 'immediate',
  p_merge_key text default null
) returns public.tasks
language plpgsql
security definer
as $$
declare v_task public.tasks;
begin
  update public.tasks t
    set title             = coalesce(p_patch->>'title', t.title),
        description       = coalesce(p_patch->>'description', t.description),
        status            = coalesce(p_patch->>'status', t.status),
        priority          = coalesce(p_patch->>'priority', t.priority),
        progress          = coalesce((p_patch->>'progress')::int, t.progress),
        start_date        = coalesce((p_patch->>'start_date')::date, t.start_date),
        expected_end_date = coalesce((p_patch->>'expected_end_date')::date, t.expected_end_date),
        actual_end_date   = case when p_patch ? 'actual_end_date' then nullif(p_patch->>'actual_end_date', '')::date else t.actual_end_date end,
        current_status    = coalesce(p_patch->>'current_status', t.current_status),
        block_reason      = coalesce(p_patch->>'block_reason', t.block_reason),
        is_interrupt_task = coalesce((p_patch->>'is_interrupt_task')::boolean, t.is_interrupt_task),
        updated_at        = now()
    where t.id = p_task_id
    returning * into v_task;

  if v_task is null then
    raise exception '任务不存在: %', p_task_id;
  end if;

  insert into public.task_updates
    (task_id, type, content, old_expected_end_date, new_expected_end_date,
     created_at, created_by, notify_mode, merge_key)
  values
    (p_task_id, p_type, p_content, p_old_date, p_new_date,
     now(), p_created_by, p_notify_mode, p_merge_key);

  return v_task;
end;
$$;

grant execute on function public.apply_task_update(uuid, jsonb, text, text, date, date, text, text, text)
  to anon, authenticated;

commit;
