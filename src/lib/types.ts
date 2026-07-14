export type TxType = 'SALE' | 'RESTOCK'
export type Role = 'admin' | 'cashier'

export interface Product {
  id: string
  name: string
  brand: string
  cost_price: number
  selling_price: number
  current_stock: number
  reorder_threshold: number
  barcode?: string
  supplier_id?: string
  active: boolean
  created_at?: number
  updated_at?: number
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
