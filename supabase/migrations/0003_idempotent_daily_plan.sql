-- 日计划：幂等创建 + 时间线审计原子化
-- 同一任务同一天已有未完成计划时直接返回，避免「＋今天」重复点击制造重复计划块。

create or replace function public.ensure_plan_for_day(
  p_task_id uuid, p_date date, p_created_by text default ''
) returns public.task_plan_blocks
language plpgsql
security definer
as $$
declare v_block public.task_plan_blocks;
begin
  if p_date is null then
    raise exception '计划日期不能为空';
  end if;
  perform pg_advisory_xact_lock(hashtext(p_task_id::text), (p_date - date '2000-01-01')::integer);
  select * into v_block
    from public.task_plan_blocks
   where task_id = p_task_id
     and start_date <= p_date
     and end_date >= p_date
     and status <> 'done'
   order by created_at asc
   limit 1;
  if v_block is not null then
    return v_block;
  end if;

  insert into public.task_plan_blocks (task_id, start_date, end_date, summary, status, created_by)
  values (p_task_id, p_date, p_date, '', 'planned', p_created_by)
  returning * into v_block;
  insert into public.task_updates (task_id, type, content, created_by, notify_mode)
  values (p_task_id, 'note', format('安排到今天日计划（%s）', p_date), p_created_by, 'silent');
  return v_block;
end;
$$;

grant execute on function public.ensure_plan_for_day(uuid, date, text) to anon, authenticated;
