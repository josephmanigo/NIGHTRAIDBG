-- Adds the 'Other' gender option to existing installations.
-- Run in the Supabase SQL editor; without this, applications that
-- select Other fail the clan_applications sex check constraint.

alter table public.clan_applications
  drop constraint if exists clan_applications_sex_check;

alter table public.clan_applications
  add constraint clan_applications_sex_check check (sex in ('Male', 'Female', 'Other'));
