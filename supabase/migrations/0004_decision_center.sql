-- ============================================================
-- 决策中心（Decision Hub）数据模型与 RPC
--
-- 契约与规则见 docs/DECISION_CENTER_PRD.md
-- 包含：
--   1. 决策表单表结构与不变量约束 (forms, questions, options, responses, answers)
--   2. RLS 开放策略
--   3. 原子创建表单 RPC: create_decision_form
--   4. 原子提交答卷 RPC: submit_decision_response（严格题型与必填校验）
--   5. 状态流转 RPC: close_decision_form / open_decision_form
-- ============================================================

begin;

-- ---------------- 1. decision_forms 表 ----------------
create table if not exists public.decision_forms (
  id              uuid primary key default gen_random_uuid(),
  slug            text not null unique,
  title           text not null,
  summary         text not null default '',
  source_document text,
  status          text not null default 'open'
                  check (status in ('draft', 'open', 'closed')),
  created_by      text not null default 'agent',
  created_at      timestamptz not null default now(),
  closed_at       timestamptz,
  updated_at      timestamptz not null default now()
);

create index if not exists decision_forms_slug_idx on public.decision_forms (slug);
create index if not exists decision_forms_status_idx on public.decision_forms (status);

drop trigger if exists decision_forms_set_updated_at on public.decision_forms;
create trigger decision_forms_set_updated_at
  before update on public.decision_forms
  for each row execute function public.set_updated_at();

-- ---------------- 2. decision_questions 表 ----------------
create table if not exists public.decision_questions (
  id                    uuid primary key default gen_random_uuid(),
  form_id               uuid not null references public.decision_forms(id) on delete cascade,
  code                  text not null,
  sort_order            integer not null default 0,
  title                 text not null,
  context               text not null default '',
  type                  text not null
                        check (type in ('single_choice', 'multiple_choice', 'free_text', 'confirmation')),
  required              boolean not null default true,
  allow_other           boolean not null default false,
  recommended_option_id uuid,
  recommended_reason    text not null default '',
  created_at            timestamptz not null default now(),
  constraint decision_questions_form_code_unique unique (form_id, code)
);

create index if not exists decision_questions_form_id_idx on public.decision_questions (form_id);

-- ---------------- 3. decision_options 表 ----------------
create table if not exists public.decision_options (
  id          uuid primary key default gen_random_uuid(),
  question_id uuid not null references public.decision_questions(id) on delete cascade,
  code        text not null,
  label       text not null,
  detail      text not null default '',
  sort_order  integer not null default 0,
  created_at  timestamptz not null default now(),
  constraint decision_options_question_code_unique unique (question_id, code)
);

create index if not exists decision_options_question_id_idx on public.decision_options (question_id);

-- 推荐选项外键关联
do $$
begin
  if not exists (
    select 1 from pg_constraint where conname = 'decision_questions_recommended_opt_fk'
  ) then
    alter table public.decision_questions
      add constraint decision_questions_recommended_opt_fk
      foreign key (recommended_option_id) references public.decision_options(id) on delete set null;
  end if;
end $$;

-- ---------------- 4. decision_responses 表 ----------------
create table if not exists public.decision_responses (
  id              uuid primary key default gen_random_uuid(),
  form_id         uuid not null references public.decision_forms(id) on delete cascade,
  respondent_name text not null,
  respondent_note text not null default '',
  submitted_at    timestamptz not null default now()
);

create index if not exists decision_responses_form_id_idx on public.decision_responses (form_id);
create index if not exists decision_responses_submitted_at_idx on public.decision_responses (submitted_at desc);

-- ---------------- 5. decision_answers 表 ----------------
create table if not exists public.decision_answers (
  id                  uuid primary key default gen_random_uuid(),
  response_id         uuid not null references public.decision_responses(id) on delete cascade,
  question_id         uuid not null references public.decision_questions(id) on delete cascade,
  selected_option_ids jsonb not null default '[]'::jsonb,
  text_answer         text not null default '',
  other_text          text not null default '',
  constraint decision_answers_response_question_unique unique (response_id, question_id)
);

