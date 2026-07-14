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
-- Procurement — firms, orders, deliveries, payments
-- ---------------------------------------------------------------------------
-- Debt is DERIVED by every device, exactly as stock is:
--
--   balance(firm) = sum(deliveries.total_amount) - sum(payments.amount)
--
-- so there is deliberately no `balance` column anywhere. A stored balance would be the same
-- lost-update race a stored stock counter is: two devices, one recording a payment and the
-- other a delivery while apart, and one write wins.
--
-- Deliveries and payments are append-only and corrected ONLY by an opposite-signed twin
-- (`reversal_of`), which is what lets two offline devices merge them with a plain idempotent
-- upsert. VOIDED ROWS ARE NOT DELETED, and must be SUMMED rather than skipped — the original
-- and its twin cancel to zero on their own.

-- `contact` is the phone number. The rest is what you need to actually transfer money to them.
alter table public.suppliers add column if not exists inn                text;
alter table public.suppliers add column if not exists bank_account       text;
alter table public.suppliers add column if not exists bank_name          text;
alter table public.suppliers add column if not exists bank_mfo           text;
alter table public.suppliers add column if not exists address            text;
alter table public.suppliers add column if not exists director           text;
alter table public.suppliers add column if not exists payment_terms_days integer;

-- An order is an INTENTION: it moves no stock and no money until a delivery arrives against it.
-- Mutable and last-write-wins, like products. `number` is a human label, never a key.
create table if not exists public.purchase_orders (
  user_id      uuid    not null references auth.users(id) on delete cascade,
  id           text    not null,
  supplier_id  text    not null,
  number       text    not null default '',
  ordered_at   bigint  not null,
  expected_at  bigint,
  lines        jsonb   not null default '[]'::jsonb,
  cancelled_at bigint,   -- the ONE stored status: a human decision, not arithmetic
  note         text,
  user_name    text    not null default '',
  user_role    text    not null default 'admin',
  created_at   bigint,
  updated_at   bigint,
  deleted_at   bigint,   -- tombstone
  synced_at    timestamptz not null default now(),
  primary key (user_id, id)
);

create index if not exists purchase_orders_user_updated_idx
  on public.purchase_orders (user_id, updated_at);

-- The event that moves stock AND money. The stock half lives in `transactions` as RESTOCK rows
-- tagged `ref_id = deliveries.id`; this table is the debt half, plus the document reference.
--
-- TWO DATES, and the difference is load-bearing:
--   created_at   — write time. Immutable. THE SYNC WATERMARK.
--   delivered_at — when the goods really arrived. User-editable, because deliveries get typed
--                  in days late.
-- Sync pages on created_at. Paging on delivered_at would drop a backdated delivery behind the
-- other device's watermark, so it would never replicate — leaving two tills that permanently
-- disagree about what the shop owes.
create table if not exists public.deliveries (
  user_id      uuid    not null references auth.users(id) on delete cascade,
  id           text    not null,
  supplier_id  text    not null,
  order_id     text,     -- optional: goods sometimes arrive without an order
  created_at   bigint  not null,
  delivered_at bigint  not null,
  doc_number   text,     -- faktura number. The paper stays in the folder; we record the number.
  doc_date     bigint,
  lines        jsonb   not null default '[]'::jsonb,
  total_amount numeric not null default 0,   -- snapshotted at write time
  note         text,
  user_name    text    not null default '',
  user_role    text    not null default 'admin',
  voided       boolean not null default false,
  reversal_of  text,
  synced_at    timestamptz not null default now(),
  primary key (user_id, id)
);

create index if not exists deliveries_user_created_idx  on public.deliveries (user_id, created_at);
create index if not exists deliveries_user_supplier_idx on public.deliveries (user_id, supplier_id);

create table if not exists public.payments (
  user_id     uuid    not null references auth.users(id) on delete cascade,
  id          text    not null,
  supplier_id text    not null,
  amount      numeric not null default 0,
  created_at  bigint  not null,   -- write time. THE SYNC WATERMARK.
  paid_at     bigint  not null,   -- when the money really moved. User-editable.
  method      text    not null default 'cash' check (method in ('cash','bank','card','other')),
  doc_number  text,               -- to'lov topshiriqnomasi number
  note        text,
  user_name   text    not null default '',
  user_role   text    not null default 'admin',
  voided      boolean not null default false,
  reversal_of text,
  synced_at   timestamptz not null default now(),
  primary key (user_id, id)
);

