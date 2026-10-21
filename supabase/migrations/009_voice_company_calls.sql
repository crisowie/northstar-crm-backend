-- Allow voice calls to be linked to a CRM company as well as a contact.
-- Existing calls remain unchanged and unlinked company_id values default to null.

alter table public.crm_voice_calls
  add column if not exists company_id text;

create index if not exists crm_voice_calls_user_company_created_idx
  on public.crm_voice_calls (user_id, company_id, created_at desc);

do $$
begin
  if not exists (
    select 1
    from pg_constraint
    where conname = 'crm_voice_calls_one_crm_record'
      and conrelid = 'public.crm_voice_calls'::regclass
  ) then
    alter table public.crm_voice_calls
      add constraint crm_voice_calls_one_crm_record
      check (contact_id is null or company_id is null);
  end if;
end;
$$;
