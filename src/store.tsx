import {
  createContext,
  useContext,
  useEffect,
  useMemo,
  useState,
  useCallback,
  type ReactNode,
} from 'react'
import { watchProducts, watchRecentTransactions, watchSuppliers } from './lib/db'
import { watchDeliveries, watchPayments, watchPurchaseOrders } from './lib/procurement'
import { watchCashMovements } from './lib/kassa'
import { startCloud, stopCloud } from './lib/idb'
import { hasAnyAccount, getAccount, login as authLogin, createAccount } from './lib/auth'
import { supabase, currentSession, signOut, type Session } from './lib/supabase'
import type {
  Product, Transaction, Supplier, Role, Delivery, Payment, PurchaseOrder, Account, CashMovement,
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
  movements: CashMovement[]
  brands: string[]
  /** True once the shop (Supabase) session has been checked — before this, show a spinner. */
  shopResolved: boolean
  /** True when the shop account is signed in. When false, the whole app is the shop-login screen. */
  shopSignedIn: boolean
  /** The signed-in shop account's email, for the account panel. */
  shopEmail: string | null
  /** Signs the whole shop out (and the current staff member with it). */
  signOutShop: () => Promise<void>
  /** The signed-in staff member, or null when the staff-login screen should show. */
  account: Account | null
  /** True when the shop has no staff yet — show the create-first-admin screen. */
  needsSetup: boolean
  /** Who stamps each ledger write. Derived from the signed-in staff member. */
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
  const [shopSession, setShopSession] = useState<Session | null>(null)
  const [shopResolved, setShopResolved] = useState(false)
  const [ready, setReady] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [products, setProducts] = useState<Product[]>([])
  const [recent, setRecent] = useState<Transaction[]>([])
  const [suppliers, setSuppliers] = useState<Supplier[]>([])
  const [deliveries, setDeliveries] = useState<Delivery[]>([])
  const [payments, setPayments] = useState<Payment[]>([])
  const [orders, setOrders] = useState<PurchaseOrder[]>([])
  const [movements, setMovements] = useState<CashMovement[]>([])
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

  const signOutShop = useCallback(async () => {
    // Drop the staff actor as well, so the next shop to sign in starts at its own staff login.
    localStorage.removeItem(SESSION_KEY)
    setAccount(null)
    await signOut()
  }, [])

  const toast = useCallback((msg: string, kind: 'ok' | 'err' = 'ok') => {
    const id = Date.now() + Math.random()
    setToasts((t) => [...t, { id, msg, kind }])
    setTimeout(() => setToasts((t) => t.filter((x) => x.id !== id)), 4000)
  }, [])

  // Resolve and then track the shop (Supabase) session. This is the ONE cloud login — everyone
  // who signs in here sees the same data. Staff names + PINs live underneath it.
  useEffect(() => {
    let cancelled = false
    void currentSession().then((s) => {
      if (cancelled) return
      setShopSession(s)
      setShopResolved(true)
    })
    const sub = supabase?.auth.onAuthStateChange((_e, s) => {
      setShopSession(s)
      setShopResolved(true)
    })
    return () => { cancelled = true; sub?.data.subscription.unsubscribe() }
  }, [])

  const uid = shopSession?.user.id ?? null

  // With a shop signed in: load the whole shop into memory once, open the live views, and
  // resolve who (which staff member) is at the till. Signing out tears all of that down.
  useEffect(() => {
    if (!uid) {
      setReady(false)
      setProducts([]); setRecent([]); setSuppliers([]); setDeliveries([])
      setPayments([]); setOrders([]); setMovements([])
      setAccount(null); setNeedsSetup(false); setError(null)
      void stopCloud()
      return
    }

    let stops: (() => void)[] = []
    let cancelled = false
    setReady(false)
    setError(null)

    startCloud(uid)
      .then(async () => {
        if (cancelled) return
        stops = [
          watchProducts(setProducts),
          watchRecentTransactions(300, setRecent),
          watchSuppliers(setSuppliers),
          watchDeliveries(setDeliveries),
          watchPayments(setPayments),
          watchPurchaseOrders(setOrders),
          watchCashMovements(setMovements),
        ]

        // A shop with no staff yet shows the create-first-admin screen. Otherwise restore the
        // staff member who was last at this till, if their account still exists.
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
        setReady(true)
      })
      .catch((e: unknown) => {
        if (!cancelled) setError(e instanceof Error ? e.message : 'Bulutga ulanib bo\'lmadi')
      })

    return () => {
      cancelled = true
      stops.forEach((s) => s())
      void stopCloud()
    }
  }, [uid])

  const brands = useMemo(() => {
    const set = new Set(BASE_BRANDS)
    for (const p of products) if (p.brand) set.add(p.brand)
    return [...set].sort()
  }, [products])

  // Every ledger write is stamped with whoever is signed in. The placeholder is never used: the
  // app never renders a write path while signed out (App.tsx shows a login screen instead).
  const actor: Actor = account
    ? { name: account.name, role: account.role }
    : { name: '', role: 'cashier' }

  const value: Store = {
    ready, error, products, recent, suppliers, deliveries, payments, orders, movements,
    brands, shopResolved, shopSignedIn: !!uid, shopEmail: shopSession?.user.email ?? null,
    signOutShop, account, needsSetup, actor, login, logout, createFirstAdmin, toast, toasts,
  }

  return <Ctx.Provider value={value}>{children}</Ctx.Provider>
}

export function useStore(): Store {
  const c = useContext(Ctx)
  if (!c) throw new Error('useStore must be used inside StoreProvider')
  return c
}
