import {
  createContext,
  useContext,
  useEffect,
  useMemo,
  useState,
  useCallback,
  type ReactNode,
} from 'react'
import { initDb, watchProducts, watchRecentTransactions, watchSuppliers } from './lib/db'
import { watchDeliveries, watchPayments, watchPurchaseOrders } from './lib/procurement'
import { hasAnyAccount, getAccount, login as authLogin, createAccount } from './lib/auth'
import type {
  Product, Transaction, Supplier, Role, Delivery, Payment, PurchaseOrder, Account,
} from './lib/types'

const BASE_BRANDS = ['UzBat', 'Parliament', 'Winston', 'Esse']

interface Actor {
  name: string
  role: Role
}

interface Store {
  ready: boolean
  error: string | null
  products: Product[]
  recent: Transaction[]
  suppliers: Supplier[]
  deliveries: Delivery[]
  payments: Payment[]
  orders: PurchaseOrder[]
  brands: string[]
  /** The signed-in account, or null when the login screen should show. */
  account: Account | null
  /** True when the shop has no accounts yet — show the create-first-admin screen. */
  needsSetup: boolean
  /** Who stamps each ledger write. Derived from the signed-in account. */
  actor: Actor
  login: (name: string, password: string) => Promise<boolean>
  logout: () => void
  createFirstAdmin: (name: string, password: string) => Promise<boolean>
  toast: (msg: string, kind?: 'ok' | 'err') => void
  toasts: { id: number; msg: string; kind: 'ok' | 'err' }[]
}

const Ctx = createContext<Store | null>(null)

const SESSION_KEY = 'ts.session'

export function StoreProvider({ children }: { children: ReactNode }) {
  const [ready, setReady] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [products, setProducts] = useState<Product[]>([])
  const [recent, setRecent] = useState<Transaction[]>([])
  const [suppliers, setSuppliers] = useState<Supplier[]>([])
  const [deliveries, setDeliveries] = useState<Delivery[]>([])
  const [payments, setPayments] = useState<Payment[]>([])
  const [orders, setOrders] = useState<PurchaseOrder[]>([])
  const [account, setAccount] = useState<Account | null>(null)
  const [needsSetup, setNeedsSetup] = useState(false)
  const [toasts, setToasts] = useState<{ id: number; msg: string; kind: 'ok' | 'err' }[]>([])

  const login = useCallback(async (name: string, password: string) => {
    const a = await authLogin(name, password)
    if (!a) return false
    localStorage.setItem(SESSION_KEY, a.id)
    setAccount(a)
    setNeedsSetup(false)
    return true
  }, [])

  const logout = useCallback(() => {
    localStorage.removeItem(SESSION_KEY)
    setAccount(null)
  }, [])

  const createFirstAdmin = useCallback(async (name: string, password: string) => {
    if (await hasAnyAccount()) return false // never mint a second "first" admin
    const a = await createAccount({ name, role: 'admin', password })
    localStorage.setItem(SESSION_KEY, a.id)
    setAccount(a)
    setNeedsSetup(false)
    return true
  }, [])

  const toast = useCallback((msg: string, kind: 'ok' | 'err' = 'ok') => {
    const id = Date.now() + Math.random()
    setToasts((t) => [...t, { id, msg, kind }])
    setTimeout(() => setToasts((t) => t.filter((x) => x.id !== id)), 4000)
  }, [])

  useEffect(() => {
    let stops: (() => void)[] = []
    let cancelled = false

    initDb()
      .then(() => {
        if (cancelled) return
        stops = [
          watchProducts((rows) => {
            setProducts(rows)
            setReady(true)
          }),
          watchRecentTransactions(300, setRecent),
          watchSuppliers(setSuppliers),
          watchDeliveries(setDeliveries),
          watchPayments(setPayments),
          watchPurchaseOrders(setOrders),
        ]

        // Resolve who is signed in, if anyone. A stored session id that no longer maps to a
        // live account (deleted, or a wiped browser) falls back to the login screen.
        void (async () => {
          const anyAccount = await hasAnyAccount()
          if (cancelled) return
          setNeedsSetup(!anyAccount)
          const sid = localStorage.getItem(SESSION_KEY)
          if (sid) {
            const a = await getAccount(sid)
            if (cancelled) return
            if (a) setAccount(a)
            else localStorage.removeItem(SESSION_KEY)
          }
        })()
      })
      .catch((e: Error) => {
        if (!cancelled) setError(e.message)
      })

    return () => {
      cancelled = true
      stops.forEach((s) => s())
    }
  }, [])

  const brands = useMemo(() => {
    const set = new Set(BASE_BRANDS)
    for (const p of products) if (p.brand) set.add(p.brand)
    return [...set].sort()
  }, [products])

  // Every ledger write is stamped with whoever is signed in. The placeholder is never used: the
  // app never renders a write path while signed out (App.tsx shows the login screen instead).
  const actor: Actor = account
    ? { name: account.name, role: account.role }
    : { name: '', role: 'cashier' }

  const value: Store = {
    ready, error, products, recent, suppliers, deliveries, payments, orders,
    brands, account, needsSetup, actor, login, logout, createFirstAdmin, toast, toasts,
  }

  return <Ctx.Provider value={value}>{children}</Ctx.Provider>
}

export function useStore(): Store {
  const c = useContext(Ctx)
  if (!c) throw new Error('useStore must be used inside StoreProvider')
  return c
}
