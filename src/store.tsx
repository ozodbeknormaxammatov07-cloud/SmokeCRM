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
import { startAutoSync } from './lib/sync'
import type {
  Product, Transaction, Supplier, Role, Delivery, Payment, PurchaseOrder,
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
  actor: Actor
  setActor: (a: Actor) => void
  toast: (msg: string, kind?: 'ok' | 'err') => void
  toasts: { id: number; msg: string; kind: 'ok' | 'err' }[]
}

const Ctx = createContext<Store | null>(null)

const ACTOR_KEY = 'ts.actor'

function loadActor(): Actor {
  try {
    const raw = localStorage.getItem(ACTOR_KEY)
    if (raw) return JSON.parse(raw) as Actor
  } catch {
    /* first run */
  }
  return { name: 'Sotuvchi', role: 'admin' }
}

export function StoreProvider({ children }: { children: ReactNode }) {
  const [ready, setReady] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [products, setProducts] = useState<Product[]>([])
  const [recent, setRecent] = useState<Transaction[]>([])
  const [suppliers, setSuppliers] = useState<Supplier[]>([])
  const [deliveries, setDeliveries] = useState<Delivery[]>([])
  const [payments, setPayments] = useState<Payment[]>([])
  const [orders, setOrders] = useState<PurchaseOrder[]>([])
  const [actor, setActorState] = useState<Actor>(loadActor)
  const [toasts, setToasts] = useState<{ id: number; msg: string; kind: 'ok' | 'err' }[]>([])

  const setActor = useCallback((a: Actor) => {
    setActorState(a)
    localStorage.setItem(ACTOR_KEY, JSON.stringify(a))
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
          // Cloud backup is strictly additive: if it's unconfigured or the network is down,
          // this is a no-op and the till carries on exactly as before.
          startAutoSync(),
        ]
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

  const value: Store = {
    ready, error, products, recent, suppliers, deliveries, payments, orders,
    brands, actor, setActor, toast, toasts,
  }

  return <Ctx.Provider value={value}>{children}</Ctx.Provider>
}

export function useStore(): Store {
  const c = useContext(Ctx)
  if (!c) throw new Error('useStore must be used inside StoreProvider')
  return c
}
