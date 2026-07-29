-- NIGHTRAID Loop 8: explicit test/production score-sheet modes and guarded
-- correction writes. Apply after database/phase11.sql.

alter table public.game_result_sheet_write_audits
  drop constraint if exists game_result_sheet_write_audits_worksheet_name_check;

alter table public.game_result_sheet_write_audits
  add constraint game_result_sheet_write_audits_worksheet_name_check
  check (worksheet_name in ('Copy of New', 'New'));

alter table public.game_result_sheet_write_audits
  add column if not exists score_sheet_mode text;

update public.game_result_sheet_write_audits
set score_sheet_mode = case
  when worksheet_name = 'New' then 'production'
  else 'test'
end
where score_sheet_mode is null;

alter table public.game_result_sheet_write_audits
  alter column score_sheet_mode set not null;

alter table public.game_result_sheet_write_audits
  drop constraint if exists game_result_sheet_write_audits_score_sheet_mode_check;

alter table public.game_result_sheet_write_audits
  add constraint game_result_sheet_write_audits_score_sheet_mode_check
  check (
    (score_sheet_mode = 'test' and worksheet_name = 'Copy of New')
    or (score_sheet_mode = 'production' and worksheet_name = 'New')
  );

alter table public.game_result_sheet_write_audits
  add column if not exists write_kind text not null default 'initial',
  add column if not exists supersedes_audit_id uuid
    references public.game_result_sheet_write_audits(id) on delete restrict,
  add column if not exists correction_authorized_by text;

alter table public.game_result_sheet_write_audits
  drop constraint if exists game_result_sheet_write_audits_write_kind_check;

alter table public.game_result_sheet_write_audits
  add constraint game_result_sheet_write_audits_write_kind_check
  check (
    (
      write_kind = 'initial'
      and supersedes_audit_id is null
      and correction_authorized_by is null
    )
    or
    (
      write_kind = 'correction'
      and supersedes_audit_id is not null
      and correction_authorized_by is not null
    )
  );

drop index if exists public.game_result_sheet_write_active_submission_idx;

create unique index if not exists game_result_sheet_write_initial_round_idx
  on public.game_result_sheet_write_audits (
    submission_id,
    score_sheet_mode,
    round_number
  )
  where
    write_kind = 'initial'
    and (
      status in ('preparing', 'written', 'verified')
      or (status in ('failed', 'rollback_failed') and sheet_write_applied)
    );

create unique index if not exists game_result_sheet_write_active_operation_idx
  on public.game_result_sheet_write_audits (
    submission_id,
    score_sheet_mode,
    round_number
  )
  where
    status in ('preparing', 'written')
    or (status in ('failed', 'rollback_failed') and sheet_write_applied);

create unique index if not exists game_result_sheet_write_correction_chain_idx
  on public.game_result_sheet_write_audits (supersedes_audit_id)
  where
    write_kind = 'correction'
    and (
      status in ('preparing', 'written', 'verified')
      or (status in ('failed', 'rollback_failed') and sheet_write_applied)
    );

create index if not exists game_result_sheet_write_round_lookup_idx
  on public.game_result_sheet_write_audits (
    submission_id,
    score_sheet_mode,
    round_number,
    created_at desc
  );

comment on table public.game_result_sheet_write_audits is
  'Loop 8 test/production PLACE and KILLS backups, verification, corrections, and rollback.';
