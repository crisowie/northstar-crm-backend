-- Gmail credentials and outreach data are accessed only by the authenticated API
-- using the Supabase service role. OAuth tokens are encrypted by the API before
-- they are stored here.

create table if not exists public.crm_email_accounts (
  user_id uuid primary key references auth.users(id) on delete cascade,
  email_address text not null,
  refresh_token_encrypted text not null,
  access_token_encrypted text not null,
  access_token_expires_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table if not exists public.crm_outreach_messages (
  user_id uuid not null references auth.users(id) on delete cascade,
  id uuid not null,
  contact_id text not null,
  opportunity_id text,
  recipient text not null,
  recipient_name text not null default '',
  subject text not null,
  body text not null,
  status text not null check (status in ('sending', 'sent', 'replied', 'failed')),
  sent_at timestamptz,
  replied_at timestamptz,
  gmail_message_id text,
  gmail_thread_id text,
  click_count integer not null default 0 check (click_count >= 0),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  primary key (user_id, id)
);

create table if not exists public.crm_outreach_links (
  token text primary key,
  user_id uuid not null,
  message_id uuid not null,
  target_url text not null,
  click_count integer not null default 0 check (click_count >= 0),
  last_clicked_at timestamptz,
  created_at timestamptz not null default now(),
  foreign key (user_id, message_id) references public.crm_outreach_messages(user_id, id) on delete cascade
);

create index if not exists crm_outreach_messages_user_sent_idx on public.crm_outreach_messages (user_id, sent_at desc);
create index if not exists crm_outreach_messages_user_thread_idx on public.crm_outreach_messages (user_id, gmail_thread_id);
create index if not exists crm_outreach_links_message_idx on public.crm_outreach_links (user_id, message_id);

alter table public.crm_email_accounts enable row level security;
alter table public.crm_outreach_messages enable row level security;
alter table public.crm_outreach_links enable row level security;

grant select, insert, update, delete on public.crm_email_accounts to service_role;
grant select, insert, update, delete on public.crm_outreach_messages to service_role;
grant select, insert, update, delete on public.crm_outreach_links to service_role;

create or replace function public.record_outreach_click(p_token text)
returns table(target_url text)
language plpgsql
security definer
set search_path = public
as $$
declare
  v_target_url text;
  v_user_id uuid;
  v_message_id uuid;
begin
  update public.crm_outreach_links as link
  set click_count = link.click_count + 1,
      last_clicked_at = now()
  where link.token = p_token
  returning link.target_url, link.user_id, link.message_id
  into v_target_url, v_user_id, v_message_id;

  if not found then
    return;
  end if;

  update public.crm_outreach_messages as message
  set click_count = message.click_count + 1,
      updated_at = now()
  where message.user_id = v_user_id and message.id = v_message_id;

  return query select v_target_url;
end;
$$;

revoke all on function public.record_outreach_click(text) from public, anon, authenticated;
grant execute on function public.record_outreach_click(text) to service_role;
