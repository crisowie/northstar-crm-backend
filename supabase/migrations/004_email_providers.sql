-- Add provider metadata and unified event storage without dropping or rewriting
-- existing CRM, Gmail, message, or click-history tables.

alter table public.crm_email_accounts
  add column if not exists history_id text,
  add column if not exists last_success_at timestamptz,
  add column if not exists last_error text;

alter table public.crm_outreach_messages
  add column if not exists provider text,
  add column if not exists sender_account text,
  add column if not exists provider_message_id text,
  add column if not exists provider_thread_id text,
  add column if not exists provider_capabilities jsonb,
  add column if not exists idempotency_key uuid,
  add column if not exists recipient_opted_in boolean;

update public.crm_outreach_messages
set provider = coalesce(provider, 'gmail'),
    provider_message_id = coalesce(provider_message_id, gmail_message_id),
    provider_thread_id = coalesce(provider_thread_id, gmail_thread_id),
    idempotency_key = coalesce(idempotency_key, id),
    recipient_opted_in = coalesce(recipient_opted_in, false),
    provider_capabilities = coalesce(provider_capabilities, '{"sending":true,"inboundSynchronization":true,"webhooks":false,"bounceReporting":false,"deliveryEvents":false,"openTracking":false,"clickTracking":true}'::jsonb)
where provider is null
   or idempotency_key is null
   or provider_capabilities is null;

alter table public.crm_outreach_messages
  alter column provider set default 'gmail',
  alter column provider set not null,
  alter column idempotency_key set not null,
  alter column recipient_opted_in set default false,
  alter column recipient_opted_in set not null,
  alter column provider_capabilities set default '{}'::jsonb,
  alter column provider_capabilities set not null;

alter table public.crm_outreach_messages
  drop constraint if exists crm_outreach_messages_status_check;

alter table public.crm_outreach_messages
  add constraint crm_outreach_messages_status_check
  check (status in ('sending', 'sent', 'accepted', 'delivered', 'bounced', 'complained', 'replied', 'failed'));

alter table public.crm_outreach_messages
  drop constraint if exists crm_outreach_messages_provider_check;

alter table public.crm_outreach_messages
  add constraint crm_outreach_messages_provider_check
  check (provider in ('gmail', 'ses', 'resend'));

create unique index if not exists crm_outreach_messages_user_idempotency_idx
  on public.crm_outreach_messages (user_id, idempotency_key);

create index if not exists crm_outreach_messages_provider_message_idx
  on public.crm_outreach_messages (user_id, provider, provider_message_id)
  where provider_message_id is not null;

create table if not exists public.crm_email_provider_configs (
  user_id uuid not null references auth.users(id) on delete cascade,
  provider text not null check (provider in ('ses', 'resend')),
  configuration_encrypted text not null,
  configuration_source text not null default 'workspace' check (configuration_source in ('workspace', 'environment')),
  sender_email text not null,
  is_active boolean not null default false,
  health jsonb not null default '{}'::jsonb,
  last_success_at timestamptz,
  last_error text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  primary key (user_id, provider)
);

alter table public.crm_email_provider_configs
  add column if not exists configuration_source text not null default 'workspace';

alter table public.crm_email_provider_configs
  drop constraint if exists crm_email_provider_configs_configuration_source_check;

alter table public.crm_email_provider_configs
  add constraint crm_email_provider_configs_configuration_source_check
  check (configuration_source in ('workspace', 'environment'));

create table if not exists public.crm_email_provider_preferences (
  user_id uuid primary key references auth.users(id) on delete cascade,
  default_provider text not null default 'gmail'
    check (default_provider in ('gmail', 'ses', 'resend')),
  sending_paused boolean not null default false,
  updated_at timestamptz not null default now()
);

alter table public.crm_email_provider_preferences
  add column if not exists sending_paused boolean not null default false;

create table if not exists public.crm_email_suppressions (
  user_id uuid not null references auth.users(id) on delete cascade,
  email_address text not null,
  reason text not null check (reason in ('hard_bounce', 'complaint', 'unsubscribe', 'manual')),
  provider text not null check (provider in ('gmail', 'ses', 'resend')),
  source_event_id text,
  created_at timestamptz not null default now(),
  primary key (user_id, email_address)
);

create table if not exists public.crm_email_events (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  message_id uuid,
  provider text not null check (provider in ('gmail', 'ses', 'resend')),
  provider_message_id text,
  sender_account text,
  event_type text not null check (event_type in (
    'queued', 'sending', 'sent', 'provider_accepted', 'delivered', 'bounced',
    'complaint', 'failed', 'opened', 'clicked', 'reply_received', 'unsubscribed'
  )),
  event_timestamp timestamptz not null default now(),
  provider_event_id text not null,
  details jsonb not null default '{}'::jsonb,
  processing_status text not null default 'processed'
    check (processing_status in ('received', 'processed', 'ignored', 'failed')),
  event_source text not null,
  created_at timestamptz not null default now(),
  foreign key (user_id, message_id)
    references public.crm_outreach_messages(user_id, id) on delete set null (message_id)
);

create unique index if not exists crm_email_events_provider_event_idx
  on public.crm_email_events (provider, provider_event_id);

create index if not exists crm_email_events_user_message_time_idx
  on public.crm_email_events (user_id, message_id, event_timestamp desc);

alter table public.crm_email_provider_configs enable row level security;
alter table public.crm_email_provider_preferences enable row level security;
alter table public.crm_email_suppressions enable row level security;
alter table public.crm_email_events enable row level security;

grant select, insert, update, delete on public.crm_email_provider_configs to service_role;
grant select, insert, update, delete on public.crm_email_provider_preferences to service_role;
grant select, insert, update, delete on public.crm_email_suppressions to service_role;
grant select, insert, update, delete on public.crm_email_events to service_role;

-- Preserve every prior click counter and URL. New clicks also enter the unified
-- event log using a deterministic per-link counter as the idempotency key.
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
  v_click_count integer;
  v_provider text;
  v_provider_message_id text;
  v_sender_account text;
begin
  update public.crm_outreach_links as link
  set click_count = link.click_count + 1,
      last_clicked_at = now()
  where link.token = p_token
  returning link.target_url, link.user_id, link.message_id, link.click_count
  into v_target_url, v_user_id, v_message_id, v_click_count;

  if not found then
    return;
  end if;

  update public.crm_outreach_messages as message
  set click_count = message.click_count + 1,
      updated_at = now()
  where message.user_id = v_user_id and message.id = v_message_id
  returning message.provider, message.provider_message_id, message.sender_account
  into v_provider, v_provider_message_id, v_sender_account;

  insert into public.crm_email_events (
    user_id, message_id, provider, provider_message_id, sender_account,
    event_type, event_timestamp, provider_event_id, details, processing_status, event_source
  ) values (
    v_user_id, v_message_id, coalesce(v_provider, 'gmail'), v_provider_message_id, v_sender_account,
    'clicked', now(), 'tracked-link:' || p_token || ':' || v_click_count,
    '{}'::jsonb, 'processed', 'internal_tracking'
  ) on conflict (provider, provider_event_id) do nothing;

  return query select v_target_url;
end;
$$;

revoke all on function public.record_outreach_click(text) from public, anon, authenticated;
grant execute on function public.record_outreach_click(text) to service_role;
