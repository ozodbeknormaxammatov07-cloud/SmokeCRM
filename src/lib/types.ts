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
}

export interface Supplier {
  id: string
  name: string
  contact?: string
  note?: string
  updated_at?: number
  deleted_at?: number
}

export interface User {
  id: string
  name: string
  role: Role
}

export type NewProduct = Omit<Product, 'id' | 'created_at' | 'updated_at'>

export interface CartLine {
  product: Product
  quantity: number
  unit_price: number
}
