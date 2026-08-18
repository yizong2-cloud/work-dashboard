-- 决策中心：提交身份改为完全选填。
-- 保留 respondent_name 列与 RPC 入参，避免影响已存在的反馈、CLI 与导出契约。

begin;

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
    if not v_q.allow_other and v_other_text <> '' then
      raise exception '题目 %（%）未开启“其他”选项，禁止提交其他说明', v_q.code, v_q.title;
    end if;
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

    if v_q.type = 'single_choice' then
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
      if v_q.required and v_opt_count = 0 and v_other_text = '' then
        raise exception '必答多选题 % 未作答', v_q.code;
      end if;
      if v_opt_count > 0 or v_other_text <> '' then
        v_answered_q_ids := array_append(v_answered_q_ids, v_q.id);
      end if;
    elsif v_q.type = 'free_text' then
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

  for v_req_q in select id, code from public.decision_questions where form_id = v_form.id and required = true loop
    if not (v_req_q.id = any(v_answered_q_ids)) then
      raise exception '必答题未完成: %', v_req_q.code;
    end if;
  end loop;

  insert into public.decision_responses (form_id, respondent_name, respondent_note)
  values (v_form.id, p_respondent_name, v_clean_note)
  returning id into v_response_id;

  for v_idx in 0 .. jsonb_array_length(p_answers) - 1 loop
    v_ans := p_answers->v_idx;
    v_q_id := (v_ans->>'question_id')::uuid;
    v_selected_opts := coalesce(v_ans->'selected_option_ids', '[]'::jsonb);
    v_text_ans := coalesce(v_ans->>'text_answer', '');
    v_other_text := coalesce(v_ans->>'other_text', '');
    insert into public.decision_answers (response_id, question_id, selected_option_ids, text_answer, other_text)
    values (v_response_id, v_q_id, v_selected_opts, v_text_ans, v_other_text);
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

commit;
