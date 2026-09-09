/**
 * The guided descent, three levels deep: KPI -> Region -> Sector -> Product.
 *
 * `investigation-business-view.test.tsx` pins what a breakdown may *say*. This
 * module pins where a breakdown may *go*, because the two failure modes are
 * different and only the second one puts unrelated parts of a business on screen.
 *
 * Three rules, each with its own test:
 *
 * 1. **Every step carries its ancestors.** The request for the third level must
 *    name both the region and the sector already chosen. A step that dropped an
 *    ancestor would return the sector's company-wide products under one region --
 *    a wrong figure that looks entirely plausible.
 * 2. **The next level comes from the level on screen.** Each response declares
 *    what may be descended into next; the button's label and the dimension it
 *    sends both come from that declaration, so a screen showing sectors cannot
 *    offer to break down by anything but products.
 * 3. **A manual ranking is not a descent.** The manual entry point has no path,
 *    so a row on it must not offer a drill at all -- rather than offer one
 *    labelled from whatever the *other* mode last looked at, which is what
 *    produced a request for the wrong coordinates entirely.
 *
 * The stub answers on coordinates alone. It is keyed by `dimension` plus the
 * `path` the client sent, and it has no entry for a mismatched pair, so a request
 * with a dropped ancestor fails by finding nothing rather than by an assertion
 * written after the fact.
 */

import { act, cleanup, render, screen, waitFor } from '@testing-library/react'
import { MemoryRouter } from 'react-router-dom'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { AuthProvider } from './auth/AuthContext'
import Investigation from './pages/Investigation'

const USER = {
  id: 'user-1',
  email: 'admin@aurora-retail.example.com',
  full_name: 'Ada Admin',
  is_active: true,
  is_platform_admin: false,
  created_at: '2026-01-01T00:00:00Z',
}

const MEMBERSHIP = {
  company_id: 'company-1',
  company_name: 'Aurora Retail',
  company_slug: 'aurora-retail',
  role_key: 'ADMIN',
  role_name: 'Administrator',
  status: 'ACTIVE',
  is_admin_role: true,
  permissions: ['analytics.read', 'investigation.read', 'kpi.read'],
}

const CONTRACTS = {
  company_id: 'company-1',
  count: 2,
  contracts: [
    {
      kpi_id: 'revenue',
      kpi_definition_id: 'kpidef-1',
      kpi_version_id: 'kpiver-1',
      name: 'Revenue',
      version: 1,
      status: 'ACTIVE',
      business_definition: 'Net revenue recognised on the order date.',
      kind: 'MEASURE',
      formula: 'SUM(orders.net_revenue)',
      formula_spec: {},
      filters: [],
      is_additive: true,
      additivity_note: 'Parts sum to the whole.',
      unit: 'currency',
      currency: 'INR',
      direction: 'HIGHER_IS_BETTER',
      time_field: 'order_date',
      time_grain: 'DAY',
      source: {},
      dimensions: [],
    },
    // A second KPI, deliberately *not* first in the registry, so "opened the KPI
    // the link named" stays distinguishable from "opened whatever was at the top".
    {
      kpi_id: 'orders',
      kpi_definition_id: 'kpidef-2',
      kpi_version_id: 'kpiver-2',
      name: 'Orders',
      version: 1,
      status: 'ACTIVE',
      business_definition: 'Orders placed on the order date.',
      kind: 'MEASURE',
      formula: 'COUNT(orders.id)',
      formula_spec: {},
      filters: [],
      is_additive: true,
      additivity_note: 'Parts sum to the whole.',
      unit: 'count',
      currency: null,
      direction: 'HIGHER_IS_BETTER',
      time_field: 'order_date',
      time_grain: 'DAY',
      source: {},
      dimensions: [],
    },
  ],
}

/** The three-level hierarchy the demo schema declares, as the server sends it. */
const DIMENSIONS = {
  kpi_key: 'revenue',
  kpi_name: 'Revenue',
  kpi_version: 1,
  dimensions: [
    { name: 'region', is_default: true, hierarchy: ['sector'], approx_cardinality: 4, notes: null },
    { name: 'sector', is_default: false, hierarchy: ['product'], approx_cardinality: 6, notes: null },
    { name: 'product', is_default: false, hierarchy: [], approx_cardinality: 40, notes: null },
    { name: 'channel', is_default: false, hierarchy: [], approx_cardinality: 3, notes: null },
  ],
}

const EVIDENCE = {
  kpi_version: 1,
  kpi_version_id: 'kpiver-1',
  detection_run_id: 'detrun-1',
  contribution_run_id: 'contrun-1',
  dimension: 'region',
  additive: true,
  reference_dates: ['2026-08-14', '2026-08-21'],
  withheld_by_scope: 0,
  queries: ['SELECT region, SUM(net_revenue) FROM orders GROUP BY region'],
}

