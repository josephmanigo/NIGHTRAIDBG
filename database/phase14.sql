-- NIGHTRAID Loop 10: persistent overall-champion MVP previews and safe,
-- auditable writes to the existing FINALS • MVP input block.
-- Apply after database/phase13.sql.

create table if not exists public.game_result_mvp_reviews (
  id uuid primary key default gen_random_uuid(),
  guild_id text not null,
  channel_id text not null,
  review_message_id text,
  status text not null default 'pending'
    check (status in (
      'pending',
      'processing',
      'confirmed',
      'rejected',
      'cancelled',
      'failed'
    )),
  review_version integer not null default 0 check (review_version >= 0),
  score_sheet_mode text not null check (score_sheet_mode in ('test', 'production')),
  spreadsheet_id text not null,
  production_worksheet_name text not null check (production_worksheet_name = 'New'),
  production_sheet_id bigint not null check (production_sheet_id = 417351865),
  mvp_worksheet_name text not null check (mvp_worksheet_name = 'FINALS • MVP'),
  mvp_sheet_id bigint not null check (mvp_sheet_id = 741715752),
  source_fingerprint text not null
    check (source_fingerprint ~ '^[0-9a-f]{64}$'),
  source_snapshots jsonb not null
    check (
      jsonb_typeof(source_snapshots) = 'array'
      and jsonb_array_length(source_snapshots) = 4
    ),
  champion jsonb not null check (jsonb_typeof(champion) = 'object'),
  roster jsonb not null check (jsonb_typeof(roster) = 'array'),
  issues jsonb not null check (jsonb_typeof(issues) = 'array'),
  before_snapshot jsonb not null check (jsonb_typeof(before_snapshot) = 'object'),
  after_snapshot jsonb,
  write_payload jsonb not null check (jsonb_typeof(write_payload) = 'array'),
  verification jsonb,
  sheet_write_applied boolean not null default false,
  error text,
  created_by text not null,
  confirmed_by text,
  closed_by text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  confirmed_at timestamptz,
  check (
    (status = 'confirmed' and sheet_write_applied and confirmed_at is not null)
    or status <> 'confirmed'
  )
);

create unique index if not exists game_result_mvp_active_source_idx
  on public.game_result_mvp_reviews (
    spreadsheet_id,
    mvp_worksheet_name,
    source_fingerprint
  )
  where status in ('processing', 'confirmed');

create index if not exists game_result_mvp_review_message_idx
  on public.game_result_mvp_reviews (guild_id, channel_id, review_message_id);

drop trigger if exists set_game_result_mvp_reviews_updated_at
  on public.game_result_mvp_reviews;
create trigger set_game_result_mvp_reviews_updated_at
before update on public.game_result_mvp_reviews
for each row execute function public.set_game_result_submission_updated_at();

alter table public.game_result_mvp_reviews enable row level security;

revoke all on table public.game_result_mvp_reviews from anon, authenticated;
grant select, insert, update on table public.game_result_mvp_reviews to service_role;

comment on table public.game_result_mvp_reviews is
  'Persistent overall-champion MVP previews and before/after audit data; only player-name and round-kill inputs may be written.';
