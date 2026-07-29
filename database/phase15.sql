-- NIGHTRAID Loop 11: persistent administrative correction operations,
-- reversible round deletion/restoration, and audit-only MVP invalidation.
-- Apply after database/phase14.sql.

alter table public.game_result_history_snapshots
  drop constraint if exists game_result_history_snapshots_record_status_check;
alter table public.game_result_history_snapshots
  add constraint game_result_history_snapshots_record_status_check
  check (record_status in ('active', 'superseded', 'rolled_back', 'deleted'));

alter table public.game_result_player_history
  drop constraint if exists game_result_player_history_record_status_check;
alter table public.game_result_player_history
  add constraint game_result_player_history_record_status_check
  check (record_status in ('active', 'superseded', 'rolled_back', 'deleted'));

alter table public.game_result_mvp_reviews
  add column if not exists invalidated_at timestamptz,
  add column if not exists invalidated_by text,
  add column if not exists invalidation_reason text;

drop index if exists public.game_result_mvp_active_source_idx;
create unique index game_result_mvp_active_source_idx
  on public.game_result_mvp_reviews (
    spreadsheet_id,
    mvp_worksheet_name,
    source_fingerprint
  )
  where status in ('processing', 'confirmed') and invalidated_at is null;

create table if not exists public.game_result_admin_operations (
  id uuid primary key default gen_random_uuid(),
  operation_kind text not null
    check (operation_kind in (
      'edit_round',
      'delete_round',
      'restore_round',
      'reprocess_round',
      'rollback_update',
      'sync_score_sheet'
    )),
  status text not null default 'pending'
    check (status in (
      'pending',
      'processing',
      'completed',
      'cancelled',
      'failed'
    )),
  review_version integer not null default 0 check (review_version >= 0),
  guild_id text not null,
  channel_id text not null,
  review_message_id text,
  score_sheet_mode text not null check (score_sheet_mode = 'production'),
  spreadsheet_id text not null,
  worksheet_name text not null check (worksheet_name = 'New'),
  sheet_id bigint not null check (sheet_id = 417351865),
  round_number smallint not null check (round_number between 1 and 4),
  submission_id uuid not null
    references public.game_result_submissions(id) on delete restrict,
  source_snapshot_id uuid
    references public.game_result_history_snapshots(id) on delete restrict,
  related_sheet_audit_id uuid
    references public.game_result_sheet_write_audits(id) on delete restrict,
  related_operation_id uuid
    references public.game_result_admin_operations(id) on delete restrict,
  requested_changes jsonb not null
    check (jsonb_typeof(requested_changes) = 'object'),
  preview jsonb not null check (jsonb_typeof(preview) = 'object'),
  before_snapshot jsonb not null
    check (jsonb_typeof(before_snapshot) = 'object'),
  after_snapshot jsonb,
  verification jsonb,
  result jsonb,
  sheet_write_applied boolean not null default false,
  history_state_changed boolean not null default false,
  created_by text not null,
  confirmed_by text,
  cancelled_by text,
  error text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  completed_at timestamptz
);

create unique index if not exists game_result_admin_operation_processing_idx
  on public.game_result_admin_operations (score_sheet_mode, round_number)
  where status = 'processing';

create index if not exists game_result_admin_operation_round_idx
  on public.game_result_admin_operations (
    score_sheet_mode,
    round_number,
    created_at desc
  );

create index if not exists game_result_admin_operation_message_idx
  on public.game_result_admin_operations (
    guild_id,
    channel_id,
    review_message_id
  );

drop trigger if exists set_game_result_admin_operations_updated_at
  on public.game_result_admin_operations;
create trigger set_game_result_admin_operations_updated_at
before update on public.game_result_admin_operations
for each row execute function public.set_game_result_submission_updated_at();

create or replace function public.delete_game_result_round_history(
  p_submission_id uuid,
  p_snapshot_id uuid,
  p_actor text
)
returns uuid
language plpgsql
security definer
set search_path = public
as $$
declare
  v_snapshot record;
  v_submission_status public.game_result_submission_status;
