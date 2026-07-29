-- NIGHTRAID Loop 9: append-only player history for every confirmed team and
-- round. Apply after database/phase12.sql.

create table if not exists public.game_result_history_snapshots (
  id uuid primary key default gen_random_uuid(),
  submission_id uuid not null
    references public.game_result_submissions(id) on delete restrict,
  sheet_write_audit_id uuid not null unique
    references public.game_result_sheet_write_audits(id) on delete restrict,
  score_sheet_mode text not null check (score_sheet_mode in ('test', 'production')),
  round_number smallint not null check (round_number between 1 and 4),
  revision_number integer not null check (revision_number > 0),
  record_kind text not null check (record_kind in ('initial', 'correction')),
  record_status text not null default 'active'
    check (record_status in ('active', 'superseded', 'rolled_back')),
  supersedes_snapshot_id uuid
    references public.game_result_history_snapshots(id) on delete restrict,
  submitted_by text not null,
  approved_by text not null,
  correction_by text,
  screenshot_urls jsonb not null check (jsonb_typeof(screenshot_urls) = 'array'),
  discord_message_url text not null,
  recorded_at timestamptz not null default now(),
  status_changed_by text,
  status_changed_at timestamptz,
  unique (submission_id, score_sheet_mode, round_number, revision_number),
  check (
    (
      record_kind = 'initial'
      and supersedes_snapshot_id is null
      and correction_by is null
    )
    or
    (
      record_kind = 'correction'
      and supersedes_snapshot_id is not null
      and correction_by is not null
    )
  )
);

create table if not exists public.game_result_player_history (
  id uuid primary key default gen_random_uuid(),
  snapshot_id uuid not null
    references public.game_result_history_snapshots(id) on delete restrict,
  submission_id uuid not null
    references public.game_result_submissions(id) on delete restrict,
  sheet_write_audit_id uuid not null
    references public.game_result_sheet_write_audits(id) on delete restrict,
  score_sheet_mode text not null check (score_sheet_mode in ('test', 'production')),
  round_number smallint not null check (round_number between 1 and 4),
  revision_number integer not null check (revision_number > 0),
  record_kind text not null check (record_kind in ('initial', 'correction')),
  record_status text not null default 'active'
    check (record_status in ('active', 'superseded', 'rolled_back')),
  rank smallint not null check (rank between 1 and 25),
  team_code text not null check (length(trim(team_code)) > 0),
  official_team_name text not null check (length(trim(official_team_name)) > 0),
  team_total_kills integer not null check (team_total_kills >= 0),
  player_slot text not null check (length(trim(player_slot)) > 0),
  player_name text not null check (length(trim(player_name)) > 0),
  player_kills integer not null check (player_kills >= 0),
  confidence jsonb not null,
  confidence_score numeric(5, 4) not null
    check (confidence_score between 0 and 1),
  validation_status text not null,
  screenshot_url text not null,
  discord_message_url text not null,
  submitted_by text not null,
  approved_by text not null,
  correction_by text,
  recorded_at timestamptz not null default now(),
  status_changed_by text,
  status_changed_at timestamptz,
  unique (snapshot_id, team_code, player_slot),
  check (
    (record_kind = 'initial' and correction_by is null)
    or (record_kind = 'correction' and correction_by is not null)
  )
);

create unique index if not exists game_result_player_history_active_slot_idx
  on public.game_result_player_history (
    submission_id,
    score_sheet_mode,
    round_number,
    upper(trim(team_code)),
    upper(trim(player_slot))
  )
  where record_status = 'active';

create unique index if not exists game_result_player_history_snapshot_slot_idx
  on public.game_result_player_history (
    snapshot_id,
    upper(trim(team_code)),
    upper(trim(player_slot))
  );

create index if not exists game_result_player_history_player_lookup_idx
  on public.game_result_player_history (
    player_name,
    score_sheet_mode,
    round_number,
    recorded_at desc
  );

create index if not exists game_result_player_history_team_lookup_idx
  on public.game_result_player_history (
    team_code,
    score_sheet_mode,
    round_number,
    recorded_at desc
  );

create or replace function public.record_game_result_player_history(
  p_submission_id uuid,
  p_sheet_write_audit_id uuid,
  p_score_sheet_mode text,
  p_round_number smallint,
  p_record_kind text,
  p_submitted_by text,
  p_approved_by text,
  p_correction_by text,
  p_screenshot_urls jsonb,
  p_discord_message_url text,
  p_players jsonb
)
returns uuid
language plpgsql
security definer
set search_path = public
as $$
declare
  v_snapshot_id uuid;
  v_current_snapshot_id uuid;
  v_current_audit_id uuid;
  v_revision integer;
  v_audit record;
  v_submission record;
  v_inserted integer;
