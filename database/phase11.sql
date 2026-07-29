-- NIGHTRAID Loop 7: audited writes to the Copy of New test worksheet.
-- Apply after database/phase10.sql. This table stores a complete backup before
-- any spreadsheet write and supports guarded rollback.

create table if not exists public.game_result_sheet_write_audits (
  id uuid primary key default gen_random_uuid(),
  submission_id uuid not null references public.game_result_submissions(id) on delete restrict,
  spreadsheet_id text not null,
  worksheet_name text not null check (worksheet_name = 'Copy of New'),
  sheet_id bigint not null,
  round_number smallint not null check (round_number between 1 and 4),
  status text not null check (
    status in (
      'preparing',
      'written',
      'verified',
      'failed',
      'rolled_back',
      'rollback_failed'
    )
  ),
  sheet_write_applied boolean not null default false,
  target_cells jsonb not null,
  before_snapshot jsonb not null,
  after_snapshot jsonb,
  write_payload jsonb not null,
  verification jsonb,
  error text,
  created_by text not null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  rolled_back_by text,
  rolled_back_at timestamptz
);

create unique index if not exists game_result_sheet_write_active_submission_idx
  on public.game_result_sheet_write_audits (submission_id)
  where
    status in ('preparing', 'written', 'verified')
    or (status in ('failed', 'rollback_failed') and sheet_write_applied);

create index if not exists game_result_sheet_write_audits_created_idx
  on public.game_result_sheet_write_audits (created_at desc);

create or replace function public.set_game_result_sheet_write_audit_updated_at()
returns trigger
language plpgsql
set search_path = public
as $$
begin
  new.updated_at = now();
  return new;
end;
$$;

drop trigger if exists game_result_sheet_write_audits_updated_at
  on public.game_result_sheet_write_audits;
create trigger game_result_sheet_write_audits_updated_at
before update on public.game_result_sheet_write_audits
for each row execute function public.set_game_result_sheet_write_audit_updated_at();

alter table public.game_result_sheet_write_audits enable row level security;

revoke all on table public.game_result_sheet_write_audits from anon, authenticated;
grant select, insert, update on table public.game_result_sheet_write_audits to service_role;

comment on table public.game_result_sheet_write_audits is
  'Loop 7 before/after backups and rollback state for Copy of New PLACE/KILLS writes only.';
