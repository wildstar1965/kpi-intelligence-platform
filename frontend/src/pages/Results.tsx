/**
 * The Results screen: every stored KPI verdict, newest first.
 *
 * This is the list a business reader opens to find the movement somebody told them
 * about, and the only route into a stored result. Four rules hold the screen
 * together, and each one is a decision rather than a style:
 *
 *  1. **Narrowing belongs to the server; searching belongs to the browser.** The
 *     stored list is capped, so filtering the page the browser happens to hold
 *     would leave an older date unreachable. Search is a free-text scan of what is
 *     on screen and stays local, so typing does not issue a request per keystroke.
 *  2. **The figures at the top describe the rows underneath them.** They are
 *     counted from the rows on screen rather than read from the server's own
 *     `summary`, which describes the narrowed *query* — correct until somebody
 *     types in the search box, and contradicting the visible table from then on.
 *     The one figure the browser cannot know, the company's full stored count,
 *     is still the server's.
 *  3. **A row states the verdict; the reasoning lives one click away.** Seven
 *     short columns and one clamped sentence — no statistics, no method names, no
 *     ids. Everything behind the verdict is on the result page, which has room
 *     for it.
 *  4. **Colour carries meaning or nothing.** The verdict badge is the only place
 *     a row is tinted. A deviation is not coloured by its sign, because a fall in
 *     returns and a fall in revenue are not the same news.
 */

