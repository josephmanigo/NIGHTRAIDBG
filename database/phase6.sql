-- Run this once in Supabase SQL Editor after phase5.sql.

alter table public.clan_applications
  add column if not exists excel_sync_status text not null default 'NOT_STARTED'
    check (excel_sync_status in ('NOT_STARTED', 'PENDING', 'SYNCED', 'FAILED')),
  add column if not exists excel_synced_at timestamptz,
  add column if not exists excel_sync_error text;

create table if not exists public.excel_exports (
  id uuid primary key default gen_random_uuid(),
  export_type text not null check (export_type in ('MASTER_SYNC', 'MANUAL_ALL', 'MANUAL_FILTERED', 'MANUAL_SELECTED')),
  filters jsonb not null default '{}',
  record_count integer not null default 0 check (record_count >= 0),
  generated_by text not null,
  storage_path text,
  status text not null check (status in ('COMPLETED', 'FAILED')),
  error_message text,
  created_at timestamptz not null default now()
);

create index if not exists excel_exports_created_idx
  on public.excel_exports (created_at desc);

alter table public.excel_exports enable row level security;

insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values (
  'nightraid-excel',
  'nightraid-excel',
  false,
  52428800,
  array['application/vnd.openxmlformats-officedocument.spreadsheetml.sheet']
)
on conflict (id) do update set
  public = excluded.public,
  file_size_limit = excluded.file_size_limit,
  allowed_mime_types = excluded.allowed_mime_types;

comment on table public.excel_exports is
  'Audit records for automatic NIGHTRAID workbook synchronization and administrator Excel exports.';
