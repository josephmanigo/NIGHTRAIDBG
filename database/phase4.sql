-- Run this once in Supabase SQL Editor after phase1.sql and phase3.sql.

alter table public.clan_applications
  add column if not exists ai_evaluation_status text not null default 'NOT_STARTED'
    check (ai_evaluation_status in ('NOT_STARTED', 'PROCESSING', 'COMPLETED', 'FAILED')),
  add column if not exists ai_evaluation_error text,
  add column if not exists ai_evaluated_at timestamptz;

create table if not exists public.ai_evaluations (
  id uuid primary key default gen_random_uuid(),
  application_id uuid not null references public.clan_applications(id) on delete cascade,
  score integer not null check (score between 0 and 100),
  recommendation text not null check (recommendation in ('RECOMMENDED', 'MANUAL_REVIEW', 'NOT_RECOMMENDED')),
  confidence numeric(4, 3) not null check (confidence between 0 and 1),
  motivation_score integer not null check (motivation_score between 0 and 25),
  teamwork_score integer not null check (teamwork_score between 0 and 20),
  activity_score integer not null check (activity_score between 0 and 15),
  clan_commitment_score integer not null check (clan_commitment_score between 0 and 20),
  consistency_score integer not null check (consistency_score between 0 and 10),
  communication_score integer not null check (communication_score between 0 and 10),
  strengths text[] not null default '{}',
  concerns text[] not null default '{}',
  summary text not null,
  moderation_flagged boolean not null default false,
  moderation_categories jsonb not null default '{}',
  model text not null,
  prompt_version text not null,
  created_at timestamptz not null default now()
);

create index if not exists ai_evaluations_application_created_idx
  on public.ai_evaluations (application_id, created_at desc);

alter table public.ai_evaluations enable row level security;

comment on table public.ai_evaluations is
  'Advisory AI application reviews. NightRaid administrators retain final decision authority.';
