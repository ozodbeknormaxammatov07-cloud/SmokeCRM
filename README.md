# Tamaki Savdo — cigarette shop inventory & sales

Replaces the four-sheet Excel file (UzBat / Parliament / Winston / Esse) with a
real system: every stock movement is a ledger row, and stock, profit, margin and
reorder alerts are all derived from it.

**Daily user guide (Uzbek): [QOLLANMA.md](./QOLLANMA.md)** — hand this to the shopkeeper.

---

## Stack, and why

| Choice | Reason |
|---|---|
| **React + Vite + TypeScript** | Static build. Nothing to run but a web server; fast on a cheap phone. |
| **IndexedDB** (browser database) | **No cloud, no account, no third party.** Data stays on the shop's device. Works with no internet at all. |
| **Tailwind** | Small, consistent, no component library to outgrow. |
| **SheetJS (xlsx)** | Excel import/export runs in the browser — the spreadsheet never leaves the device. |

No backend, no external service, no signup, no monthly cost. The whole app is
static files plus a database that lives inside the browser.

### Read this before you rely on it

Because there is no server, **the data lives in one browser on one device.** That is
a deliberate trade — total privacy and zero cost — but it has real consequences:

- Clearing "site data"/browsing data for this site **erases the shop's records.**
- It does **not** sync between the counter phone and the office laptop. They are
  two separate shops as far as the app is concerned.
- If the device dies, the data dies with it.

So: **press `Hisobot → 💾 Zaxira nusxa` regularly** and keep the `.json` file
somewhere safe (OneDrive, Telegram saved messages, a USB stick). That file restores
everything exactly via `Hisobot → ♻️ Tiklash`. It is the only safety net there is.

If you later want multi-device sync and automatic backups, that needs a server —
see *Adding sync* below.

---

## The one design decision that matters

**Products don't store truth — the ledger does.**

`current_stock` on a product is a *cache* of the transaction log. It is only ever
written inside an atomic IndexedDB transaction by `commitCart` / `adjustStock`, and
the product edit form has the stock field disabled. Profit is computed at write time
from a **snapshot of the cost price** on the transaction row, so repricing a product
tomorrow doesn't silently rewrite the profit of every sale from last month.

Corrections are **reversals, not deletes**. `voidTransaction` flags the original and
posts an opposite-signed row, so the history always shows what was entered, what was
reversed, and by whom. Nothing in the UI can delete a ledger row.

The stock guard re-reads stock *inside* the transaction, so a double-tapped confirm
can't oversell the last carton.

---

## Run it

```bash
npm install
npm run dev          # http://localhost:5173
```

## Deploy it

`npm run build` produces `dist/` — plain static files. Host them anywhere (or just
open them from disk). Since the data is per-browser, the usual setup is: put it on
one device, add it to the home screen, and always use it from there.

---

## Data model

**`products`** — `name, brand, cost_price, selling_price, current_stock,
reorder_threshold, barcode?, supplier_id?, active`.
Margin and per-unit profit are derived on read, never stored.

**`transactions`** (append-only) — `ts, type (SALE|RESTOCK), product_id,
product_name, brand, quantity, unit_price, cost_price, total_amount, profit, note,
user_name, user_role, ref_id, voided, reversal_of?`.

`ref_id` groups the lines of one basket. `cost_price` is the snapshot described
above. Denormalised `product_name`/`brand` keep history readable after a product is
renamed or deleted.

**`suppliers`** — `name, contact, note`. Optional; wired into the schema.

**Users** are lightweight: a name + role (`admin` / `cashier`) held in `localStorage`
and stamped onto every row, so you know who recorded what. There are no passwords —
anyone with the device can use it.

---

## Excel import

`Mahsulotlar → 📄 Excel import`. Built for a hand-made shop file, so it:

- reads **every sheet** and uses the **sheet name as the brand** (matching your
  current one-sheet-per-brand layout);
- **finds the header row** even when there's a title or blank rows above it;
- auto-maps columns from Uzbek, Russian and English names (`Sotib olish narxi`,
  `Закуп`, `Purchase price` → `cost_price`), with a dropdown to correct any guess;
- parses `"14 000"` and `"14 000 so'm"` as `14000`;
- drops `Jami` / `Итого` / `Total` footer rows;
- flags rows with no name or no selling price and skips them;
- posts opening stock as a **RESTOCK ledger row**, so day-one inventory has the same
  audit trail as everything after it.

Import only ever **adds** — it never overwrites what's already there. Products the shop
already has are detected (by barcode, or by name+brand if there's no barcode), shown as
`bazada bor`, and skipped, so running the same file twice is safe.

---

## Adding sync later

`src/lib/db.ts` is the only file that touches storage; every page goes through it.
To move to a server, reimplement that one module's exports against your backend and
nothing else changes. Reasonable options: Supabase (Postgres, generous free tier),
PocketBase (single Go binary you can run on any cheap VPS), or your own API. The
`watch*` functions already have the shape of live subscriptions.

---

## Project layout

```
src/
  lib/
    idb.ts         IndexedDB wrapper: atomic transactions, change notification
    db.ts          ← all writes. Atomic carts, stock guard, voids, import, backup
    analytics.ts   ← all reads. Totals, breakdowns, reorder list. Pure functions
    types.ts       Product, Transaction, Supplier, User
    format.ts      so'm formatting, NBSP thousands, tolerant number parsing
    excel.ts       import parsing + column auto-map, report/backup export
  components/
    Counter.tsx    the till — shared by Sales and Restock
    ImportWizard.tsx
    charts.tsx     validated colorblind-safe palette
    ui.tsx
  pages/           Dashboard, Products, Sales, Restock, Reports
```

`db.ts` and `analytics.ts` are the whole system. Everything else is presentation.
