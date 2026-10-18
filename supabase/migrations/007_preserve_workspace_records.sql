-- Merge records by ID so a partial or stale client snapshot cannot delete
-- records that were not included in that save request.
create or replace function public.save_crm_workspace(p_user_id uuid, p_data jsonb)
returns void
language plpgsql
security definer
set search_path = public
as $$
begin
  if jsonb_typeof(p_data) <> 'object' then
    raise exception 'Workspace data must be a JSON object';
  end if;

  insert into public.crm_settings (user_id, organization, pipeline_stages, job_statuses, updated_at)
  values (
    p_user_id,
    coalesce(nullif(p_data->>'organization', ''), 'My workspace'),
    coalesce(p_data->'pipelineStages', '[]'::jsonb),
    coalesce(p_data->'jobStatuses', '[]'::jsonb),
    now()
  )
  on conflict (user_id) do update set
    organization = excluded.organization,
    pipeline_stages = excluded.pipeline_stages,
    job_statuses = excluded.job_statuses,
    updated_at = now();

  insert into public.crm_contacts (user_id, id, position, payload)
  select p_user_id, item.value->>'id', (item.ordinality - 1)::integer, item.value
  from jsonb_array_elements(coalesce(p_data->'contacts', '[]'::jsonb)) with ordinality as item(value, ordinality)
  on conflict (user_id, id) do update set
    position = excluded.position,
    payload = excluded.payload,
    updated_at = now();

  insert into public.crm_companies (user_id, id, position, payload)
  select p_user_id, item.value->>'id', (item.ordinality - 1)::integer, item.value
  from jsonb_array_elements(coalesce(p_data->'companies', '[]'::jsonb)) with ordinality as item(value, ordinality)
  on conflict (user_id, id) do update set
    position = excluded.position,
    payload = excluded.payload,
    updated_at = now();

  insert into public.crm_jobs (user_id, id, position, payload)
  select p_user_id, item.value->>'id', (item.ordinality - 1)::integer, item.value
  from jsonb_array_elements(coalesce(p_data->'jobs', '[]'::jsonb)) with ordinality as item(value, ordinality)
  on conflict (user_id, id) do update set
    position = excluded.position,
    payload = excluded.payload,
    updated_at = now();

  insert into public.crm_opportunities (user_id, id, position, payload)
  select p_user_id, item.value->>'id', (item.ordinality - 1)::integer, item.value
  from jsonb_array_elements(coalesce(p_data->'opportunities', '[]'::jsonb)) with ordinality as item(value, ordinality)
  on conflict (user_id, id) do update set
    position = excluded.position,
    payload = excluded.payload,
    updated_at = now();

  insert into public.crm_tasks (user_id, id, position, payload)
  select p_user_id, item.value->>'id', (item.ordinality - 1)::integer, item.value
  from jsonb_array_elements(coalesce(p_data->'tasks', '[]'::jsonb)) with ordinality as item(value, ordinality)
  on conflict (user_id, id) do update set
    position = excluded.position,
    payload = excluded.payload,
    updated_at = now();

  insert into public.crm_notes (user_id, id, position, payload)
  select p_user_id, item.value->>'id', (item.ordinality - 1)::integer, item.value
  from jsonb_array_elements(coalesce(p_data->'notes', '[]'::jsonb)) with ordinality as item(value, ordinality)
  on conflict (user_id, id) do update set
    position = excluded.position,
    payload = excluded.payload,
    updated_at = now();

  insert into public.crm_activities (user_id, id, position, payload)
  select p_user_id, item.value->>'id', (item.ordinality - 1)::integer, item.value
  from jsonb_array_elements(coalesce(p_data->'activities', '[]'::jsonb)) with ordinality as item(value, ordinality)
  on conflict (user_id, id) do update set
    position = excluded.position,
    payload = excluded.payload,
    updated_at = now();
end;
$$;

revoke all on function public.save_crm_workspace(uuid, jsonb) from public, anon, authenticated;
grant execute on function public.save_crm_workspace(uuid, jsonb) to service_role;
