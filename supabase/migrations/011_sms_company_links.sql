-- Extend SMS history to allow a message linked to a company instead of a contact.
alter table public.crm_sms_messages
  alter column contact_id drop not null;

alter table public.crm_sms_messages
  add column if not exists company_id text;

do $$
begin
  if not exists (
    select 1
    from pg_constraint
    where conname = 'crm_sms_messages_one_record_check'
      and conrelid = 'public.crm_sms_messages'::regclass
  ) then
    alter table public.crm_sms_messages
      add constraint crm_sms_messages_one_record_check
      check ((contact_id is not null) <> (company_id is not null));
  end if;
end
$$;

create index if not exists crm_sms_messages_user_company_created_idx
  on public.crm_sms_messages (user_id, company_id, created_at desc);
