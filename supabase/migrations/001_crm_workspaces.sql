create table if not exists public.crm_workspaces (
  user_id uuid primary key references auth.users (id) on delete cascade,
  data jsonb not null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

alter table public.crm_workspaces enable row level security;

grant select, insert, update on public.crm_workspaces to authenticated;

drop policy if exists "Users can read their own CRM workspace" on public.crm_workspaces;
create policy "Users can read their own CRM workspace"
  on public.crm_workspaces for select to authenticated
  using (auth.uid() = user_id);

drop policy if exists "Users can create their own CRM workspace" on public.crm_workspaces;
create policy "Users can create their own CRM workspace"
  on public.crm_workspaces for insert to authenticated
  with check (auth.uid() = user_id);

drop policy if exists "Users can update their own CRM workspace" on public.crm_workspaces;
create policy "Users can update their own CRM workspace"
  on public.crm_workspaces for update to authenticated
  using (auth.uid() = user_id)
  with check (auth.uid() = user_id);
