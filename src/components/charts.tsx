import {
  BarChart, Bar, XAxis, YAxis, CartesianGrid, Tooltip, ResponsiveContainer,
  LineChart, Line, Legend,
} from 'recharts'
import { moneyShort, num } from '../lib/format'

/** Validated categorical slots (light surface #fff): CVD ΔE 73.6. */
export const SERIES = {
  revenue: '#2a78d6', // slot 1 — blue
  profit: '#1baf7a', // slot 2 — aqua
  units: '#2a78d6',
}

const INK = { muted: '#898781', grid: '#e1e0d9', axis: '#c3c2b7' }

const AXIS = {
  tick: { fill: INK.muted, fontSize: 11 },
  axisLine: { stroke: INK.axis },
  tickLine: false as const,
}

function TipBox({ rows, label }: { rows: { name: string; value: string; color: string }[]; label: string }) {
  return (
    <div className="rounded-lg border border-ink-200 bg-white shadow-lg px-3 py-2 text-xs">
      <div className="font-semibold mb-1">{label}</div>
      {rows.map((r) => (
        <div key={r.name} className="flex items-center gap-2 whitespace-nowrap">
          <span className="w-2 h-2 rounded-sm shrink-0" style={{ background: r.color }} />
          <span className="text-ink-500">{r.name}</span>
          <span className="ml-auto font-semibold num">{r.value}</span>
        </div>
      ))}
    </div>
  )
}

interface TipProps {
  active?: boolean
  label?: string | number
  payload?: { name?: string; dataKey?: string | number; value?: number; color?: string }[]
}

/** Horizontal bars: product names are long, and length reads as magnitude. */
export function BestSellersChart({ data }: { data: { name: string; units: number }[] }) {
  if (!data.length) {
    return <div className="h-64 grid place-items-center text-sm text-ink-400">Ma'lumot yo'q</div>
  }
  return (
    <ResponsiveContainer width="100%" height={Math.max(200, data.length * 44)}>
      <BarChart data={data} layout="vertical" margin={{ top: 4, right: 44, bottom: 4, left: 4 }}>
        <CartesianGrid horizontal={false} stroke={INK.grid} />
        <XAxis type="number" {...AXIS} />
        <YAxis
          type="category"
          dataKey="name"
          width={130}
          {...AXIS}
          tick={{ ...AXIS.tick, fontSize: 12 }}
        />
        <Tooltip
          cursor={{ fill: 'rgba(11,11,11,0.04)' }}
          content={({ active, label, payload }: TipProps) =>
            active && payload?.length ? (
              <TipBox
                label={String(label)}
                rows={[{ name: 'Sotilgan', value: `${num(payload[0].value ?? 0)} dona`, color: SERIES.units }]}
              />
            ) : null
          }
        />
        <Bar
          dataKey="units"
          fill={SERIES.units}
          radius={[0, 4, 4, 0]}
          barSize={18}
          label={{ position: 'right', fill: INK.muted, fontSize: 11 }}
        />
      </BarChart>
    </ResponsiveContainer>
  )
}

/** Revenue and profit share one axis — both are so'm, so no dual scale is needed. */
export function TrendChart({ data }: { data: { label: string; revenue: number; profit: number }[] }) {
  if (!data.length) {
    return <div className="h-64 grid place-items-center text-sm text-ink-400">Ma'lumot yo'q</div>
  }
  return (
    <ResponsiveContainer width="100%" height={280}>
      <LineChart data={data} margin={{ top: 8, right: 12, bottom: 4, left: 4 }}>
        <CartesianGrid vertical={false} stroke={INK.grid} />
        <XAxis dataKey="label" {...AXIS} />
        <YAxis {...AXIS} width={64} tickFormatter={(v: number) => moneyShort(v).replace(" so'm", '')} />
        <Tooltip
          cursor={{ stroke: INK.axis, strokeWidth: 1 }}
          content={({ active, label, payload }: TipProps) =>
            active && payload?.length ? (
              <TipBox
                label={String(label)}
                rows={payload.map((p) => ({
                  name: p.dataKey === 'revenue' ? 'Tushum' : 'Foyda',
                  value: moneyShort(p.value ?? 0),
                  color: p.color ?? INK.muted,
                }))}
              />
            ) : null
          }
        />
        <Legend
          verticalAlign="top"
          align="right"
          height={28}
          iconType="square"
          iconSize={9}
          formatter={(v: string) => (
            <span className="text-xs text-ink-500">{v === 'revenue' ? 'Tushum' : 'Foyda'}</span>
          )}
        />
        <Line
          type="monotone" dataKey="revenue" stroke={SERIES.revenue} strokeWidth={2}
          dot={false} activeDot={{ r: 4, strokeWidth: 2, stroke: '#fff' }}
        />
        <Line
          type="monotone" dataKey="profit" stroke={SERIES.profit} strokeWidth={2}
          dot={false} activeDot={{ r: 4, strokeWidth: 2, stroke: '#fff' }}
        />
      </LineChart>
    </ResponsiveContainer>
  )
}

/** Single-series brand revenue — one hue, no legend (the title names it). */
export function BrandChart({ data }: { data: { name: string; revenue: number }[] }) {
  if (!data.length) {
    return <div className="h-64 grid place-items-center text-sm text-ink-400">Ma'lumot yo'q</div>
  }
  return (
    <ResponsiveContainer width="100%" height={260}>
      <BarChart data={data} margin={{ top: 8, right: 8, bottom: 4, left: 4 }}>
        <CartesianGrid vertical={false} stroke={INK.grid} />
        <XAxis dataKey="name" {...AXIS} />
        <YAxis {...AXIS} width={64} tickFormatter={(v: number) => moneyShort(v).replace(" so'm", '')} />
        <Tooltip
          cursor={{ fill: 'rgba(11,11,11,0.04)' }}
          content={({ active, label, payload }: TipProps) =>
            active && payload?.length ? (
              <TipBox
                label={String(label)}
                rows={[{ name: 'Tushum', value: moneyShort(payload[0].value ?? 0), color: SERIES.revenue }]}
              />
            ) : null
          }
        />
        <Bar dataKey="revenue" fill={SERIES.revenue} radius={[4, 4, 0, 0]} maxBarSize={56} />
      </BarChart>
    </ResponsiveContainer>
  )
}
