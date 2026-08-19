-- ============================================================
-- 决策答卷通知分流
-- 决策答卷属于 Leader 私有收件信息：只进入个人机器人，不回群。
-- 加急、催办、任务与反馈事件仍由既有群机器人处理。
-- ============================================================

begin;

alter table public.notification_outbox drop constraint if exists notification_outbox_event_type_check;
alter table public.notification_outbox add constraint notification_outbox_event_type_check check
  (event_type in (
    'task_update', 'task_update_progress', 'task_nudged',
    'feedback_created', 'feedback_replied', 'feedback_resolved',
    'decision_response_submitted'
  ));

create or replace function public.notify_decision_response()
returns trigger
language plpgsql
security definer
as $$
declare
  v_form public.decision_forms;
begin
  select * into v_form from public.decision_forms where id = new.form_id;
  if v_form is null then
    return new;
  end if;

  insert into public.notification_outbox (event_type, source_key, payload)
  values (
    'decision_response_submitted',
    new.id::text,
    jsonb_build_object(
      'response_id', new.id::text,
      'form_id', new.form_id::text,
      'form_slug', v_form.slug,
      'form_title', v_form.title,
      'respondent_name', new.respondent_name,
      'submitted_at', new.submitted_at
    )
  );
  return new;
end;
$$;

drop trigger if exists notify_decision_response_trigger on public.decision_responses;
create trigger notify_decision_response_trigger
  after insert on public.decision_responses
  for each row execute function public.notify_decision_response();

commit;