begin
  if p_score_sheet_mode not in ('test', 'production') then
    raise exception 'invalid score-sheet mode';
  end if;
  if p_round_number not between 1 and 4 then
    raise exception 'invalid round';
  end if;
  if p_record_kind not in ('initial', 'correction') then
    raise exception 'invalid record kind';
  end if;
  if jsonb_typeof(p_players) <> 'array' or jsonb_array_length(p_players) = 0 then
    raise exception 'player history cannot be empty';
  end if;
  if jsonb_typeof(p_screenshot_urls) <> 'array'
    or jsonb_array_length(p_screenshot_urls) = 0 then
    raise exception 'screenshot history cannot be empty';
  end if;

  perform pg_advisory_xact_lock(
    hashtextextended(
      p_submission_id::text || ':' || p_score_sheet_mode || ':' || p_round_number,
      0
    )
  );

  select id
  into v_snapshot_id
  from public.game_result_history_snapshots
  where sheet_write_audit_id = p_sheet_write_audit_id;
  if found then
    return v_snapshot_id;
  end if;

  select round_number, status
  into v_submission
  from public.game_result_submissions
  where id = p_submission_id
  for update;
  if not found then raise exception 'submission not found'; end if;
  if v_submission.round_number <> p_round_number then
    raise exception 'submission round does not match history round';
  end if;
  if v_submission.status not in ('approved_for_writing', 'confirmed', 'corrected') then
    raise exception 'submission is not approved for history recording';
  end if;

  select
    submission_id,
    score_sheet_mode,
    round_number,
    write_kind,
    status,
    sheet_write_applied,
    supersedes_audit_id,
    correction_authorized_by
  into v_audit
  from public.game_result_sheet_write_audits
  where id = p_sheet_write_audit_id;
  if not found then raise exception 'score-sheet audit not found'; end if;
  if
    v_audit.submission_id <> p_submission_id
    or v_audit.score_sheet_mode <> p_score_sheet_mode
    or v_audit.round_number <> p_round_number
    or v_audit.write_kind <> p_record_kind
    or v_audit.status <> 'verified'
    or not v_audit.sheet_write_applied
  then
    raise exception 'score-sheet audit is not eligible for player history';
  end if;
  if
    p_record_kind = 'correction'
    and (
      p_correction_by is null
      or p_correction_by <> v_audit.correction_authorized_by
    )
  then
    raise exception 'correction actor does not match the authorized score-sheet audit';
  end if;
  if p_record_kind = 'initial' and p_correction_by is not null then
    raise exception 'initial history cannot have a correction actor';
  end if;

  if exists (
    select 1
    from jsonb_to_recordset(p_players) as item(
      team_code text,
      player_slot text
    )
    group by upper(trim(item.team_code)), upper(trim(item.player_slot))
    having count(*) > 1
  ) then
    raise exception 'duplicate player slot in history payload';
  end if;

  select id, sheet_write_audit_id
  into v_current_snapshot_id, v_current_audit_id
  from public.game_result_history_snapshots
  where
    submission_id = p_submission_id
    and score_sheet_mode = p_score_sheet_mode
    and round_number = p_round_number
    and record_status = 'active'
  order by revision_number desc
  limit 1
  for update;

  if p_record_kind = 'initial' and v_current_snapshot_id is not null then
    raise exception 'confirmed round already has active player history';
  end if;
  if p_record_kind = 'correction' then
    if v_current_snapshot_id is null then
      raise exception 'correction has no original player history';
    end if;
    if v_audit.supersedes_audit_id <> v_current_audit_id then
      raise exception 'correction does not supersede the active player history';
    end if;
  end if;

  select coalesce(max(revision_number), 0) + 1
  into v_revision
  from public.game_result_history_snapshots
  where
    submission_id = p_submission_id
    and score_sheet_mode = p_score_sheet_mode
    and round_number = p_round_number;

  if v_current_snapshot_id is not null then
    update public.game_result_player_history
    set
      record_status = 'superseded',
      status_changed_by = p_correction_by,
      status_changed_at = now()
    where snapshot_id = v_current_snapshot_id and record_status = 'active';

    update public.game_result_history_snapshots
    set
      record_status = 'superseded',
      status_changed_by = p_correction_by,
      status_changed_at = now()
    where id = v_current_snapshot_id and record_status = 'active';
  end if;

  insert into public.game_result_history_snapshots (
    submission_id,
    sheet_write_audit_id,
    score_sheet_mode,
    round_number,
    revision_number,
    record_kind,
    record_status,
    supersedes_snapshot_id,
    submitted_by,
    approved_by,
    correction_by,
    screenshot_urls,
    discord_message_url
  ) values (
    p_submission_id,
    p_sheet_write_audit_id,
    p_score_sheet_mode,
    p_round_number,
    v_revision,
    p_record_kind,
    'active',
    v_current_snapshot_id,
    p_submitted_by,
    p_approved_by,
    p_correction_by,
    p_screenshot_urls,
    p_discord_message_url
  )
  returning id into v_snapshot_id;

  insert into public.game_result_player_history (
    snapshot_id,
    submission_id,
    sheet_write_audit_id,
    score_sheet_mode,
    round_number,
    revision_number,
    record_kind,
    record_status,
    rank,
    team_code,
    official_team_name,
    team_total_kills,
    player_slot,
    player_name,
    player_kills,
    confidence,
    confidence_score,
    validation_status,
    screenshot_url,
    discord_message_url,
    submitted_by,
    approved_by,
    correction_by
  )
  select
    v_snapshot_id,
    p_submission_id,
    p_sheet_write_audit_id,
    p_score_sheet_mode,
    p_round_number,
    v_revision,
    p_record_kind,
    'active',
    item.rank,
    item.team_code,
    item.official_team_name,
    item.team_total_kills,
    item.player_slot,
    item.player_name,
    item.player_kills,
    item.confidence,
    item.confidence_score,
    item.validation_status,
    item.screenshot_url,
    p_discord_message_url,
    p_submitted_by,
    p_approved_by,
    p_correction_by
  from jsonb_to_recordset(p_players) as item(
    rank smallint,
    team_code text,
    official_team_name text,
    team_total_kills integer,
    player_slot text,
    player_name text,
    player_kills integer,
    confidence jsonb,
    confidence_score numeric,
    validation_status text,
    screenshot_url text
  );

  get diagnostics v_inserted = row_count;
  if v_inserted <> jsonb_array_length(p_players) then
    raise exception 'not every player history row was inserted';
  end if;

  return v_snapshot_id;
