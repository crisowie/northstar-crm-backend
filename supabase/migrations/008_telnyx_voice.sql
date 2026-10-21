-- Additive voice-call storage. Existing CRM tables and policies are not changed.
-- The NestJS API accesses these tables with its server-only Supabase service role.

create table if not exists public.crm_voice_sessions (
  id uuid primary key,
  user_id uuid not null,
  telnyx_credential_id text not null unique,
  sip_username text not null,
  connection_id text not null,
  expires_at timestamptz not null,
  revoked_at timestamptz,
  created_at timestamptz not null default now()
);

create index if not exists crm_voice_sessions_user_created_idx
  on public.crm_voice_sessions (user_id, created_at desc);

create table if not exists public.crm_voice_calls (
  id uuid primary key,
  user_id uuid not null,
  session_id uuid not null references public.crm_voice_sessions(id),
  contact_id text,
  idempotency_key text not null,
  destination text not null,
  caller_number text not null,
  provider text not null default 'telnyx' check (provider = 'telnyx'),
  status text not null check (status in ('authorized','connecting','dialing','connected','ending','ended','failed','cancelled')),
  webrtc_call_control_id text,
  pstn_call_control_id text,
  started_at timestamptz not null,
  answered_at timestamptz,
  ended_at timestamptz,
  duration_seconds integer check (duration_seconds is null or duration_seconds >= 0),
  failure_reason text,
  outcome text,
  note text,
  follow_up_date date,
  follow_up_task_id text,
  end_requested_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (user_id, idempotency_key)
);

create index if not exists crm_voice_calls_user_contact_created_idx
  on public.crm_voice_calls (user_id, contact_id, created_at desc);
create index if not exists crm_voice_calls_user_status_idx
  on public.crm_voice_calls (user_id, status);
create unique index if not exists crm_voice_calls_one_active_per_user_idx
  on public.crm_voice_calls (user_id)
  where status in ('authorized','connecting','dialing','connected','ending');
create unique index if not exists crm_voice_calls_webrtc_control_idx
  on public.crm_voice_calls (webrtc_call_control_id) where webrtc_call_control_id is not null;
create unique index if not exists crm_voice_calls_pstn_control_idx
  on public.crm_voice_calls (pstn_call_control_id) where pstn_call_control_id is not null;

create table if not exists public.crm_voice_webhook_events (
  id text primary key,
  event_type text not null,
  processing_status text not null check (processing_status in ('processing','processed','failed')),
  last_error text,
  created_at timestamptz not null default now(),
  processed_at timestamptz
);
create index if not exists crm_voice_webhook_events_created_idx
  on public.crm_voice_webhook_events (created_at desc);

alter table public.crm_voice_sessions enable row level security;
alter table public.crm_voice_calls enable row level security;
alter table public.crm_voice_webhook_events enable row level security;
revoke all on public.crm_voice_sessions, public.crm_voice_calls, public.crm_voice_webhook_events from public, anon, authenticated;
grant select, insert, update, delete on public.crm_voice_sessions, public.crm_voice_calls, public.crm_voice_webhook_events to service_role;
