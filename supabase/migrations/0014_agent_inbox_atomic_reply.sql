-- 处理箱中 Agent 的“已接手/已完成”说明和状态必须是同一笔事务，
-- 避免脚本在两次 RPC 之间失败后造成可见半状态。

create or replace function public.reply_agent_instruction(
  p_thread_id uuid,
  p_body text,
  p_status text default 'in_progress',
  p_author_name text default 'Agent'
) returns jsonb
language plpgsql
security definer
as $$
declare v_msg public.task_feedback_messages;
declare v_thread public.task_feedback_threads;
begin
  if p_body is null or btrim(p_body) = '' then
    raise exception '回复内容不能为空';
  end if;
  if p_status not in ('open', 'in_progress', 'resolved') then
    raise exception '非法状态: %', p_status;
  end if;
  select * into v_thread
    from public.task_feedback_threads
   where id = p_thread_id
   for update;
  if v_thread is null then
    raise exception '反馈线程不存在: %', p_thread_id;
  end if;
  if v_thread.kind <> 'agent_instruction' then
    raise exception '该反馈不属于 Agent 处理箱';
  end if;
  insert into public.task_feedback_messages (thread_id, body, author_name, author_role)
  values (p_thread_id, p_body, p_author_name, 'agent')
  returning * into v_msg;
  update public.task_feedback_threads
     set status = p_status,
         resolved_at = case when p_status = 'resolved' then now() else null end,
         resolved_by = case when p_status = 'resolved' then 'agent' else '' end
   where id = p_thread_id
  returning * into v_thread;
  return jsonb_build_object('message', to_jsonb(v_msg), 'thread', to_jsonb(v_thread));
end;
$$;

grant execute on function public.reply_agent_instruction(uuid, text, text, text) to anon, authenticated;
