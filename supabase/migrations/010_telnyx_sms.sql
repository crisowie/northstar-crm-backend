-- Additive, server-only storage for authenticated one-to-one SMS history.
create table if not exists public.crm_sms_messages (
  id uuid primary key,
  user_id uuid not null,
  idempotency_key text not null,
  contact_id text not null,
  destination text not null,
  sender_number text not null,
  body text not null,
  provider_message_id text,
  status text not null check (status in ('sending','queued','sent','delivered','sending_failed','delivery_failed','delivery_unconfirmed','failed')),
  failure_reason text,
  sent_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (user_id, idempotency_key)
);

create index if not exists crm_sms_messages_user_created_idx
  on public.crm_sms_messages (user_id, created_at desc);
create unique index if not exists crm_sms_messages_provider_message_idx
  on public.crm_sms_messages (provider_message_id) where provider_message_id is not null;

alter table public.crm_sms_messages enable row level security;
revoke all on public.crm_sms_messages from public, anon, authenticated;
grant select, insert, update, delete on public.crm_sms_messages to service_role;
