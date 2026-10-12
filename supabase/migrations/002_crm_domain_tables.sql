-- Split the original JSON workspace into domain tables while keeping each row's
-- full frontend record in payload for safe schema evolution.

create table if not exists public.crm_settings (
  user_id uuid primary key,
  organization text not null default 'My workspace',
  pipeline_stages jsonb not null default '["Lead Identified", "Qualified", "Discovery", "Proposal", "Negotiation", "Won", "Lost"]'::jsonb,
  job_statuses jsonb not null default '["New", "Planned", "In Progress", "On Hold", "Completed", "Cancelled"]'::jsonb,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table if not exists public.crm_contacts (
  user_id uuid not null,
  id text not null,
  position integer not null default 0 check (position >= 0),
  payload jsonb not null check (jsonb_typeof(payload) = 'object'),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  primary key (user_id, id),
  check (id = payload->>'id')
);

create table if not exists public.crm_companies (
  user_id uuid not null,
  id text not null,
  position integer not null default 0 check (position >= 0),
  payload jsonb not null check (jsonb_typeof(payload) = 'object'),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  primary key (user_id, id),
  check (id = payload->>'id')
);

create table if not exists public.crm_jobs (
  user_id uuid not null,
  id text not null,
  position integer not null default 0 check (position >= 0),
  payload jsonb not null check (jsonb_typeof(payload) = 'object'),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  primary key (user_id, id),
  check (id = payload->>'id')
);

create table if not exists public.crm_opportunities (
  user_id uuid not null,
  id text not null,
  position integer not null default 0 check (position >= 0),
  payload jsonb not null check (jsonb_typeof(payload) = 'object'),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  primary key (user_id, id),
  check (id = payload->>'id')
);

create table if not exists public.crm_tasks (
  user_id uuid not null,
  id text not null,
  position integer not null default 0 check (position >= 0),
  payload jsonb not null check (jsonb_typeof(payload) = 'object'),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  primary key (user_id, id),
  check (id = payload->>'id')
);

create table if not exists public.crm_notes (
  user_id uuid not null,
  id text not null,
  position integer not null default 0 check (position >= 0),
  payload jsonb not null check (jsonb_typeof(payload) = 'object'),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  primary key (user_id, id),
  check (id = payload->>'id')
);

create table if not exists public.crm_activities (
  user_id uuid not null,
  id text not null,
  position integer not null default 0 check (position >= 0),
  payload jsonb not null check (jsonb_typeof(payload) = 'object'),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  primary key (user_id, id),
  check (id = payload->>'id')
);

create index if not exists crm_contacts_user_position_idx on public.crm_contacts (user_id, position);
create index if not exists crm_contacts_user_email_idx on public.crm_contacts (user_id, lower(payload->>'email'));
create index if not exists crm_companies_user_position_idx on public.crm_companies (user_id, position);
create index if not exists crm_jobs_user_position_idx on public.crm_jobs (user_id, position);
create index if not exists crm_opportunities_user_position_idx on public.crm_opportunities (user_id, position);
create index if not exists crm_tasks_user_position_idx on public.crm_tasks (user_id, position);
create index if not exists crm_notes_user_position_idx on public.crm_notes (user_id, position);
create index if not exists crm_activities_user_position_idx on public.crm_activities (user_id, position);

alter table public.crm_settings enable row level security;
alter table public.crm_contacts enable row level security;
alter table public.crm_companies enable row level security;
alter table public.crm_jobs enable row level security;
alter table public.crm_opportunities enable row level security;
alter table public.crm_tasks enable row level security;
alter table public.crm_notes enable row level security;
alter table public.crm_activities enable row level security;

do $$
declare
  table_name text;
begin
  foreach table_name in array array[
    'crm_settings', 'crm_contacts', 'crm_companies', 'crm_jobs',
    'crm_opportunities', 'crm_tasks', 'crm_notes', 'crm_activities'
  ] loop
    execute format('grant select, insert, update, delete on public.%I to authenticated', table_name);
    execute format('grant select, insert, update, delete on public.%I to service_role', table_name);
    execute format('drop policy if exists "Users access their own %I" on public.%I', table_name, table_name);
    execute format(
      'create policy "Users access their own %I" on public.%I for all to authenticated using (auth.uid() = user_id) with check (auth.uid() = user_id)',
      table_name, table_name
    );
  end loop;
end $$;

-- Preserve workspaces created by migration 001.
insert into public.crm_settings (user_id, organization, pipeline_stages, job_statuses)
select
  user_id,
  coalesce(nullif(data->>'organization', ''), 'My workspace'),
  coalesce(data->'pipelineStages', '["Lead Identified", "Qualified", "Discovery", "Proposal", "Negotiation", "Won", "Lost"]'::jsonb),
  coalesce(data->'jobStatuses', '["New", "Planned", "In Progress", "On Hold", "Completed", "Cancelled"]'::jsonb)
from public.crm_workspaces
on conflict (user_id) do nothing;

insert into public.crm_contacts (user_id, id, position, payload)
select w.user_id, item.value->>'id', (item.ordinality - 1)::integer, item.value
from public.crm_workspaces w
cross join lateral jsonb_array_elements(coalesce(w.data->'contacts', '[]'::jsonb)) with ordinality as item(value, ordinality)
where item.value->>'id' is not null
on conflict (user_id, id) do nothing;

insert into public.crm_companies (user_id, id, position, payload)
select w.user_id, item.value->>'id', (item.ordinality - 1)::integer, item.value
from public.crm_workspaces w
cross join lateral jsonb_array_elements(coalesce(w.data->'companies', '[]'::jsonb)) with ordinality as item(value, ordinality)
where item.value->>'id' is not null
on conflict (user_id, id) do nothing;

insert into public.crm_jobs (user_id, id, position, payload)
select w.user_id, item.value->>'id', (item.ordinality - 1)::integer, item.value
from public.crm_workspaces w
cross join lateral jsonb_array_elements(coalesce(w.data->'jobs', '[]'::jsonb)) with ordinality as item(value, ordinality)
where item.value->>'id' is not null
on conflict (user_id, id) do nothing;

insert into public.crm_opportunities (user_id, id, position, payload)
select w.user_id, item.value->>'id', (item.ordinality - 1)::integer, item.value
from public.crm_workspaces w
cross join lateral jsonb_array_elements(coalesce(w.data->'opportunities', '[]'::jsonb)) with ordinality as item(value, ordinality)
where item.value->>'id' is not null
on conflict (user_id, id) do nothing;

insert into public.crm_tasks (user_id, id, position, payload)
select w.user_id, item.value->>'id', (item.ordinality - 1)::integer, item.value
from public.crm_workspaces w
cross join lateral jsonb_array_elements(coalesce(w.data->'tasks', '[]'::jsonb)) with ordinality as item(value, ordinality)
where item.value->>'id' is not null
on conflict (user_id, id) do nothing;

insert into public.crm_notes (user_id, id, position, payload)
select w.user_id, item.value->>'id', (item.ordinality - 1)::integer, item.value
from public.crm_workspaces w
cross join lateral jsonb_array_elements(coalesce(w.data->'notes', '[]'::jsonb)) with ordinality as item(value, ordinality)
where item.value->>'id' is not null
on conflict (user_id, id) do nothing;

insert into public.crm_activities (user_id, id, position, payload)
select w.user_id, item.value->>'id', (item.ordinality - 1)::integer, item.value
from public.crm_workspaces w
cross join lateral jsonb_array_elements(coalesce(w.data->'activities', '[]'::jsonb)) with ordinality as item(value, ordinality)
where item.value->>'id' is not null
on conflict (user_id, id) do nothing;

-- Replace a user's workspace atomically from the NestJS service after auth checks.
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

  delete from public.crm_contacts where user_id = p_user_id;
  insert into public.crm_contacts (user_id, id, position, payload)
  select p_user_id, item.value->>'id', (item.ordinality - 1)::integer, item.value
  from jsonb_array_elements(coalesce(p_data->'contacts', '[]'::jsonb)) with ordinality as item(value, ordinality);

  delete from public.crm_companies where user_id = p_user_id;
  insert into public.crm_companies (user_id, id, position, payload)
  select p_user_id, item.value->>'id', (item.ordinality - 1)::integer, item.value
  from jsonb_array_elements(coalesce(p_data->'companies', '[]'::jsonb)) with ordinality as item(value, ordinality);

  delete from public.crm_jobs where user_id = p_user_id;
  insert into public.crm_jobs (user_id, id, position, payload)
  select p_user_id, item.value->>'id', (item.ordinality - 1)::integer, item.value
  from jsonb_array_elements(coalesce(p_data->'jobs', '[]'::jsonb)) with ordinality as item(value, ordinality);

  delete from public.crm_opportunities where user_id = p_user_id;
  insert into public.crm_opportunities (user_id, id, position, payload)
  select p_user_id, item.value->>'id', (item.ordinality - 1)::integer, item.value
  from jsonb_array_elements(coalesce(p_data->'opportunities', '[]'::jsonb)) with ordinality as item(value, ordinality);

  delete from public.crm_tasks where user_id = p_user_id;
  insert into public.crm_tasks (user_id, id, position, payload)
  select p_user_id, item.value->>'id', (item.ordinality - 1)::integer, item.value
  from jsonb_array_elements(coalesce(p_data->'tasks', '[]'::jsonb)) with ordinality as item(value, ordinality);

  delete from public.crm_notes where user_id = p_user_id;
  insert into public.crm_notes (user_id, id, position, payload)
  select p_user_id, item.value->>'id', (item.ordinality - 1)::integer, item.value
  from jsonb_array_elements(coalesce(p_data->'notes', '[]'::jsonb)) with ordinality as item(value, ordinality);

  delete from public.crm_activities where user_id = p_user_id;
  insert into public.crm_activities (user_id, id, position, payload)
  select p_user_id, item.value->>'id', (item.ordinality - 1)::integer, item.value
  from jsonb_array_elements(coalesce(p_data->'activities', '[]'::jsonb)) with ordinality as item(value, ordinality);
end;
$$;

revoke all on function public.save_crm_workspace(uuid, jsonb) from public, anon, authenticated;
grant execute on function public.save_crm_workspace(uuid, jsonb) to service_role;