create index if not exists payments_user_created_idx  on public.payments (user_id, created_at);
create index if not exists payments_user_supplier_idx on public.payments (user_id, supplier_id);

-- ---------------------------------------------------------------------------
-- Cash drawer (Kassa)
-- ---------------------------------------------------------------------------
-- How each sale was paid (naqd/plastik/click). Only naqd sales feed the physical drawer.
alter table public.transactions add column if not exists payment_method text;

-- Manual cash-drawer movements: deposits, expenses, withdrawals, and count corrections. Money,
-- so append-only and corrected by an opposite-signed twin, and paged on created_at like payments.
create table if not exists public.cash_movements (
  user_id     uuid    not null references auth.users(id) on delete cascade,
  id          text    not null,
  ts          bigint  not null,
  created_at  bigint  not null,
  amount      numeric not null default 0,
  kind        text    not null check (kind in ('deposit','expense','withdrawal','correction')),
  reason      text    not null default '',
  note        text,
  user_name   text    not null default '',
  user_role   text    not null default 'admin',
  voided      boolean not null default false,
  reversal_of text,
  synced_at   timestamptz not null default now(),
  primary key (user_id, id)
);

create index if not exists cash_movements_user_created_idx on public.cash_movements (user_id, created_at);

-- ---------------------------------------------------------------------------
-- Row-level security
-- ---------------------------------------------------------------------------
-- The publishable key ships inside the JS bundle and is readable by anyone who opens the
-- site. RLS is therefore the ONLY thing standing between a stranger and this shop's sales
-- history. Every table is locked to the owning user; `anon` gets nothing at all.

alter table public.products        enable row level security;
alter table public.transactions    enable row level security;
alter table public.suppliers       enable row level security;
alter table public.purchase_orders enable row level security;
alter table public.deliveries      enable row level security;
alter table public.payments        enable row level security;
alter table public.cash_movements  enable row level security;

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

drop policy if exists purchase_orders_select on public.purchase_orders;
drop policy if exists purchase_orders_insert on public.purchase_orders;
drop policy if exists purchase_orders_update on public.purchase_orders;
drop policy if exists purchase_orders_delete on public.purchase_orders;

create policy purchase_orders_select on public.purchase_orders
  for select to authenticated using ((select auth.uid()) = user_id);
create policy purchase_orders_insert on public.purchase_orders
  for insert to authenticated with check ((select auth.uid()) = user_id);
create policy purchase_orders_update on public.purchase_orders
  for update to authenticated
  using ((select auth.uid()) = user_id) with check ((select auth.uid()) = user_id);
create policy purchase_orders_delete on public.purchase_orders
  for delete to authenticated using ((select auth.uid()) = user_id);

drop policy if exists deliveries_select on public.deliveries;
drop policy if exists deliveries_insert on public.deliveries;
drop policy if exists deliveries_update on public.deliveries;
drop policy if exists deliveries_delete on public.deliveries;

create policy deliveries_select on public.deliveries
  for select to authenticated using ((select auth.uid()) = user_id);
create policy deliveries_insert on public.deliveries
  for insert to authenticated with check ((select auth.uid()) = user_id);
create policy deliveries_update on public.deliveries
  for update to authenticated
  using ((select auth.uid()) = user_id) with check ((select auth.uid()) = user_id);
create policy deliveries_delete on public.deliveries
  for delete to authenticated using ((select auth.uid()) = user_id);

drop policy if exists payments_select on public.payments;
drop policy if exists payments_insert on public.payments;
drop policy if exists payments_update on public.payments;
drop policy if exists payments_delete on public.payments;

create policy payments_select on public.payments
  for select to authenticated using ((select auth.uid()) = user_id);
create policy payments_insert on public.payments
  for insert to authenticated with check ((select auth.uid()) = user_id);
create policy payments_update on public.payments
  for update to authenticated
  using ((select auth.uid()) = user_id) with check ((select auth.uid()) = user_id);
create policy payments_delete on public.payments
  for delete to authenticated using ((select auth.uid()) = user_id);

