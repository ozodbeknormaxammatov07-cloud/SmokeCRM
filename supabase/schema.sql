-- Tamaki Savdo / SmokeCRM — multi-device sync schema.
--
-- Every device commits sales to its own IndexedDB first, so the till keeps working with the
-- wifi down. These tables are the meeting point: each device pushes what it wrote and pulls
-- what the others wrote. There is no stock guard and no business logic here — the till already
-- enforces that, and a second copy of the rules would drift out of step with the first.
--
-- All staff sign into the SAME shop account, so `user_id` identifies the shop, not the person.
-- Who rang up a sale is recorded on the ledger row itself (`user_name`).
--
-- Two devices are safe to run at once because of the shape of the data, not because of locks:
--
--   * The ledger is append-only with UUID keys — a grow-only set. Two devices appending sales
--     cannot overwrite each other, in any order, online or off. Merging is an idempotent
--     upsert, which is also what makes retry-after-offline safe.
--   * Stock is DERIVED from that ledger by each device, never stored here. A stored counter is
--     a lost-update race: both devices read 10, both sell 3, one write wins, and the shop has
--     sold 6 packets but decremented 3. A sum has no such race.
--   * Deletes are TOMBSTONES (`deleted_at`), never row removals. "It's missing, so delete it"
--     cannot tell a deletion apart from a row the other device just created — and guessing
--     wrong destroys the other device's work.

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

-- NOTE: there is deliberately no `current_stock` column. Stock is DERIVED from the ledger by
-- every device, so a stored counter here would be a second source of truth that immediately
-- goes stale — and anyone reading this table directly would be misled by it. To see what the
-- shelf actually holds, query the `stock_levels` view at the bottom of this file.
create table if not exists public.products (
  user_id           uuid    not null references auth.users(id) on delete cascade,
  id                text    not null,
  name              text    not null,
  brand             text    not null default '',
  cost_price        numeric not null default 0,
  selling_price     numeric not null default 0,
  reorder_threshold integer not null default 0,
  barcode           text,
  supplier_id       text,
  active            boolean not null default true,
  created_at        bigint,
  updated_at        bigint,
  deleted_at        bigint,   -- tombstone; the row stays so the deletion can replicate
  synced_at         timestamptz not null default now(),
  primary key (user_id, id)
);

-- Pulls are "everything changed since my watermark", so that is the access path.
create index if not exists products_user_updated_idx on public.products (user_id, updated_at);

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
  user_id    uuid not null references auth.users(id) on delete cascade,
  id         text not null,
  name       text not null,
  contact    text,
  note       text,
  updated_at bigint,
  deleted_at bigint,
  synced_at  timestamptz not null default now(),
  primary key (user_id, id)
);

create index if not exists suppliers_user_updated_idx on public.suppliers (user_id, updated_at);

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

-- ---------------------------------------------------------------------------
-- Realtime
-- ---------------------------------------------------------------------------
-- Devices hear each other's writes instead of polling for them. Realtime honours RLS, so a
-- device is only ever notified about its own shop's rows.

alter publication supabase_realtime add table public.products;
alter publication supabase_realtime add table public.transactions;
alter publication supabase_realtime add table public.suppliers;

-- ---------------------------------------------------------------------------
-- stock_levels — what the shelf actually holds
-- ---------------------------------------------------------------------------
-- The app derives stock from the ledger; this gives anyone reading the database the same
-- number, instead of leaving them to guess from a table that deliberately doesn't store it.
--
-- security_invoker = true is essential: a view runs as its OWNER by default, which would
-- bypass RLS and let any signed-in user read every shop's stock.

create or replace view public.stock_levels with (security_invoker = true) as
  select
    p.user_id,
    p.id   as product_id,
    p.name,
    p.brand,
    coalesce(sum(case when t.type = 'SALE' then -t.quantity else t.quantity end), 0) as current_stock
  from public.products p
  left join public.transactions t
    on t.user_id = p.user_id and t.product_id = p.id
  where p.deleted_at is null
  group by p.user_id, p.id, p.name, p.brand;

revoke all on public.stock_levels from anon;
grant select on public.stock_levels to authenticated;
