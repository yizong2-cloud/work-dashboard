-- 失败通知指数退避：避免频控或外部服务异常时每轮 cron 都立即撞击目标。
begin;

create or replace function public.retry_failed_notifications(max_attempts int default 5)
returns int
language plpgsql
security definer
as $$
declare v_updated int := 0;
declare v_more int;
begin
  update public.notification_outbox
     set status = 'pending', updated_at = now()
   where status = 'failed'
     and attempts < max_attempts
     and updated_at <= now() - (interval '15 minutes' * greatest(1, attempts)::double precision);
  get diagnostics v_updated = ROW_COUNT;

  update public.notification_outbox
     set status = 'pending', updated_at = now()
   where status = 'sending' and updated_at < now() - interval '10 minutes';
  get diagnostics v_more = ROW_COUNT;
  return v_updated + v_more;
end;
$$;

commit;
