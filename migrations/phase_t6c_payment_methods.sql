-- ============================================================
-- Phase T6c: super_admin-managed payment methods list
-- ============================================================
--
-- Until now `teachers.payment_method` was a free-text column
-- constrained to a hardcoded set of six values
-- (direct_deposit, check, paypal, venmo, zelle, other) by the
-- T6a check constraint. This phase moves the list into a
-- proper table so super_admin can add/rename/disable methods
-- through the UI without a SQL migration.
--
-- Why no new permission name:
--   Edits are restricted to super_admin via is_super_admin()
--   directly. The list is rarely changed, so we don't need a
--   per-user grant story. If a franchise ever wants a delegated
--   bookkeeper to manage it, that's a future T6d follow-up
--   (add `manage_payment_methods` perm, add to the bundles).
--
-- Why drop the check constraint:
--   The table is now the source of truth. Keeping the check
--   constraint would require a synchronized SQL migration every
--   time super_admin adds a method through the UI — defeating
--   the purpose. The new SELECT path (browser populates the
--   dropdown from state.paymentMethods) ensures only valid
--   slugs are written, and `kind` discriminates between
--   bank-field UX vs. handle-field UX without needing a
--   constraint to enforce values.
--
-- Idempotent: every CREATE uses IF NOT EXISTS, the seed is
-- on (slug) conflict do nothing.

begin;

-- 1. payment_methods table ----------------------------------

create table if not exists public.payment_methods (
  id          uuid primary key default gen_random_uuid(),
  slug        text not null unique,
  label       text not null,
  -- kind drives the personnel-modal sub-field visibility:
  --   'bank'   → bank/routing/account fields
  --   'handle' → payment_handle field (PayPal/Venmo/Zelle)
  --   'none'   → neither (e.g. check uses mailing address;
  --              "other" defers to the notes field)
  kind        text not null check (kind in ('bank','handle','none')),
  sort_order  integer not null default 0,
  is_active   boolean not null default true,
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now()
);

create index if not exists payment_methods_active_idx
  on public.payment_methods (sort_order)
  where is_active;

-- updated_at trigger
create or replace function public.tg_payment_methods_touch()
returns trigger
language plpgsql
as $$
begin
  new.updated_at := now();
  return new;
end;
$$;

drop trigger if exists payment_methods_touch on public.payment_methods;
create trigger payment_methods_touch
  before update on public.payment_methods
  for each row execute function public.tg_payment_methods_touch();

alter table public.payment_methods enable row level security;

-- SELECT: any signed-in user (the dropdown needs to render in
-- every personnel modal that shows the payroll section).
drop policy if exists "pm_select" on public.payment_methods;
create policy "pm_select"
  on public.payment_methods
  for select
  to authenticated
  using (true);

-- Writes: super_admin only.
drop policy if exists "pm_insert" on public.payment_methods;
create policy "pm_insert"
  on public.payment_methods
  for insert
  to authenticated
  with check (public.is_super_admin());

drop policy if exists "pm_update" on public.payment_methods;
create policy "pm_update"
  on public.payment_methods
  for update
  to authenticated
  using      (public.is_super_admin())
  with check (public.is_super_admin());

drop policy if exists "pm_delete" on public.payment_methods;
create policy "pm_delete"
  on public.payment_methods
  for delete
  to authenticated
  using (public.is_super_admin());

-- 2. Drop the legacy check constraint -----------------------
-- The table is the new source of truth. Without this drop,
-- adding a new method via the UI would error on the next
-- teacher save attempting to use it.

alter table public.teachers
  drop constraint if exists teachers_payment_method_check;

-- 3. Seed: existing six methods -----------------------------

insert into public.payment_methods (slug, label, kind, sort_order)
values
  ('direct_deposit','Direct deposit','bank',  10),
  ('check',         'Check',         'none',  20),
  ('paypal',        'PayPal',        'handle',30),
  ('venmo',         'Venmo',         'handle',40),
  ('zelle',         'Zelle',         'handle',50),
  ('other',         'Other',         'none',  60)
on conflict (slug) do nothing;

-- 4. Realtime ------------------------------------------------

do $$
begin
  if not exists (
    select 1 from pg_publication_tables
     where pubname='supabase_realtime'
       and schemaname='public'
       and tablename='payment_methods'
  ) then
    alter publication supabase_realtime add table public.payment_methods;
  end if;
end $$;

commit;
