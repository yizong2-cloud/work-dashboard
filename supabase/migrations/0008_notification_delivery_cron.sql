-- 通知 outbox 维护调度：补齐 schema 中声明、但历史部署遗漏的自动兜底。
-- pending 每 5 分钟投递；failed 每 15 分钟重试，最多 5 次。
begin;

do $$
declare v_jobid bigint;
begin
  for v_jobid in
    select jobid from cron.job
     where jobname in ('workboard-notification-pending', 'workboard-notification-retry')
  loop
    perform cron.unschedule(v_jobid);
  end loop;
  perform cron.schedule('workboard-notification-pending', '*/5 * * * *', 'select public.deliver_pending_notifications()');
  perform cron.schedule('workboard-notification-retry', '*/15 * * * *', 'select public.retry_failed_notifications(5)');
end $$;

commit;