drop policy if exists cash_movements_select on public.cash_movements;
drop policy if exists cash_movements_insert on public.cash_movements;
drop policy if exists cash_movements_update on public.cash_movements;
drop policy if exists cash_movements_delete on public.cash_movements;

create policy cash_movements_select on public.cash_movements
  for select to authenticated using ((select auth.uid()) = user_id);
create policy cash_movements_insert on public.cash_movements
  for insert to authenticated with check ((select auth.uid()) = user_id);
create policy cash_movements_update on public.cash_movements
  for update to authenticated
  using ((select auth.uid()) = user_id) with check ((select auth.uid()) = user_id);
create policy cash_movements_delete on public.cash_movements
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

revoke all on public.products        from anon;
revoke all on public.transactions    from anon;
revoke all on public.suppliers       from anon;
revoke all on public.purchase_orders from anon;
revoke all on public.deliveries      from anon;
revoke all on public.payments        from anon;
revoke all on public.cash_movements  from anon;

revoke all on public.products        from authenticated;
revoke all on public.transactions    from authenticated;
revoke all on public.suppliers       from authenticated;
revoke all on public.purchase_orders from authenticated;
revoke all on public.deliveries      from authenticated;
revoke all on public.payments        from authenticated;
revoke all on public.cash_movements  from authenticated;

-- Exactly the four verbs the sync layer uses. No TRUNCATE, no TRIGGER, no REFERENCES.
grant select, insert, update, delete on public.products        to authenticated;
grant select, insert, update, delete on public.transactions    to authenticated;
grant select, insert, update, delete on public.suppliers       to authenticated;
grant select, insert, update, delete on public.purchase_orders to authenticated;
grant select, insert, update, delete on public.deliveries      to authenticated;
grant select, insert, update, delete on public.payments        to authenticated;
grant select, insert, update, delete on public.cash_movements  to authenticated;

-- ---------------------------------------------------------------------------
-- Realtime
-- ---------------------------------------------------------------------------
-- Devices hear each other's writes instead of polling for them. Realtime honours RLS, so a
-- device is only ever notified about its own shop's rows.
--
-- `alter publication ... add table` errors if the table is already a member, so re-running the
-- whole schema would fail on the tables added the first time round. Guard each add with a
-- membership check so the file stays safe to run start to finish, however many times.
do $$
declare
  t text;
begin
  foreach t in array array[
    'products', 'transactions', 'suppliers',
    'purchase_orders', 'deliveries', 'payments', 'cash_movements'
  ]
  loop
    if not exists (
      select 1 from pg_publication_tables
      where pubname = 'supabase_realtime' and schemaname = 'public' and tablename = t
    ) then
      execute format('alter publication supabase_realtime add table public.%I', t);
    end if;
  end loop;
end $$;

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

-- ---------------------------------------------------------------------------
-- firm_balances — what the shop owes each firm
-- ---------------------------------------------------------------------------
-- The same courtesy `stock_levels` extends for stock: anyone reading this database directly gets
-- the derived number, instead of hunting for a balance column that deliberately does not exist.
--
-- Positive: we owe the firm (qarz). Negative: we have prepaid, so they owe us goods (avans).
--
-- VOIDED ROWS ARE SUMMED, NOT FILTERED. A void writes an opposite-signed twin, so the pair
-- cancels to zero on its own. Adding `where not voided` here would apply the twin alone and
-- report a balance wrong by twice the delivery — which is exactly the bug this comment exists
-- to stop someone "fixing" into place.
--
-- security_invoker = true is essential: a view runs as its OWNER by default, which would bypass
-- RLS and let any signed-in user read every shop's debts.
create or replace view public.firm_balances with (security_invoker = true) as
  select
    s.user_id,
    s.id   as supplier_id,
    s.name,
    coalesce((select sum(d.total_amount) from public.deliveries d
              where d.user_id = s.user_id and d.supplier_id = s.id), 0)
    - coalesce((select sum(p.amount) from public.payments p
                where p.user_id = s.user_id and p.supplier_id = s.id), 0) as balance
  from public.suppliers s
  where s.deleted_at is null;

revoke all on public.firm_balances from anon;
grant select on public.firm_balances to authenticated;
