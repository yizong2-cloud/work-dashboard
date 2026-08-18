-- 决策中心：可追溯决策记录
-- 原始资料保留在 decision_forms.source_document；每题补充原文依据与转换说明；
-- 飞书等外部讨论只同步会影响理解或结论的正式记录，不在站内复刻聊天。

begin;

alter table public.decision_questions
  add column if not exists group_name text not null default '待确认事项',
  add column if not exists source_excerpt text not null default '',
  add column if not exists conversion_note text not null default '',
  add column if not exists resolution_status text not null default 'pending'
    check (resolution_status in ('pending', 'clarified', 'decided', 'changed'));

create table if not exists public.decision_clarifications (
  id uuid primary key default gen_random_uuid(),
  form_id uuid not null references public.decision_forms(id) on delete cascade,
  question_id uuid not null references public.decision_questions(id) on delete cascade,
  kind text not null check (kind in ('clarification', 'decision', 'change')),
  content text not null check (btrim(content) <> ''),
  source_channel text not null default 'feishu',
  source_url text not null default '',
  created_by text not null default 'agent',
  created_at timestamptz not null default now()
);
create index if not exists decision_clarifications_form_question_idx
  on public.decision_clarifications(form_id, question_id, created_at desc);

alter table public.decision_clarifications enable row level security;
drop policy if exists "decision_clarifications_read" on public.decision_clarifications;
create policy "decision_clarifications_read" on public.decision_clarifications for select using (true);
revoke all on public.decision_clarifications from anon, authenticated;
grant select on public.decision_clarifications to anon, authenticated;

-- 兼容既有 create_decision_form RPC：创建基础表单后补齐可追溯字段。
-- 若补齐失败，基础表单仍可用，调用端会明确报错而不会静默丢失信息。
create or replace function public.enrich_decision_form(p_form_slug text, p_payload jsonb)
returns void
language plpgsql
security definer
as $$
declare
  v_form public.decision_forms;
  v_q jsonb;
  v_question public.decision_questions;
  v_idx int;
begin
  select * into v_form from public.decision_forms where slug = btrim(p_form_slug);
  if v_form is null then raise exception '表单不存在: %', p_form_slug; end if;
  if p_payload is null or jsonb_typeof(p_payload->'questions') <> 'array' then
    raise exception 'payload 缺少 questions 数组';
  end if;
  if p_payload ? 'source_document' then
    update public.decision_forms
      set source_document = p_payload->>'source_document', updated_at = now()
      where id = v_form.id;
  end if;
  for v_idx in 0 .. jsonb_array_length(p_payload->'questions') - 1 loop
    v_q := p_payload->'questions'->v_idx;
    select * into v_question from public.decision_questions
      where form_id = v_form.id and code = btrim(coalesce(v_q->>'code', ''));
    if v_question is null then
      raise exception '题目不存在，无法补齐依据: %', v_q->>'code';
    end if;
    update public.decision_questions set
      group_name = coalesce(nullif(btrim(v_q->>'group_name'), ''), '待确认事项'),
      source_excerpt = coalesce(v_q->>'source_excerpt', ''),
      conversion_note = coalesce(v_q->>'conversion_note', '')
      where id = v_question.id;
  end loop;
end;
$$;
grant execute on function public.enrich_decision_form(text, jsonb) to anon, authenticated, service_role;

create or replace function public.append_decision_clarification(
  p_form_slug text,
  p_question_code text,
  p_kind text,
  p_content text,
  p_source_channel text default 'feishu',
  p_source_url text default '',
  p_created_by text default 'agent'
)
returns jsonb
language plpgsql
security definer
as $$
declare
  v_form public.decision_forms;
  v_question public.decision_questions;
  v_entry public.decision_clarifications;
  v_status text;
begin
  select * into v_form from public.decision_forms where slug = btrim(p_form_slug);
  if v_form is null then raise exception '表单不存在: %', p_form_slug; end if;
  select * into v_question from public.decision_questions
    where form_id = v_form.id and code = btrim(p_question_code);
  if v_question is null then raise exception '题目不存在: %', p_question_code; end if;
  if p_kind not in ('clarification', 'decision', 'change') then
    raise exception '澄清类型非法: %', p_kind;
  end if;
  if btrim(coalesce(p_content, '')) = '' then raise exception '澄清内容不能为空'; end if;

  insert into public.decision_clarifications (
    form_id, question_id, kind, content, source_channel, source_url, created_by
  ) values (
    v_form.id, v_question.id, p_kind, btrim(p_content),
    coalesce(nullif(btrim(p_source_channel), ''), 'feishu'),
    btrim(coalesce(p_source_url, '')), coalesce(nullif(btrim(p_created_by), ''), 'agent')
  ) returning * into v_entry;

  v_status := case
    when p_kind = 'decision' then 'decided'
    when p_kind = 'change' then 'changed'
    when v_question.resolution_status = 'decided' then 'decided'
    else 'clarified'
  end;
  update public.decision_questions set resolution_status = v_status where id = v_question.id;
  update public.decision_forms set updated_at = now() where id = v_form.id;

  return to_jsonb(v_entry);
end;
$$;
grant execute on function public.append_decision_clarification(text, text, text, text, text, text, text)
  to anon, authenticated, service_role;

commit;
