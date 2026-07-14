export type TxType = 'SALE' | 'RESTOCK'
export type Role = 'admin' | 'cashier'

export interface Product {
  id: string
  name: string
  brand: string
  cost_price: number
  selling_price: number
  /**
   * DERIVED, never authoritative. It is a cache of the ledger — the signed sum of every
   * transaction row for this product — kept on the record so the till doesn't have to
   * re-scan history on every keystroke.
   *
   * It is a cache because two devices editing one counter is a lost-update race: both read
   * 10, both sell 3, one write wins, and the shop has sold 6 packets but only decremented 3.
   * The ledger is append-only, so two devices appending sales merge cleanly and the stock
   * falls out as a sum. Recomputed by `recomputeStock` after any local write or remote merge.
   */
  current_stock: number
  reorder_threshold: number
  barcode?: string
  supplier_id?: string
  active: boolean
  created_at?: number
  updated_at?: number
  /**
   * Tombstone. A deleted product is flagged, not removed, because sync cannot tell "deleted
   * here" apart from "created on the other device and not yet pulled" — and guessing deletes
   * the other device's work.
   */
  deleted_at?: number
}

/**
 * Append-only ledger. Every stock movement is one row.
 *
 * `cost_price` is snapshotted at write time so profit stays correct even after
 * a product is later repriced — recomputing from the product's current cost
 * would silently rewrite the profit of every past sale.
 */
export interface Transaction {
  id: string
  ts: number
  type: TxType
  product_id: string
  product_name: string
  brand: string
  quantity: number
  unit_price: number
  cost_price: number
  total_amount: number
  profit: number
  note?: string
  user_name: string
  user_role: Role
  ref_id: string
  voided?: boolean
  void_of?: string
  reversal_of?: string
  /** How a SALE was paid. Unset on RESTOCK and on sales made before this feature. */
  payment_method?: SalePaymentMethod
}

/**
 * A firm we buy from. `contact` remains the phone number (it already was one); everything
 * added here is what you need in order to actually transfer money to them.
 */
export interface Supplier {
  id: string
  name: string
  contact?: string
  note?: string
  /** STIR — tax identification number. */
  inn?: string
  /** Hisob raqam — settlement account. */
  bank_account?: string
  bank_name?: string
  /** MFO — bank routing code. */
  bank_mfo?: string
  address?: string
  director?: string
  /** Days of credit the firm grants us. Drives the overdue calculation. */
  payment_terms_days?: number
  updated_at?: number
  deleted_at?: number
}

export type PaymentMethod = 'cash' | 'bank' | 'card' | 'other'

/** How a customer paid for a sale. Only 'cash' touches the cash drawer (Kassa). */
export type SalePaymentMethod = 'cash' | 'card' | 'click'

export type CashMovementKind = 'deposit' | 'expense' | 'withdrawal' | 'correction'

/**
 * Manual cash into or out of the drawer — anything that isn't a sale or a firm payment.
 * Append-only; corrected by an opposite-signed twin, exactly like a Payment.
 */
export interface CashMovement {
  id: string
  ts: number                 // when it happened; user-visible, drives ordering
  created_at: number         // write time; the sync watermark
  /** Signed: positive adds to the drawer, negative removes it. */
  amount: number
  kind: CashMovementKind
  reason: string
  note?: string
  user_name: string
  user_role: Role
  voided?: boolean
  reversal_of?: string
}

/** Derived from the deliveries — except `cancelled`, which is a human decision. */
export type OrderStatus = 'waiting' | 'partial' | 'received' | 'overdue' | 'cancelled'

/** One product line on an order or a delivery. Shared shape — they line up 1:1 by design. */
export interface OrderLine {
  product_id: string
  product_name: string
  brand: string
  quantity: number
  unit_cost: number
}

/**
 * An intention, not money. Placing an order moves NOTHING — no stock, no debt — until goods
 * physically arrive as a Delivery. Mutable and last-write-wins, like a product: a lost
 * concurrent edit to an intention is annoying, never corrupting.
 *
 * `number` is a human label for talking to the firm ("buyurtma #007"), never a key. Two devices
 * offline can therefore both mint #007. That is cosmetic and accepted — a collision-free counter
 * would be exactly the shared mutable state this design avoids everywhere else.
 */
export interface PurchaseOrder {
  id: string
  supplier_id: string
  number: string
  ordered_at: number
  expected_at?: number
  lines: OrderLine[]
  cancelled_at?: number
  note?: string
  user_name: string
  user_role: Role
  created_at: number
  updated_at: number
  deleted_at?: number
}

/**
 * The event that moves stock AND money, in one atomic write. Append-only; corrected only by an
 * opposite-signed twin, exactly like a Transaction.
 *
 * Two dates, and the difference is load-bearing:
 *
 *   created_at   — write time. Immutable. THE SYNC WATERMARK.
 *   delivered_at — when the goods really arrived. User-editable, because deliveries get typed
 *                  in days late.
 *
 * Sync MUST page on `created_at`. Paging on `delivered_at` would drop a backdated delivery
 * behind the other device's watermark, so it would never replicate — and the two tills would
 * disagree about what the shop owes, forever.
 */
export interface Delivery {
  id: string
  supplier_id: string
  /** Optional: goods sometimes arrive without an order, because the agent just shows up. */
  order_id?: string
  created_at: number
  delivered_at: number
  /** Faktura number and date. The paper stays in the folder; we record the reference. */
  doc_number?: string
  doc_date?: number
  lines: OrderLine[]
  /** Snapshotted at write time, for the same reason `Transaction.cost_price` is. */
  total_amount: number
  note?: string
  user_name: string
  user_role: Role
  voided?: boolean
  reversal_of?: string
}

/** Money out. Append-only and immutable. Same two-date rule as Delivery. */
export interface Payment {
  id: string
  supplier_id: string
  amount: number
  created_at: number
  paid_at: number
  method: PaymentMethod
  /** To'lov topshiriqnomasi number. */
  doc_number?: string
  note?: string
  user_name: string
  user_role: Role
  voided?: boolean
  reversal_of?: string
}

export interface User {
  id: string
  name: string
  role: Role
}

/** A staff login. Password is stored only as a PBKDF2 hash + per-account salt (both base64). */
export interface Account {
  id: string
  /** The login handle. Unique case-insensitively. */
  name: string
  role: Role
  salt: string
  password_hash: string
  created_at: number
  updated_at: number
  /** Soft delete: a removed cashier can't log in, but their name stays on past ledger rows. */
  deleted_at?: number
}

/**
 * A gated ability. Every one is admin-only today; the map in auth.ts is the single place that
 * decides, so widening a capability to cashiers later is one edit, not a hunt through the UI.
 */
export type Capability =
  | 'view-dashboard'
  | 'receive-stock'
  | 'view-firms'
  | 'view-reports'
  | 'manage-products'
  | 'void'
  | 'manage-staff'
  | 'view-kassa'

export type NewProduct = Omit<Product, 'id' | 'created_at' | 'updated_at'>

export interface CartLine {
  product: Product
  quantity: number
  unit_price: number
}