function part(label: string, change: number, sharePct: number) {
  return {
    entity: label,
    label,
    actual: 1_000_000,
    expected: 1_000_000 - change,
    change,
    share_pct: sharePct,
    absolute_share_pct: Math.abs(sharePct),
    reference_count: 12,
    matched_rows: 40,
    note: null,
  }
}

/** The whole every level is measured against, unchanged by how deep we are. */
const WHOLE = {
  kpi: 'Revenue',
  kpi_key: 'revenue',
  target_date: '2026-08-28',
  actual: 35_000_000,
  expected: 50_000_000,
  movement: -15_000_000,
  movement_pct: -30,
  status: 'ABNORMAL',
  comparison: 'Comparable Fridays',
  unit: 'currency',
  currency: 'INR',
  top_k: 10,
  explained_pct: 100,
  unexplained_pct: 0,
  leader_is_sufficient: false,
  sufficiency_pct: 70,
  shares_available: true,
  notes: [],
}

/**
 * One level of the descent, keyed by the coordinates that reach it.
 *
 * `North / Electronics` holds products that belong to that pair and to no other,
 * which is what makes the third assertion below a statement about narrowing
 * rather than about rendering.
 */
const LEVELS: Record<string, { dimension: string; next: string[]; parts: string[] }> = {
  '|region': { dimension: 'region', next: ['sector'], parts: ['North', 'South'] },
  'region=North|sector': {
    dimension: 'sector',
    next: ['product'],
    parts: ['Electronics', 'Grocery'],
  },
  'region=North>sector=Electronics|product': {
    dimension: 'product',
    next: [],
    parts: ['Widget A', 'Widget B'],
  },
}

function levelKey(path: Array<{ dimension: string; value: string }>, dimension: string | null) {
  return `${path.map((step) => `${step.dimension}=${step.value}`).join('>')}|${dimension ?? 'region'}`
}

function jsonResponse(body: unknown, status = 200) {
  return { ok: status < 400, status, text: async () => JSON.stringify(body) } as Response
}

let contributionCalls: any[]

function stubFetch() {
  return vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input)
    if (url.endsWith('/auth/session')) {
      return jsonResponse({ user: USER, memberships: [MEMBERSHIP] })
    }
    if (url.includes('/kpi-contracts')) return jsonResponse(CONTRACTS)
    if (url.includes('/investigation/dimensions')) return jsonResponse(DIMENSIONS)
    if (url.includes('/investigation/entities')) {
      return jsonResponse({
        kpi_key: 'revenue',
        kpi_name: 'Revenue',
        kpi_version: 1,
        target_date: '2026-08-28',
        run_available: true,
        run_state: 'COMPLETED',
        kpi_status: 'ABNORMAL',
        message: null,
        dimensions: DIMENSIONS.dimensions,
        dimension: 'region',
        next_dimensions: ['sector'],
        entities: [
          { entity: 'North', label: 'North', value: 21_000_000, share_of_total_pct: 60, matched_rows: 40 },
        ],
      })
    }
    if (url.includes('/investigation/contribution') || url.includes('/investigation/analysis')) {
      const body = JSON.parse(String(init?.body ?? '{}'))
      const manual = url.includes('/investigation/analysis')
      if (!manual) contributionCalls.push(body)
      const level = LEVELS[levelKey(body.path ?? [], body.dimension)]
      if (!level) {
        // A request nobody can answer. The response is deliberately unhelpful
        // rather than a fallback level, so a dropped ancestor cannot pass.
        return jsonResponse({ message: `no level for ${levelKey(body.path ?? [], body.dimension)}` }, 409)
      }
      const result = {
        ...WHOLE,
        dimension: level.dimension,
        path: body.path ?? [],
        next_dimensions: level.next,
        ranked_count: level.parts.length,
        contributors: level.parts.map((label, index) =>
          part(label, index === 0 ? -9_000_000 : -6_000_000, index === 0 ? -60 : -40),
        ),
      }
      const payload = { result, evidence: { ...EVIDENCE, dimension: level.dimension } }
      return jsonResponse(manual ? { mode: 'contribution', ...payload } : payload)
    }
    return jsonResponse({})
  })
}

async function openInvestigation() {
  render(
    <MemoryRouter initialEntries={['/investigation']}>
      <AuthProvider>
        <Investigation />
      </AuthProvider>
    </MemoryRouter>,
  )
  await screen.findByText('Investigation')
  await screen.findByRole('option', { name: /Revenue/ })
}

async function pressButton(name: RegExp, index = 0) {
  const buttons = await screen.findAllByRole('button', { name })
  await act(async () => {
    buttons[index].click()
  })
}

