-- Credit limit per card (from Plaid's balances.limit), for utilization: balance / limit.
alter table public.accounts add column if not exists credit_limit double precision;