create index if not exists decision_answers_response_id_idx on public.decision_answers (response_id);
create index if not exists decision_answers_question_id_idx on public.decision_answers (question_id);

-- ---------------- 6. RLS：匿名可读，写入只走受校验的 RPC ----------------
alter table public.decision_forms enable row level security;
alter table public.decision_questions enable row level security;
alter table public.decision_options enable row level security;
alter table public.decision_responses enable row level security;
alter table public.decision_answers enable row level security;

drop policy if exists "decision_forms_all" on public.decision_forms;
drop policy if exists "decision_questions_all" on public.decision_questions;
drop policy if exists "decision_options_all" on public.decision_options;
drop policy if exists "decision_responses_all" on public.decision_responses;
drop policy if exists "decision_answers_all" on public.decision_answers;
drop policy if exists "decision_forms_read" on public.decision_forms;
drop policy if exists "decision_questions_read" on public.decision_questions;
drop policy if exists "decision_options_read" on public.decision_options;
drop policy if exists "decision_responses_read" on public.decision_responses;
drop policy if exists "decision_answers_read" on public.decision_answers;
create policy "decision_forms_read" on public.decision_forms for select using (true);
create policy "decision_questions_read" on public.decision_questions for select using (true);
create policy "decision_options_read" on public.decision_options for select using (true);
create policy "decision_responses_read" on public.decision_responses for select using (true);
create policy "decision_answers_read" on public.decision_answers for select using (true);
revoke all on public.decision_forms, public.decision_questions, public.decision_options,
  public.decision_responses, public.decision_answers from anon, authenticated;
grant select on public.decision_forms, public.decision_questions, public.decision_options,
  public.decision_responses, public.decision_answers to anon, authenticated;

-- ---------------- 7. 原子创建表单 RPC: create_decision_form ----------------
create or replace function public.create_decision_form(p_payload jsonb)
returns jsonb
language plpgsql
security definer
as $$
declare
  v_slug text;
  v_title text;
  v_summary text;
  v_source_doc text;
  v_status text;
  v_created_by text;
  v_form_id uuid;
  v_questions jsonb;
  v_q jsonb;
  v_q_id uuid;
  v_q_code text;
  v_q_type text;
  v_q_title text;
  v_q_context text;
  v_q_required boolean;
  v_q_allow_other boolean;
  v_q_rec_code text;
  v_q_rec_reason text;
  v_options jsonb;
  v_opt jsonb;
  v_opt_id uuid;
  v_opt_code text;
  v_opt_label text;
  v_opt_detail text;
  v_rec_opt_id uuid;
  v_idx int;
  v_opt_idx int;