begin
  select *
  into v_snapshot
  from public.game_result_history_snapshots
  where id = p_snapshot_id and submission_id = p_submission_id
  for update;
  if not found then raise exception 'round history snapshot not found'; end if;
  if v_snapshot.score_sheet_mode <> 'production' then
    raise exception 'administrative deletion is production-only';
  end if;
  if v_snapshot.record_status <> 'active' then
    raise exception 'only active round history can be deleted';
  end if;

  perform pg_advisory_xact_lock(
    hashtextextended(
      'admin:production:' || v_snapshot.round_number::text,
      0
    )
  );

  select status
  into v_submission_status
  from public.game_result_submissions
  where id = p_submission_id
  for update;
  if not found or v_submission_status <> 'confirmed' then
    raise exception 'only a confirmed round can be deleted';
  end if;

  update public.game_result_player_history
  set
    record_status = 'deleted',
    status_changed_by = p_actor,
    status_changed_at = now()
  where snapshot_id = p_snapshot_id and record_status = 'active';

  update public.game_result_history_snapshots
  set
    record_status = 'deleted',
    status_changed_by = p_actor,
    status_changed_at = now()
  where id = p_snapshot_id and record_status = 'active';
  if not found then raise exception 'round history deletion raced'; end if;

  update public.game_result_submissions
  set status = 'deleted'
  where id = p_submission_id and status = 'confirmed';
  if not found then raise exception 'submission deletion raced'; end if;

  return p_snapshot_id;
end;
$$;

create or replace function public.restore_game_result_round_history(
  p_submission_id uuid,
  p_snapshot_id uuid,
  p_actor text
)
returns uuid
language plpgsql
security definer
set search_path = public
as $$
declare
  v_snapshot record;
  v_submission_status public.game_result_submission_status;
begin
  select *
  into v_snapshot
  from public.game_result_history_snapshots
  where id = p_snapshot_id and submission_id = p_submission_id
  for update;
  if not found then raise exception 'deleted round history snapshot not found'; end if;
  if v_snapshot.score_sheet_mode <> 'production' then
    raise exception 'administrative restoration is production-only';
  end if;
  if v_snapshot.record_status <> 'deleted' then
    raise exception 'only deleted round history can be restored';
  end if;

  perform pg_advisory_xact_lock(
    hashtextextended(
      'admin:production:' || v_snapshot.round_number::text,
      0
    )
  );

  if exists (
    select 1
    from public.game_result_history_snapshots
    where
      score_sheet_mode = 'production'
      and round_number = v_snapshot.round_number
      and record_status = 'active'
  ) then
    raise exception 'another active history already exists for this round';
  end if;

  select status
  into v_submission_status
  from public.game_result_submissions
  where id = p_submission_id
  for update;
  if not found or v_submission_status <> 'deleted' then
    raise exception 'only a deleted submission can be restored';
  end if;

  update public.game_result_history_snapshots
  set
    record_status = 'active',
    status_changed_by = p_actor,
    status_changed_at = now()
  where id = p_snapshot_id and record_status = 'deleted';
  if not found then raise exception 'round history restoration raced'; end if;

  update public.game_result_player_history
  set
    record_status = 'active',
    status_changed_by = p_actor,
    status_changed_at = now()
  where snapshot_id = p_snapshot_id and record_status = 'deleted';

  update public.game_result_submissions
  set status = 'confirmed'
  where id = p_submission_id and status = 'deleted';
  if not found then raise exception 'submission restoration raced'; end if;

  return p_snapshot_id;
end;
$$;

alter table public.game_result_admin_operations enable row level security;

revoke all on table public.game_result_admin_operations from anon, authenticated;
grant select, insert, update on table public.game_result_admin_operations
  to service_role;

revoke all on function public.delete_game_result_round_history(uuid, uuid, text)
  from public, anon, authenticated;
grant execute on function public.delete_game_result_round_history(uuid, uuid, text)
  to service_role;

revoke all on function public.restore_game_result_round_history(uuid, uuid, text)
  from public, anon, authenticated;
grant execute on function public.restore_game_result_round_history(uuid, uuid, text)
  to service_role;

comment on table public.game_result_admin_operations is
  'Append-only command previews, confirmations, before/after values, verification, and actors for Loop 11 administrative corrections.';