/** Start the descent: the KPI broken down by its default dimension. */
async function startDescent() {
  const button = (await screen.findByRole('button', {
    name: /explain the movement/i,
  })) as HTMLButtonElement
  await waitFor(() => expect(button.disabled).toBe(false))
  await act(async () => {
    button.click()
  })
  await waitFor(() => expect(contributionCalls).toHaveLength(1))
  await screen.findByText('North')
}

beforeEach(() => {
  contributionCalls = []
  localStorage.clear()
  localStorage.setItem(
    'bi.ai.session',
    JSON.stringify({ token: 'session-token', expiresAt: '2099-01-01T00:00:00Z' }),
  )
  localStorage.setItem('bi.ai.company', 'company-1')
  vi.stubGlobal('fetch', stubFetch())
})

afterEach(() => {
  cleanup()
  vi.unstubAllGlobals()
})

describe('the guided descent', () => {
  it('goes KPI to region to sector to product, carrying every ancestor', async () => {
    await openInvestigation()
    await startDescent()

    // Level 1 -> 2. The offer comes from the response, which declared `sector`.
    await pressButton(/sector/i)
    await waitFor(() => expect(contributionCalls).toHaveLength(2))
    expect(contributionCalls[1].dimension).toBe('sector')
    expect(contributionCalls[1].path).toEqual([{ dimension: 'region', value: 'North' }])
    await screen.findByText('Electronics')

    // Level 2 -> 3. Both ancestors travel with it; dropping the region here is
    // the mistake that shows a sector's company-wide products under one region.
    await pressButton(/product/i)
    await waitFor(() => expect(contributionCalls).toHaveLength(3))
    expect(contributionCalls[2].dimension).toBe('product')
    expect(contributionCalls[2].path).toEqual([
      { dimension: 'region', value: 'North' },
      { dimension: 'sector', value: 'Electronics' },
    ])

    // And the third level shows the products of that pair and nothing else.
    await screen.findByText('Widget A')
    expect(screen.getByText('Widget B')).toBeTruthy()
    for (const elsewhere of ['South', 'Grocery']) {
      expect(screen.queryByText(elsewhere)).toBeNull()
    }
  })

  it('offers no further step once the level on screen declares none', async () => {
    await openInvestigation()
    await startDescent()
    await pressButton(/sector/i)
    await screen.findByText('Electronics')
    await pressButton(/product/i)
    await screen.findByText('Widget A')

    // `product` declared an empty hierarchy, so there is nothing below it and no
    // button pretending otherwise.
    expect(screen.queryByRole('button', { name: /break down by/i })).toBeNull()
  })

  it('climbs back to a level already analysed without asking the server again', async () => {
    await openInvestigation()
    await startDescent()
    await pressButton(/sector/i)
    await screen.findByText('Electronics')

    const before = contributionCalls.length
    await pressButton(/^All Revenue$/i)
    await screen.findByText('South')
    expect(contributionCalls).toHaveLength(before)
  })

  /**
   * Where the descent starts when a Result hands it a movement.
   *
   * The coordinates travel in the address bar, so the workspace opens on the KPI
   * and the date the reader was already looking at -- and a refresh, a bookmark or
   * a link pasted to whoever owns the region lands on that same movement. The
   * registry's first KPI is only a starting point for someone who arrived with no
   * link at all, which is why this asserts the seeded KPI is selected *and* the
   * first one is not.
   */
  it('opens on the movement a Result handed it, not the first KPI in the registry', async () => {
    render(
      <MemoryRouter initialEntries={['/investigation?kpi=orders&date=2026-08-27']}>
        <AuthProvider>
          <Investigation />
        </AuthProvider>
      </MemoryRouter>,
    )
    await screen.findByText('Investigation')

    const linked = (await screen.findByRole('option', { name: /Orders/ })) as HTMLOptionElement
    const firstInRegistry = (await screen.findByRole('option', {
      name: /Revenue/,
    })) as HTMLOptionElement
    expect(linked.selected).toBe(true)
    expect(firstInRegistry.selected).toBe(false)
    expect(screen.getByDisplayValue('2026-08-27')).toBeTruthy()
  })
})

describe('the manual entry point', () => {
  /**
   * The bug this pins: the drill on a manual ranking used to be wired to the
   * *movement* mode's trail. With movement mode untouched there was no next
   * dimension at all, so the row offered nothing; with movement mode already
   * several levels deep it offered that trail's next step and sent that trail's
   * path -- coordinates belonging to a screen the reader was not looking at.
   */
  it('ranks a dimension without offering a descent it cannot perform', async () => {
    await openInvestigation()
    await pressButton(/manual analysis/i)
    await pressButton(/^run$/i)

    await screen.findAllByText('North')
    // Manual analysis has no ancestors to send, so no row claims to descend.
    expect(screen.queryByRole('button', { name: /break down by/i })).toBeNull()
    expect(contributionCalls).toHaveLength(0)
  })
})
