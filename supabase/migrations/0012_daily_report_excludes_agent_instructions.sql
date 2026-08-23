-- 给 Agent 的处理箱是私有执行指令，不属于 Leader 协作反馈；日报只统计后者。
-- 仅重定义日报函数，既有线程、消息与通知记录均不迁移或删除。

create or replace function public.send_daily_report()
returns int
language plpgsql
security definer
as $$
declare v_ep public.webhook_endpoint;
  v_overdue jsonb; v_week jsonb; v_urgent jsonb; v_blocked jsonb; v_unscheduled jsonb;
  v_feedback int; v_updates int; v_active int; v_planned int;
  v_payload jsonb;
begin
  select * into v_ep from public.webhook_endpoint where id = 1;
  if v_ep is null or v_ep.url = '' then
    return 0;
  end if;

  -- 已逾期：预计完成 < 今天 且未完成
  select coalesce(jsonb_agg(jsonb_build_object(
           'task_id', id, 'title', title, 'progress', progress,
           'expected_end_date', expected_end_date, 'current_status', current_status)
           order by expected_end_date), '[]'::jsonb)
    into v_overdue
    from public.tasks
   where status not in ('completed','cancelled')
     and expected_end_date is not null
     and expected_end_date < CURRENT_DATE;

  -- 本周到期（今天起未来 7 天）
  select coalesce(jsonb_agg(jsonb_build_object(
           'task_id', id, 'title', title, 'progress', progress,
           'expected_end_date', expected_end_date, 'current_status', current_status)
           order by expected_end_date), '[]'::jsonb)
    into v_week
    from public.tasks
   where status not in ('completed','cancelled')
     and expected_end_date between CURRENT_DATE and CURRENT_DATE + 6;

  -- 加急中
  select coalesce(jsonb_agg(jsonb_build_object(
           'task_id', id, 'title', title, 'progress', progress,
           'expected_end_date', expected_end_date) order by title), '[]'::jsonb)
    into v_urgent
    from public.tasks
   where priority = 'urgent' and status not in ('completed','cancelled');

  -- 阻塞中
  select coalesce(jsonb_agg(jsonb_build_object(
           'task_id', id, 'title', title, 'progress', progress,
           'block_reason', block_reason) order by title), '[]'::jsonb)
    into v_blocked
    from public.tasks
   where status = 'blocked';

  -- 未排期（进行中但无预计完成日期）——Leader 核心痛点
  select coalesce(jsonb_agg(jsonb_build_object(
           'task_id', id, 'title', title, 'progress', progress,
           'current_status', current_status) order by title), '[]'::jsonb)
    into v_unscheduled
    from public.tasks
   where status = 'in_progress' and expected_end_date is null;

  -- 只统计待回应的 Leader 反馈；Agent 处理箱内容不进入 Leader 群日报。
  select count(*) into v_feedback
    from public.task_feedback_threads
   where status <> 'resolved'
     and kind = 'leader_feedback';

  -- 今日更新 / 活跃任务 / 待开始
  select count(*) into v_updates from public.task_updates
   where created_at >= date_trunc('day', now());
  select count(*) into v_active from public.tasks where status = 'in_progress';
  select count(*) into v_planned from public.tasks where status = 'planned';

  v_payload := jsonb_build_object(
    'kind', 'daily', 'date', CURRENT_DATE,
    'overdue', v_overdue, 'week', v_week, 'urgent', v_urgent,
    'blocked', v_blocked, 'unscheduled', v_unscheduled,
    'feedback_open', v_feedback, 'updates_today', v_updates,
    'active_count', v_active, 'planned_count', v_planned
  );

  perform net.http_post(
    url := v_ep.url,
    body := jsonb_build_object('type', 'INSERT', 'table', 'daily_report', 'record',
             jsonb_build_object('id', 'daily-report', 'event_type', 'daily_report', 'payload', v_payload)),
    headers := jsonb_build_object('content-type', 'application/json', 'x-dashboard-secret', v_ep.secret),
    timeout_milliseconds := 30000
  );
  return 1;
end;
$$;

grant execute on function public.send_daily_report() to service_role;
