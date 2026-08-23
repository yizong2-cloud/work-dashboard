-- Agent 对处理箱的回写需要一个可见且准确的身份；此前只有 Leader/负责人，
-- 会让网页把 Agent 的处理结论误标为“负责人”。

alter table public.task_feedback_messages
  drop constraint if exists task_feedback_messages_author_role_check;

alter table public.task_feedback_messages
  add constraint task_feedback_messages_author_role_check
  check (author_role in ('leader', 'owner', 'agent'));

create or replace function public.create_feedback_thread(
  p_task_id uuid,
  p_body text,
  p_author_name text default '',
  p_author_role text default 'leader',
  p_kind text default 'leader_feedback'
) returns public.task_feedback_threads
language plpgsql
security definer
as $$
declare v_thread public.task_feedback_threads;
begin
  if p_body is null or btrim(p_body) = '' then
    raise exception '反馈内容不能为空';
  end if;
  if p_author_role not in ('leader', 'owner', 'agent') then
    raise exception '非法反馈角色: %', p_author_role;
  end if;
  if p_kind not in ('leader_feedback', 'agent_instruction') then
    raise exception '非法反馈类型: %', p_kind;
  end if;
  insert into public.task_feedback_threads (task_id, kind, status, created_by)
  values (p_task_id, p_kind, 'open', p_author_name)
  returning * into v_thread;
  insert into public.task_feedback_messages (thread_id, body, author_name, author_role)
  values (v_thread.id, p_body, p_author_name, p_author_role);
  return v_thread;
end;
$$;

create or replace function public.add_feedback_reply(
  p_thread_id uuid,
  p_body text,
  p_author_name text default '',
  p_author_role text default 'owner'
) returns public.task_feedback_messages
language plpgsql
security definer
as $$
declare v_msg public.task_feedback_messages;
declare v_thread public.task_feedback_threads;
begin
  if p_body is null or btrim(p_body) = '' then
    raise exception '回复内容不能为空';
  end if;
  if p_author_role not in ('leader', 'owner', 'agent') then
    raise exception '非法反馈角色: %', p_author_role;
  end if;
  select * into v_thread from public.task_feedback_threads where id = p_thread_id;
  if v_thread is null then
    raise exception '反馈线程不存在: %', p_thread_id;
  end if;
  insert into public.task_feedback_messages (thread_id, body, author_name, author_role)
  values (p_thread_id, p_body, p_author_name, p_author_role)
  returning * into v_msg;
  if v_thread.status = 'resolved' then
    update public.task_feedback_threads
       set status = 'open', resolved_at = null, resolved_by = ''
     where id = p_thread_id;
  end if;
  return v_msg;
end;
$$;