end;
$$;

create or replace function public.rollback_game_result_player_history(
  p_sheet_write_audit_id uuid,
  p_actor text
)
returns uuid
language plpgsql
security definer
set search_path = public
as $$
declare
  v_snapshot record;
begin
  select *
  into v_snapshot
  from public.game_result_history_snapshots
  where sheet_write_audit_id = p_sheet_write_audit_id;
  if not found then return null; end if;

  perform pg_advisory_xact_lock(
    hashtextextended(
      v_snapshot.submission_id::text
      || ':' || v_snapshot.score_sheet_mode
      || ':' || v_snapshot.round_number,
      0
    )
  );

  select *
  into v_snapshot
  from public.game_result_history_snapshots
  where sheet_write_audit_id = p_sheet_write_audit_id
  for update;
  if v_snapshot.record_status = 'rolled_back' then return v_snapshot.id; end if;
  if v_snapshot.record_status <> 'active' then
    raise exception 'only active player history can be rolled back';
  end if;

  update public.game_result_player_history
  set
    record_status = 'rolled_back',
    status_changed_by = p_actor,
    status_changed_at = now()
  where snapshot_id = v_snapshot.id and record_status = 'active';

  update public.game_result_history_snapshots
  set
    record_status = 'rolled_back',
    status_changed_by = p_actor,
    status_changed_at = now()
  where id = v_snapshot.id and record_status = 'active';

  if v_snapshot.supersedes_snapshot_id is not null then
    update public.game_result_history_snapshots
    set
      record_status = 'active',
      status_changed_by = p_actor,
      status_changed_at = now()
    where
      id = v_snapshot.supersedes_snapshot_id
      and record_status = 'superseded';
    if not found then
      raise exception 'the original player history could not be restored';
    end if;

    update public.game_result_player_history
    set
      record_status = 'active',
      status_changed_by = p_actor,
      status_changed_at = now()
    where
      snapshot_id = v_snapshot.supersedes_snapshot_id
      and record_status = 'superseded';
  end if;

  return v_snapshot.id;
end;
$$;

create or replace view public.game_result_player_history_for_calculations as
select history.*
from public.game_result_player_history as history
join public.game_result_submissions as submission
  on submission.id = history.submission_id
where
  history.score_sheet_mode = 'production'
  and history.record_status = 'active'
  and submission.status = 'confirmed'
  and submission.status not in ('rejected', 'deleted');

alter table public.game_result_history_snapshots enable row level security;
alter table public.game_result_player_history enable row level security;

revoke all on table public.game_result_history_snapshots from anon, authenticated;
revoke all on table public.game_result_player_history from anon, authenticated;
revoke all on table public.game_result_player_history_for_calculations from anon, authenticated;
grant select, insert, update on table public.game_result_history_snapshots to service_role;
grant select, insert, update on table public.game_result_player_history to service_role;
grant select on table public.game_result_player_history_for_calculations to service_role;

revoke all on function public.record_game_result_player_history(
  uuid, uuid, text, smallint, text, text, text, text, jsonb, text, jsonb
) from public, anon, authenticated;
grant execute on function public.record_game_result_player_history(
  uuid, uuid, text, smallint, text, text, text, text, jsonb, text, jsonb
) to service_role;

revoke all on function public.rollback_game_result_player_history(uuid, text)
  from public, anon, authenticated;
grant execute on function public.rollback_game_result_player_history(uuid, text)
  to service_role;

comment on table public.game_result_player_history is
  'Append-only player results for every team in every confirmed round; corrections create new revisions.';

comment on view public.game_result_player_history_for_calculations is
  'Current production player results only; rejected and deleted submissions are excluded.';
