-- Tamaki Savdo / SmokeCRM — cloud backup schema.
--
-- IndexedDB in the browser stays the SOURCE OF TRUTH. These tables are a replica whose only
-- job is to survive a dead laptop or a cleared browser. That is why there is no stock guard
-- and no business logic here: the till already enforces those atomically, offline, and this
-- schema must never become a second place where the rules live and drift out of sync.
--
-- The ledger is append-only with UUID keys, so replication is a plain idempotent upsert —
-- pushing the same row twice is a no-op, which is exactly what makes retry-after-offline safe.

create extension if not exists pgcrypto;

-- ---------------------------------------------------------------------------
-- Tables
-- ---------------------------------------------------------------------------
-- The app's own ids are strings (crypto.randomUUID), so `id` is text, not uuid — a restored
-- backup may carry ids this database never issued and must still round-trip byte-for-byte.
--
-- Primary key is (user_id, id): one shop's ids can never collide with another's, and it gives
-- the upsert a natural conflict target.
--
-- Timestamps are bigint epoch-milliseconds to match the app's `Date.now()` values exactly.
-- Storing them as timestamptz would force a lossy conversion on every sync.

create table if not exists public.products (
  user_id           uuid    not null references auth.users(id) on delete cascade,
  id                text    not null,
  name              text    not null,
  brand             text    not null default '',
  cost_price        numeric not null default 0,
  selling_price     numeric not null default 0,
  current_stock     integer not null default 0,
  reorder_threshold integer not null default 0,
  barcode           text,
  supplier_id       text,
  active            boolean not null default true,
  created_at        bigint,
  updated_at        bigint,
  synced_at         timestamptz not null default now(),
  primary key (user_id, id)
);

create table if not exists public.transactions (
  user_id       uuid    not null references auth.users(id) on delete cascade,
  id            text    not null,
  ts            bigint  not null,
  type          text    not null check (type in ('SALE', 'RESTOCK')),
  product_id    text    not null,
  product_name  text    not null,
  brand         text    not null default '',
  quantity      integer not null,
  unit_price    numeric not null default 0,
  cost_price    numeric not null default 0,
  total_amount  numeric not null default 0,
  profit        numeric not null default 0,
  note          text,
  user_name     text    not null default '',
  user_role     text    not null default 'admin',
  ref_id        text    not null default '',
  voided        boolean not null default false,
  reversal_of   text,
  synced_at     timestamptz not null default now(),
  primary key (user_id, id)
);

-- Reports are always "this date range", so the ledger is read by time above all else.
create index if not exists transactions_user_ts_idx on public.transactions (user_id, ts desc);

create table if not exists public.suppliers (
  user_id   uuid not null references auth.users(id) on delete cascade,
  id        text not null,
  name      text not null,
  contact   text,
  note      text,
  synced_at timestamptz not null default now(),
  primary key (user_id, id)
);

-- ---------------------------------------------------------------------------
-- Row-level security
-- ---------------------------------------------------------------------------
-- The publishable key ships inside the JS bundle and is readable by anyone who opens the
-- site. RLS is therefore the ONLY thing standing between a stranger and this shop's sales
-- history. Every table is locked to the owning user; `anon` gets nothing at all.

alter table public.products     enable row level security;
alter table public.transactions enable row level security;
alter table public.suppliers    enable row level security;

-- `TO authenticated` alone would be authentication without authorization — it proves someone
-- is signed in, not that the row is theirs. The `user_id = auth.uid()` predicate is what does
-- the real work. UPDATE carries WITH CHECK as well as USING, otherwise a signed-in user could
-- hand their own row to somebody else by rewriting user_id.

drop policy if exists products_select on public.products;
drop policy if exists products_insert on public.products;
drop policy if exists products_update on public.products;
drop policy if exists products_delete on public.products;

create policy products_select on public.products
  for select to authenticated using ((select auth.uid()) = user_id);
create policy products_insert on public.products
  for insert to authenticated with check ((select auth.uid()) = user_id);
create policy products_update on public.products
  for update to authenticated
  using ((select auth.uid()) = user_id) with check ((select auth.uid()) = user_id);
create policy products_delete on public.products
  for delete to authenticated using ((select auth.uid()) = user_id);

drop policy if exists transactions_select on public.transactions;
drop policy if exists transactions_insert on public.transactions;
drop policy if exists transactions_update on public.transactions;
drop policy if exists transactions_delete on public.transactions;

create policy transactions_select on public.transactions
  for select to authenticated using ((select auth.uid()) = user_id);
create policy transactions_insert on public.transactions
  for insert to authenticated with check ((select auth.uid()) = user_id);
create policy transactions_update on public.transactions
  for update to authenticated
  using ((select auth.uid()) = user_id) with check ((select auth.uid()) = user_id);
create policy transactions_delete on public.transactions
  for delete to authenticated using ((select auth.uid()) = user_id);

drop policy if exists suppliers_select on public.suppliers;
drop policy if exists suppliers_insert on public.suppliers;
drop policy if exists suppliers_update on public.suppliers;
drop policy if exists suppliers_delete on public.suppliers;

create policy suppliers_select on public.suppliers
  for select to authenticated using ((select auth.uid()) = user_id);
create policy suppliers_insert on public.suppliers
  for insert to authenticated with check ((select auth.uid()) = user_id);
create policy suppliers_update on public.suppliers
  for update to authenticated
  using ((select auth.uid()) = user_id) with check ((select auth.uid()) = user_id);
create policy suppliers_delete on public.suppliers
  for delete to authenticated using ((select auth.uid()) = user_id);

-- ---------------------------------------------------------------------------
-- Grants
-- ---------------------------------------------------------------------------
-- Table access and RLS are separate gates: RLS filters which ROWS you see; grants decide
-- whether the table is reachable at all. Both must be right.
--
-- Postgres grants everything in `public` to the PUBLIC role by default, which `anon` and
-- `authenticated` inherit — so a bare CREATE TABLE leaves anon holding SELECT/INSERT/UPDATE/
-- DELETE/TRUNCATE. RLS masks most of that (anon has no policy, so it sees no rows), but
-- TRUNCATE is NOT subject to RLS. Granting is therefore not enough: revoke first, then grant
-- back only what is needed.

revoke all on public.products     from anon;
revoke all on public.transactions from anon;
revoke all on public.suppliers    from anon;

revoke all on public.products     from authenticated;
revoke all on public.transactions from authenticated;
revoke all on public.suppliers    from authenticated;

-- Exactly the four verbs the sync layer uses. No TRUNCATE, no TRIGGER, no REFERENCES.
grant select, insert, update, delete on public.products     to authenticated;
grant select, insert, update, delete on public.transactions to authenticated;
grant select, insert, update, delete on public.suppliers    to authenticated;
