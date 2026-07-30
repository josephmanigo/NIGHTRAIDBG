-- NIGHTRAID Phase 17: remove the pgcrypto dependency from screenshot tombstones.
-- Apply after database/phase16.sql. This is safe to rerun.

create or replace function public.tombstone_deleted_game_result_message(
  p_guild_id text,
  p_channel_id text,
  p_message_id text
)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_submission public.game_result_submissions%rowtype;
  v_screenshots_removed integer := 0;
  v_current_status text;
begin
  select *
  into v_submission
  from public.game_result_submissions
  where guild_id = p_guild_id
    and channel_id = p_channel_id
    and message_id = p_message_id
  for update;

  if not found then
    return jsonb_build_object(
      'found', false,
      'screenshots_removed', 0,
      'submission_deleted', false
    );
  end if;

  update public.game_result_screenshots
  set
    screenshot_url = '',
    filename = '[deleted Discord screenshot]',
    sha256 =
      lower(replace(id::text, '-', ''))
      || lower(replace(id::text, '-', '')),
    perceptual_hash = left(lower(replace(id::text, '-', '')), 16),
    status = 'deleted',
    duplicate_of = null
  where submission_id = v_submission.id
    and status <> 'deleted';

  get diagnostics v_screenshots_removed = row_count;

  update public.game_result_submissions
  set
    status = case
      when v_submission.status::text in ('confirmed', 'corrected')
        then v_submission.status
      else 'deleted'::public.game_result_submission_status
    end,
    review_payload = case
      when v_submission.status::text in ('confirmed', 'corrected')
        then review_payload
      else null
    end,
    review_version = review_version + 1,
    review_updated_at = now()
  where id = v_submission.id
  returning status::text into v_current_status;

  return jsonb_build_object(
    'found', true,
    'submission_id', v_submission.id,
    'previous_status', v_submission.status::text,
    'current_status', v_current_status,
    'screenshots_removed', v_screenshots_removed,
    'submission_deleted', v_current_status = 'deleted'
  );
end;
$$;

revoke all on function public.tombstone_deleted_game_result_message(text, text, text)
  from public, anon, authenticated;
grant execute on function public.tombstone_deleted_game_result_message(text, text, text)
  to service_role;

comment on function public.tombstone_deleted_game_result_message(text, text, text) is
  'Clears deleted Discord screenshot URLs and hashes without pgcrypto, releases duplicate protection, and preserves confirmed score history.';
