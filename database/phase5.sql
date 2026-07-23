-- Run this once in Supabase SQL Editor after phase4.sql.

alter table public.clan_applications
  add column if not exists messenger_notification_status text not null default 'NOT_STARTED'
    check (messenger_notification_status in ('NOT_STARTED', 'PROCESSING', 'COMPLETED', 'FAILED')),
  add column if not exists messenger_notification_error text,
  add column if not exists messenger_notified_at timestamptz,
  add column if not exists messenger_message_ids text[] not null default '{}';

create table if not exists public.messenger_admins (
  id uuid primary key default gen_random_uuid(),
  facebook_psid text not null unique,
  display_name text not null,
  role text not null default 'REVIEWER' check (role in ('OWNER', 'ADMIN', 'REVIEWER')),
  can_approve boolean not null default false,
  can_reject boolean not null default false,
  is_active boolean not null default true,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table if not exists public.messenger_notification_logs (
  id uuid primary key default gen_random_uuid(),
  application_id uuid not null references public.clan_applications(id) on delete cascade,
  messenger_admin_id uuid references public.messenger_admins(id) on delete set null,
  recipient_psid text not null,
  status text not null check (status in ('COMPLETED', 'FAILED')),
  message_ids text[] not null default '{}',
  error_message text,
  created_at timestamptz not null default now()
);

create index if not exists messenger_notification_logs_application_idx
  on public.messenger_notification_logs (application_id, created_at desc);

create table if not exists public.messenger_webhook_events (
  id uuid primary key default gen_random_uuid(),
  external_event_id text not null unique,
  sender_psid text not null,
  event_type text not null,
  payload jsonb not null default '{}',
  processing_status text not null default 'PROCESSING'
    check (processing_status in ('PROCESSING', 'COMPLETED', 'FAILED', 'IGNORED')),
  error_message text,
  received_at timestamptz not null default now(),
  processed_at timestamptz
);

create table if not exists public.application_decisions (
  id uuid primary key default gen_random_uuid(),
  application_id uuid not null references public.clan_applications(id) on delete cascade,
  decision text not null check (decision in ('APPROVED', 'REJECTED')),
  decision_reason text,
  decision_source text not null check (decision_source in ('WEB', 'MESSENGER')),
  decided_by text not null,
  decided_at timestamptz not null default now()
);

create index if not exists application_decisions_application_idx
  on public.application_decisions (application_id, decided_at desc);

create or replace function public.decide_clan_application(
  p_application_id uuid,
  p_decision text,
  p_reason text,
  p_source text,
  p_decided_by text
)
returns setof public.clan_applications
language plpgsql
security definer
set search_path = public
as $$
declare
  decided_application public.clan_applications%rowtype;
begin
  if p_decision not in ('APPROVED', 'REJECTED') then
    raise exception 'INVALID_DECISION' using errcode = '22023';
  end if;
  if p_source not in ('WEB', 'MESSENGER') then
    raise exception 'INVALID_DECISION_SOURCE' using errcode = '22023';
  end if;
  if p_decision = 'REJECTED' and coalesce(length(trim(p_reason)), 0) < 2 then
    raise exception 'REJECTION_REASON_REQUIRED' using errcode = '22023';
  end if;

  update public.clan_applications
  set status = p_decision,
      reviewed_by = p_decided_by,
      reviewed_at = now(),
      decision_reason = case when p_decision = 'REJECTED' then trim(p_reason) else null end,
      updated_at = now()
  where id = p_application_id
    and status in ('SUBMITTED', 'PENDING_REVIEW')
  returning * into decided_application;

  if not found then
    raise exception 'APPLICATION_NOT_PENDING' using errcode = 'P0001';
  end if;

  insert into public.application_decisions (
    application_id,
    decision,
    decision_reason,
    decision_source,
    decided_by
  ) values (
    decided_application.id,
    p_decision,
    decided_application.decision_reason,
    p_source,
    p_decided_by
  );

  return next decided_application;
end;
$$;

revoke all on function public.decide_clan_application(uuid, text, text, text, text) from public, anon, authenticated;
grant execute on function public.decide_clan_application(uuid, text, text, text, text) to service_role;

alter table public.messenger_admins enable row level security;
alter table public.messenger_notification_logs enable row level security;
alter table public.messenger_webhook_events enable row level security;
alter table public.application_decisions enable row level security;

comment on table public.messenger_admins is
  'Allowlisted Page-scoped Messenger identities authorized to review NightRaid applications.';
comment on table public.application_decisions is
  'Immutable administrator decision audit records from the web portal and Messenger.';