begin
  if p_payload is null or jsonb_typeof(p_payload) <> 'object' then
    raise exception 'payload 必须是 JSON 对象';
  end if;
  v_slug := btrim(coalesce(p_payload->>'slug', ''));
  v_title := btrim(coalesce(p_payload->>'title', ''));
  v_summary := coalesce(p_payload->>'summary', '');
  v_source_doc := p_payload->>'source_document';
  v_status := coalesce(p_payload->>'status', 'open');
  v_created_by := coalesce(p_payload->>'created_by', 'agent');
  v_questions := p_payload->'questions';

  if v_slug = '' then
    raise exception 'slug 不能为空';
  end if;
  if v_slug !~ '^[A-Za-z0-9_-]+$' then
    raise exception 'slug 格式非法：只允许英文字母、数字、下划线及连字符';
  end if;
  if v_title = '' then
    raise exception 'title 不能为空';
  end if;
  if v_status not in ('draft', 'open', 'closed') then
    raise exception '非法状态: %', v_status;
  end if;
  if v_questions is null or jsonb_typeof(v_questions) <> 'array' or jsonb_array_length(v_questions) = 0 then
    raise exception 'questions 不能为空';
  end if;

  if exists (select 1 from public.decision_forms where slug = v_slug) then
    raise exception 'slug 已存在: %', v_slug;
  end if;

  -- 插入表单主记录
  insert into public.decision_forms (slug, title, summary, source_document, status, created_by)
  values (v_slug, v_title, v_summary, v_source_doc, v_status, v_created_by)
  returning id into v_form_id;

  -- 遍历插入每道题
  for v_idx in 0 .. jsonb_array_length(v_questions) - 1 loop
    v_q := v_questions->v_idx;
    if jsonb_typeof(v_q) <> 'object' then
      raise exception '题目 % 必须是 JSON 对象', v_idx + 1;
    end if;
    v_q_code := btrim(coalesce(v_q->>'code', ''));
    v_q_title := btrim(coalesce(v_q->>'title', ''));
    v_q_context := coalesce(v_q->>'context', '');
    v_q_type := coalesce(v_q->>'type', 'single_choice');
    v_q_required := coalesce((v_q->>'required')::boolean, true);
    v_q_allow_other := coalesce((v_q->>'allow_other')::boolean, false);
    v_q_rec_code := btrim(coalesce(v_q->>'recommended_option_code', ''));
    v_q_rec_reason := coalesce(v_q->>'recommended_reason', '');
    v_options := v_q->'options';

    if v_q_code = '' or v_q_title = '' then
      raise exception '题目编号与标题不能为空: 索引 %', v_idx;
    end if;
    if v_q_type not in ('single_choice', 'multiple_choice', 'free_text', 'confirmation') then
      raise exception '非法题型: %', v_q_type;
    end if;
    if v_q_type in ('single_choice', 'multiple_choice')
       and (v_options is null or jsonb_typeof(v_options) <> 'array' or jsonb_array_length(v_options) = 0) then
      raise exception '选择题 % 必须至少包含一个选项', v_q_code;
    end if;
    if v_options is not null and jsonb_typeof(v_options) <> 'array' then
      raise exception '题目 % 的 options 必须是数组', v_q_code;
    end if;

    insert into public.decision_questions (
      form_id, code, sort_order, title, context, type, required, allow_other, recommended_reason
    ) values (
      v_form_id, v_q_code, v_idx, v_q_title, v_q_context, v_q_type, v_q_required, v_q_allow_other, v_q_rec_reason
    ) returning id into v_q_id;

    v_rec_opt_id := null;

    -- 插入选项
    if v_options is not null and jsonb_array_length(v_options) > 0 then
      for v_opt_idx in 0 .. jsonb_array_length(v_options) - 1 loop
        v_opt := v_options->v_opt_idx;
        v_opt_code := btrim(coalesce(v_opt->>'code', ''));
        v_opt_label := btrim(coalesce(v_opt->>'label', ''));
        v_opt_detail := coalesce(v_opt->>'detail', '');

        if v_opt_code = '' or v_opt_label = '' then
          raise exception '选项编号与文案不能为空: 题 % 选项 %', v_q_code, v_opt_idx;
        end if;

        insert into public.decision_options (
          question_id, code, label, detail, sort_order
        ) values (
          v_q_id, v_opt_code, v_opt_label, v_opt_detail, v_opt_idx
        ) returning id into v_opt_id;

        if v_q_rec_code <> '' and v_q_rec_code = v_opt_code then
          v_rec_opt_id := v_opt_id;
        end if;
      end loop;

    end if;

    if v_q_rec_code <> '' and v_rec_opt_id is null then
      raise exception '推荐项 code "%" 在题目 "%" 中不存在', v_q_rec_code, v_q_code;
    end if;

    if v_rec_opt_id is not null then
      update public.decision_questions
         set recommended_option_id = v_rec_opt_id
       where id = v_q_id;
    end if;
  end loop;

  return jsonb_build_object(
    'id', v_form_id,
    'slug', v_slug,
    'title', v_title,
    'status', v_status
  );
end;
$$;

grant execute on function public.create_decision_form(jsonb) to anon, authenticated, service_role;

