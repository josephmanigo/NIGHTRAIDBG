-- NIGHTRAID Phase 25: durable NRT token balances that survive bot redeploys.
-- The bot previously kept balances in data/midnight-nrt.json, which Render wipes
-- on every deploy, resetting /nrtleaderboard to blank. Apply after phase24.sql.

create table if not exists public.nrt_balances (
  user_id text primary key,
  balance bigint not null default 0 check (balance >= 0),
  updated_at timestamptz not null default now()
);

create index if not exists nrt_balances_balance_idx
  on public.nrt_balances (balance desc);

create or replace function public.nrt_adjust_balance(
  p_user_id text,
  p_amount bigint
)
returns bigint
language plpgsql
security definer
set search_path = public
as $$
declare
  v_balance bigint;
begin
  if p_user_id is null or length(btrim(p_user_id)) < 1 or p_amount = 0 then
    raise exception 'Invalid NRT adjustment.';
  end if;
  insert into public.nrt_balances (user_id, balance)
  values (p_user_id, greatest(0, p_amount))
  on conflict (user_id) do update
    set balance = greatest(0, public.nrt_balances.balance + p_amount),
        updated_at = now()
  returning balance into v_balance;
  return v_balance;
end;
$$;

alter table public.nrt_balances enable row level security;
revoke all on table public.nrt_balances from anon, authenticated;
grant all on table public.nrt_balances to service_role;

revoke all on function public.nrt_adjust_balance(text, bigint) from public, anon, authenticated;
grant execute on function public.nrt_adjust_balance(text, bigint) to service_role;

comment on table public.nrt_balances is 'Durable NIGHTRAID TOKEN balances that survive bot redeploys.';
comment on function public.nrt_adjust_balance(text, bigint) is 'Atomically add (or subtract, clamped at zero) NRT for a user and return the new balance.';