import { useMemo, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { api } from '../api/client'
import type { ResultHistoryResponse, ResultHistoryItem } from '../api/types'
import { useAuth } from '../auth/AuthContext'
import { formatCompact, formatCurrency, formatDate, formatKpiName } from '../components/format'
import {
  Alert,
  EmptyState,
  Field,
  LoadError,
  LoadingState,
  PageHeader,
  Panel,
  StatCard,
  StatusBadge,
} from '../components/ui'
import { useResource } from '../components/useResource'

const ALL = 'all'

/** The status buttons. `all` first, then the verdicts the engine issues. */
const STATUS_FILTERS = [ALL, 'NORMAL', 'ABNORMAL', 'LOW_CONFIDENCE'] as const

/** Sentence case for the pills: the constants are shouted, a control should not be. */
const STATUS_LABELS: Record<string, string> = {
  [ALL]: 'All',
  NORMAL: 'Normal',
  ABNORMAL: 'Abnormal',
  LOW_CONFIDENCE: 'Low confidence',
}

/**
 * A measurement in the KPI's own unit — the same rule Monitoring applies.
 *
 * The row carries `currency` and `unit` from the stored run, so the unit is read,
 * never inferred. Guessing money by looking for "revenue" or "sales" in the KPI
 * key mislabels every other currency KPI, and pinning the symbol to USD prints
 * dollars for a company whose books are in something else.
 */
function formatValue(item: ResultHistoryItem, value: number | null | undefined): string {
  if (value === null || value === undefined) return '—'
  if (item.currency) return formatCurrency(value, item.currency, true)
  if (item.unit === 'currency') return formatCurrency(value, 'INR', true)
  return formatCompact(value)
}

function formatDeviation(item: ResultHistoryItem): string {
  if (item.deviation_pct === null || item.deviation_pct === undefined) return '—'
  return `${item.deviation_pct >= 0 ? '+' : ''}${item.deviation_pct.toFixed(1)}%`
}

/**
 * The sentence to show for a row.
 *
 * A generated explanation is used when one exists. Nothing in the platform writes
 * them today — explanation generation belongs to the Copilot and is off by
 * default — so in practice this is the engine's deterministic headline, which is
 * stored for every run. Showing that beats the empty column this page used to
 * render on every single row.
 */
function summaryText(item: ResultHistoryItem): string | null {
  return item.ai_explanation ?? item.top_driver ?? null
}

/**
 * The small caption under a KPI's name.
 *
 * A registered KPI has both a key and a display name, and for many of them the
 * two say the same thing once the key is read as English. Printing the key only
 * when it adds something keeps the row from repeating itself, and means no raw
 * `snake_case` identifier reaches the page either way.
 */
function subtitleFor(item: ResultHistoryItem): string | null {
  const name = formatKpiName(item.kpi_name)
  const key = formatKpiName(item.kpi_key)
  return key === name ? null : key
}

export default function Results() {
  const { companyId, can } = useAuth()
  const navigate = useNavigate()
  const mayView = can('analytics.read')

  // The four narrowing filters are server-side. The list is capped, so filtering
  // the page the browser already holds would leave an older date unreachable —
  // the reader would have no way to the very row they came for.
  const [statusFilter, setStatusFilter] = useState<string>(ALL)
  const [kpiFilter, setKpiFilter] = useState<string>(ALL)
  const [dateFilter, setDateFilter] = useState<string>(ALL)
  const [dimensionFilter, setDimensionFilter] = useState<string>(ALL)
  // Search stays client-side: it is a free-text scan across what is on screen,
  // not a narrowing the server can index, and keeping it local means typing does
  // not issue a request per keystroke.
  const [query, setQuery] = useState('')

  const history = useResource<ResultHistoryResponse>(() => {
    const params = new URLSearchParams()
    if (statusFilter !== ALL) params.set('status', statusFilter)
    if (kpiFilter !== ALL) params.set('kpi_key', kpiFilter)
    if (dateFilter !== ALL) params.set('target_date', dateFilter)
    if (dimensionFilter !== ALL) params.set('dimension', dimensionFilter)
    const suffix = params.toString()
    return api.get(`/companies/${companyId}/results${suffix ? `?${suffix}` : ''}`)
  }, [companyId, mayView, statusFilter, kpiFilter, dateFilter, dimensionFilter], {
    enabled: Boolean(companyId) && mayView,
  })

  const options = history.data?.options
  const kpiOptions = options?.kpis ?? []
  const dateOptions = options?.dates ?? []
  // Offered only when the server says this caller may read findings and some
  // exist, so the screen never shows a control that would return nothing.
  const dimensionOptions = options?.dimensions ?? []

  const narrowed =
    statusFilter !== ALL || kpiFilter !== ALL || dateFilter !== ALL || dimensionFilter !== ALL
  const searching = query.trim().length > 0
  const filtered = narrowed || searching

  const items = useMemo(() => {
    const base = history.data?.items ?? []
    const needle = query.trim().toLowerCase()
    if (!needle) return base
    return base.filter((item) => {
      // Both spellings are searchable: what the reader sees, and the key they
      // may know the KPI by from the registry. Recorded dimensions and entities
      // join the haystack when the caller may see them, so searching for an area
      // finds the results somebody has already marked up along it.
      const haystack = [
        formatKpiName(item.kpi_name),
        item.kpi_name,
        item.kpi_key,
        item.status,
        item.target_date,
        summaryText(item) ?? '',
        ...(item.dimensions ?? []),
        ...(item.entities ?? []),
      ]
        .join(' ')
        .toLowerCase()
      return haystack.includes(needle)
    })
  }, [history.data, query])

  // Counted from the rows on screen — see rule 2 in the module docstring.
  const tally = useMemo(() => {
    const kpis = new Set<string>()
    let abnormal = 0
    let normal = 0
    let lowConfidence = 0
    for (const item of items) {
      kpis.add(item.kpi_key)
      if (item.status === 'ABNORMAL') abnormal += 1
      else if (item.status === 'NORMAL') normal += 1
      else if (item.status === 'LOW_CONFIDENCE') lowConfidence += 1
    }
    return { kpiCount: kpis.size, abnormal, normal, lowConfidence }
  }, [items])

  function clearFilters() {
    setStatusFilter(ALL)
    setKpiFilter(ALL)
    setDateFilter(ALL)
    setDimensionFilter(ALL)
    setQuery('')
  }

  if (!mayView) {
    return (
      <Alert tone="warn">
        You do not have permission to view stored result history for this company.
      </Alert>
    )
  }

  // First load only. Every later fetch keeps the page in place and marks itself
  // in the panel head, so changing a filter never blanks the screen.
  if (history.loading && !history.data) {
    return (
      <LoadingState
        label="Loading stored results…"
        detail="Reading every KPI verdict for this company."
      />
    )
  }

  if (history.error) {
    return (
      <LoadError
        message="Unable to load stored results."
        detail={history.error}
        onRetry={() => void history.reload()}
      />
    )
  }

  const totalStored = history.data?.total_stored ?? history.data?.summary.total_runs ?? items.length
  const countLine = filtered
    ? `${items.length} shown of ${totalStored} stored`
    : `${items.length} results · ${tally.kpiCount} ${tally.kpiCount === 1 ? 'KPI' : 'KPIs'}`

  return (
    <div className="space-y-4">
      {/* -------------------------------------------------------------- header */}
      <PageHeader
        eyebrow="Results"
        title="Agent run history"
        subtitle="Every KPI the platform has judged. Open one to see what happened and what to do."
        actions={
          <div className="glass-nav w-fit rounded-[14px] p-1" role="group" aria-label="Status">
            {STATUS_FILTERS.map((filter) => (
              <button
                key={filter}
                type="button"
                aria-pressed={statusFilter === filter}
                onClick={() => setStatusFilter(filter)}
                className={`nav-pill px-2.5 py-1.5 text-xs ${statusFilter === filter ? 'nav-pill-active' : ''}`}
              >
                {STATUS_LABELS[filter] ?? filter}
              </button>
            ))}
          </div>
        }
      />

      {/* ------------------------------------------------------------ controls */}
      {/* One quiet strip rather than a titled panel: four labelled controls need
          no heading to explain that they filter. */}
      <Panel bodyClassName="p-3.5">
        <div className="flex flex-wrap items-end gap-3">
          <div className="min-w-[9rem] flex-1">
            <Field label="KPI">
              <select
                className="field"
                value={kpiFilter}
                onChange={(event) => setKpiFilter(event.target.value)}
              >
                <option value={ALL}>All KPIs</option>
                {kpiOptions.map((option) => (
                  <option key={option.kpi_key} value={option.kpi_key}>
                    {formatKpiName(option.kpi_name)}
                  </option>
                ))}
              </select>
            </Field>
          </div>

          <div className="min-w-[9rem] flex-1">
            <Field label="Date">
              <select
                className="field"
                value={dateFilter}
                onChange={(event) => setDateFilter(event.target.value)}
              >
                <option value={ALL}>All dates</option>
                {dateOptions.map((value) => (
                  <option key={value} value={value}>
                    {formatDate(value)}
                  </option>
                ))}
              </select>
            </Field>
          </div>

          {dimensionOptions.length > 0 ? (
            <div className="min-w-[9rem] flex-1">
              <Field label="Dimension">
                <select
                  className="field"
                  value={dimensionFilter}
                  onChange={(event) => setDimensionFilter(event.target.value)}
                >
                  {/* The guidance sits in the option itself, so the control needs
                      no caption underneath it. */}
                  <option value={ALL}>Any area with a note</option>
                  {dimensionOptions.map((value) => (
                    <option key={value} value={value}>
                      {formatKpiName(value)}
                    </option>
                  ))}
                </select>
              </Field>
            </div>
          ) : null}

          <div className="min-w-[12rem] flex-[1.4]">
            <Field label="Search">
              <input
                className="field"
                type="search"
                value={query}
                onChange={(event) => setQuery(event.target.value)}
                placeholder="KPI, status, date or summary"
              />
            </Field>
          </div>

          {filtered && (
            <button type="button" className="btn btn-xs btn-ghost" onClick={clearFilters}>
              Clear filters
            </button>
          )}
        </div>
      </Panel>

      {/* --------------------------------------------------------- the verdicts */}
      <div className="grid gap-3 sm:grid-cols-3">
        <StatCard
          label="Abnormal"
          value={tally.abnormal}
          caption="Moved outside the range its history supports"
          tone={tally.abnormal > 0 ? 'bad' : 'muted'}
        />
        <StatCard
          label="Low confidence"
          value={tally.lowConfidence}
          caption="Too little comparable history to judge"
          tone={tally.lowConfidence > 0 ? 'warn' : 'muted'}
        />
        <StatCard
          label="Normal"
          value={tally.normal}
          caption="In line with comparable days"
          tone={tally.normal > 0 ? 'good' : 'muted'}
        />
      </div>

      {/* -------------------------------------------------------------- results */}
      <Panel
        title="Stored results"
        bodyClassName="p-0"
        actions={
          <span className="flex items-center gap-2 text-[11px] text-slate-500">
            {history.loading && <span className="text-slate-500">Updating…</span>}
            <span className="tabular-nums">{countLine}</span>
          </span>
        }
      >
        {items.length === 0 ? (
          <EmptyState
            title={filtered ? 'Nothing matches this view' : 'No results stored yet'}
            description={
              filtered
                ? 'Clear the filters to see every stored result for this company.'
                : 'Run the agent for a date and its verdicts will be listed here.'
            }
            action={
              filtered ? (
                <button type="button" className="btn btn-xs btn-ghost" onClick={clearFilters}>
                  Clear filters
                </button>
              ) : undefined
            }
          />
        ) : (
          <div className="overflow-x-auto">
            <table className="min-w-full border-separate border-spacing-0">
              <thead>
                <tr>
                  <th className="table-head">KPI</th>
                  <th className="table-head">Date</th>
                  <th className="table-head text-right">Actual</th>
                  <th className="table-head text-right">Expected</th>
                  <th className="table-head text-right">Movement</th>
                  <th className="table-head">Verdict</th>
                  <th className="table-head">Summary</th>
                </tr>
              </thead>
              <tbody>
                {items.map((item) => {
                  const subtitle = subtitleFor(item)
                  const areas = item.dimensions ?? []
                  const name = formatKpiName(item.kpi_name)
                  return (
                    // The row is the way into the result. Each row's id is the
                    // detection run id, so the Result page can read the same stored
                    // evaluation back — including the evidence behind its verdict,
                    // which no table cell has room for.
                    <tr
                      key={item.id}
                      onClick={() => navigate(`/results/${item.id}`)}
                      className="group cursor-pointer border-b border-ink-800/70 align-top transition-colors last:border-0 hover:bg-white/55"
                    >
                      <td className="table-cell min-w-[12rem] py-2.5">
                        <div className="text-[13.5px] font-semibold leading-snug text-slate-100">
                          {name}
                        </div>
                        {subtitle && (
                          <div className="mt-0.5 text-[11px] text-slate-500">{subtitle}</div>
                        )}
                        {areas.length > 0 && (
                          <div className="mt-1.5 flex flex-wrap gap-1">
                            {areas.map((value) => (
                              <span key={value} className="chip">
                                {formatKpiName(value)}
                              </span>
                            ))}
                          </div>
                        )}
                      </td>
                      <td className="table-cell py-2.5 text-[13px] text-slate-400">
                        {formatDate(item.target_date)}
                      </td>
                      <td className="table-cell py-2.5 text-right font-semibold tabular-nums text-slate-100">
                        {formatValue(item, item.actual_value)}
                      </td>
                      <td className="table-cell py-2.5 text-right tabular-nums text-slate-400">
                        {formatValue(item, item.expected_value)}
                      </td>
                      <td className="table-cell py-2.5 text-right">
                        {/* Neutral by design: the sign says which way it moved, the
                            verdict beside it says whether that matters. */}
                        <div className="font-semibold tabular-nums text-slate-200">
                          {formatDeviation(item)}
                        </div>
                        <div className="mt-0.5 text-[11px] tabular-nums text-slate-500">
                          {formatValue(item, item.deviation_absolute)}
                        </div>
                      </td>
                      <td className="table-cell py-2.5">
                        <StatusBadge status={item.status} />
                      </td>
                      <td className="table-cell w-full min-w-[16rem] max-w-[28rem] whitespace-normal py-2.5">
                        <div className="flex items-start justify-between gap-2">
                          <p className="line-clamp-2 text-[12.5px] leading-relaxed text-slate-400">
                            {summaryText(item) ?? 'No summary stored for this run.'}
                          </p>
                          {/* Keyboard and screen-reader route into the row, which a
                              click handler alone does not provide. */}
                          <button
                            type="button"
                            data-bare
                            aria-label={`Open ${name} for ${formatDate(item.target_date)}`}
                            onClick={(event) => {
                              event.stopPropagation()
                              navigate(`/results/${item.id}`)
                            }}
                            className="shrink-0 rounded-lg px-1.5 text-slate-500 opacity-60 transition group-hover:text-slate-200 group-hover:opacity-100"
                          >
                            →
                          </button>
                        </div>
                      </td>
                    </tr>
                  )
                })}
              </tbody>
            </table>
          </div>
        )}
      </Panel>
    </div>
  )
}