-- ---------------- 8. 原子提交答卷 RPC: submit_decision_response ----------------
create or replace function public.submit_decision_response(
  p_form_slug text,
  p_respondent_name text,
  p_answers jsonb,
  p_respondent_note text default ''
)
returns jsonb
language plpgsql
security definer
as $$
declare
  v_form public.decision_forms;
  v_response_id uuid;
  v_ans jsonb;
  v_idx int;
  v_q_id uuid;
  v_q public.decision_questions;
  v_selected_opts jsonb;
  v_opt_count int;
  v_text_ans text;
  v_other_text text;
  v_opt_id text;
  v_opt_idx int;
  v_req_q record;
  v_answered_q_ids uuid[] := array[]::uuid[];
  v_clean_note text;
begin
  p_respondent_name := btrim(coalesce(p_respondent_name, ''));
  v_clean_note := btrim(coalesce(p_respondent_note, ''));

  if length(p_respondent_name) > 50 then
    raise exception '提交身份过长（最多 50 字）';
  end if;

  select * into v_form from public.decision_forms where slug = p_form_slug;
  if v_form is null then
    raise exception '表单不存在: %', p_form_slug;
  end if;
  if v_form.status = 'draft' then
    raise exception '表单当前为草稿状态，尚未开放提交: %', p_form_slug;
  end if;
  if v_form.status = 'closed' then
    raise exception '表单已关闭，无法提交新答卷: %', p_form_slug;
  end if;

  if p_answers is null or jsonb_array_length(p_answers) = 0 then
    raise exception '提交答案不能为空';
  end if;

  -- 校验每道题答案的具体题型内容有效性
  for v_idx in 0 .. jsonb_array_length(p_answers) - 1 loop
    v_ans := p_answers->v_idx;
    v_q_id := (v_ans->>'question_id')::uuid;
    v_selected_opts := coalesce(v_ans->'selected_option_ids', '[]'::jsonb);
    v_text_ans := btrim(coalesce(v_ans->>'text_answer', ''));
    v_other_text := btrim(coalesce(v_ans->>'other_text', ''));
    v_opt_count := jsonb_array_length(v_selected_opts);

    select * into v_q from public.decision_questions where id = v_q_id and form_id = v_form.id;
    if v_q is null then
      raise exception '题目 % 不属于此表单', v_q_id;
    end if;

    -- 校验其他说明 (other_text)
    if not v_q.allow_other and v_other_text <> '' then
      raise exception '题目 %（%）未开启“其他”选项，禁止提交其他说明', v_q.code, v_q.title;
    end if;

    -- 校验所选选项是否属于该题
    if v_opt_count > 0 then
      for v_opt_idx in 0 .. v_opt_count - 1 loop
        v_opt_id := v_selected_opts->>v_opt_idx;
        if not exists (
          select 1 from public.decision_options where id = v_opt_id::uuid and question_id = v_q.id
        ) then
          raise exception '选项 % 不属于题目 %', v_opt_id, v_q.code;
        end if;
      end loop;
    end if;

    -- 按题型严格校验内容
    if v_q.type = 'single_choice' then
      -- 单选：必须是选 1 个选项（此时 other_text 必须为空），或者选“其他”（此时选项必须为空且 other_text 非空）
      if v_opt_count > 1 then
        raise exception '单选题 % 只能选择一个选项', v_q.code;
      end if;
      if v_opt_count = 1 and v_other_text <> '' then
        raise exception '单选题 % 已选择选项，不可同时填写其他说明', v_q.code;
      end if;
      if v_q.required and v_opt_count = 0 and v_other_text = '' then
        raise exception '必答单选题 % 未作答', v_q.code;
      end if;
      if v_opt_count > 0 or v_other_text <> '' then
        v_answered_q_ids := array_append(v_answered_q_ids, v_q.id);
      end if;

    elsif v_q.type = 'multiple_choice' then
      -- 多选：如果必填，必须至少选一个选项或填写非空 other_text
      if v_q.required and v_opt_count = 0 and v_other_text = '' then
        raise exception '必答多选题 % 未作答', v_q.code;
      end if;
      if v_opt_count > 0 or v_other_text <> '' then
        v_answered_q_ids := array_append(v_answered_q_ids, v_q.id);
      end if;

    elsif v_q.type = 'free_text' then
      -- 自由文本：禁止传 selected_option_ids
      if v_opt_count > 0 then
        raise exception '自由文本题 % 不得包含选项选择', v_q.code;
      end if;
      if v_q.required and v_text_ans = '' then
        raise exception '必答自由文本题 % 未填写内容', v_q.code;
      end if;
      if v_text_ans <> '' then
        v_answered_q_ids := array_append(v_answered_q_ids, v_q.id);
      end if;

    elsif v_q.type = 'confirmation' then
      -- 确认题：禁止传 selected_option_ids，text_answer 必须为 confirmed 或 unconfirmed
      if v_opt_count > 0 then
        raise exception '确认题 % 不得包含选项选择', v_q.code;
      end if;
      if v_text_ans <> '' and v_text_ans not in ('confirmed', 'unconfirmed') then
        raise exception '确认题 % 结果非法: "%"，只允许 confirmed 或 unconfirmed', v_q.code, v_text_ans;
      end if;
      if v_q.required and v_text_ans = '' then
        raise exception '必答确认题 % 未进行确认选择', v_q.code;
      end if;
      if v_text_ans <> '' then
        v_answered_q_ids := array_append(v_answered_q_ids, v_q.id);
      end if;
    end if;
  end loop;

  -- 校验所有必答题是否确实满足作答
  for v_req_q in select id, code from public.decision_questions where form_id = v_form.id and required = true loop
    if not (v_req_q.id = any(v_answered_q_ids)) then
      raise exception '必答题未完成: %', v_req_q.code;
    end if;
  end loop;

  -- 创建答卷主记录
  insert into public.decision_responses (form_id, respondent_name, respondent_note)
  values (v_form.id, p_respondent_name, v_clean_note)
  returning id into v_response_id;

  -- 插入答案记录
  for v_idx in 0 .. jsonb_array_length(p_answers) - 1 loop
    v_ans := p_answers->v_idx;
    v_q_id := (v_ans->>'question_id')::uuid;
    v_selected_opts := coalesce(v_ans->'selected_option_ids', '[]'::jsonb);
    v_text_ans := coalesce(v_ans->>'text_answer', '');
    v_other_text := coalesce(v_ans->>'other_text', '');

    insert into public.decision_answers (
      response_id, question_id, selected_option_ids, text_answer, other_text
    ) values (
      v_response_id, v_q_id, v_selected_opts, v_text_ans, v_other_text
    );
  end loop;

  return jsonb_build_object(
    'id', v_response_id,
    'form_id', v_form.id,
    'respondent_name', p_respondent_name,
    'respondent_note', v_clean_note,
    'submitted_at', now()
  );
end;
$$;

grant execute on function public.submit_decision_response(text, text, jsonb, text) to anon, authenticated, service_role;

-- ---------------- 9. 状态流转 RPC ----------------
create or replace function public.close_decision_form(p_slug text)
returns void
language plpgsql
security definer
as $$
begin
  update public.decision_forms
     set status = 'closed',
         closed_at = now(),
         updated_at = now()
   where slug = p_slug;

  if not found then
    raise exception '表单不存在: %', p_slug;
  end if;
end;
$$;

grant execute on function public.close_decision_form(text) to anon, authenticated, service_role;

create or replace function public.open_decision_form(p_slug text)
returns void
language plpgsql
security definer
as $$
begin
  update public.decision_forms
     set status = 'open',
         closed_at = null,
         updated_at = now()
   where slug = p_slug;

  if not found then
    raise exception '表单不存在: %', p_slug;
  end if;
end;
$$;

grant execute on function public.open_decision_form(text) to anon, authenticated, service_role;

commit;
