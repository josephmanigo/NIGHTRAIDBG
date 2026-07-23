-- Membership exit: administrators can remove members and members can leave.
-- Adds the REMOVED and LEFT statuses to clan applications.
-- Run this in the Supabase SQL editor after phase7.sql.

alter table public.clan_applications
  drop constraint if exists clan_applications_status_check;

alter table public.clan_applications
  add constraint clan_applications_status_check check (
    status in (
      'SUBMITTED',
      'PROCESSING',
      'PENDING_REVIEW',
      'APPROVED',
      'REJECTED',
      'DISCORD_JOIN_FAILED',
      'COMPLETED',
      'REMOVED',
      'LEFT'
    )
  );

-- REMOVED and LEFT are intentionally excluded from the one_open_application_per_discord
-- partial unique index, so former members can apply again unless a ban is active.
