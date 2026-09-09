/**
 * The Result page as a business reader meets it.
 *
 * `results-recommendations.test.tsx` pins what the advice may *say*. This module
 * pins what the page may put in front of someone before they have asked for it,
 * because the failure it guards against is not a wrong figure — every figure here
 * is the server's — but a correct page nobody can read in the ten seconds they have.
 *
 * Four properties:
 *
 * 1. **The primary view answers four questions and stops.** What happened, the key
 *    finding, the recommended action, and the reader's own response. The robust
 *    median, the dispersion, the modified z-score, the materiality tolerance, the
 *    KPI version, the query count and the evaluation time are all still on the page
 *    — behind one disclosure — and the test asserts both halves of that: absent
 *    from the primary view, present in the document. A page that *deleted* them
 *    would leave an explanation whose basis nobody can check, which is a worse
 *    failure than a cluttered one.
 * 2. **The key finding names the area, in at most three lines, and never claims a
 *    cause.** "Accounts for" is the only verb the evidence supports.
 * 3. **Nothing is analysed on load.** Naming the area behind a movement queries the
 *    company's own data, so it happens when someone asks and not before — which is
 *    also why the page names no part of the business until then.
 * 4. **A reader without investigation access is told why, not shown a dead control.**
 *
 * The fixture's `deviation_pct` is deliberately inconsistent with its own actual and
 * expected, so "printed the server's field" stays distinguishable from "recomputed
 * it in the browser".
 */

import { act, cleanup, render, screen, waitFor } from '@testing-library/react'
import { MemoryRouter, Route, Routes } from 'react-router-dom'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { AuthProvider } from './auth/AuthContext'
import { formatCurrency } from './components/format'
import ResultDetail from './pages/ResultDetail'

/** The page's own money formatter, so the assertions cannot drift from it. */
function money(value: number): string {
  return formatCurrency(value, 'INR', true)
}

const USER = {
  id: 'user-1',
  email: 'ana@aurora-retail.example.com',
  full_name: 'Ana Analyst',
  is_active: true,
  is_platform_admin: false,
  created_at: '2026-01-01T00:00:00Z',
}

function membership(permissions: string[]) {
  return {
    company_id: 'company-1',
    company_name: 'Aurora Retail',
    company_slug: 'aurora-retail',
    role_key: permissions.includes('investigation.read') ? 'ANALYST' : 'VIEWER',
    role_name: 'Reader',
    status: 'ACTIVE',
    is_admin_role: false,
    permissions,
  }
}

/** The stored evaluation, with the full technical record attached. */
const RUN = {
  result: {
    kpi: 'net_revenue',
    kpi_key: 'revenue',
    target_date: '2026-08-28',
    actual: 35_000_000,
    expected: 50_000_000,
    // See the file docstring: not derivable from the two figures above.
    deviation_pct: -29.4,
    deviation_absolute: -15_000_000,
    status: 'ABNORMAL',
    comparison: 'Comparable Fridays',
    headline: 'Net Revenue is 29.4% below its comparable Fridays.',
    unit: 'currency',
    currency: 'INR',
  },
  run_id: 'run-1',
  executed_at: '2026-08-29T04:15:00Z',
  evidence: {
    kpi_version: 4,
    kpi_version_id: 'kpiver-1',
    bucket: {
      applied: 'SAME_DAY_OF_WEEK',
      all_applied: ['SAME_DAY_OF_WEEK'],
      decisions: [
        {
          bucket: 'SAME_DAY_OF_WEEK',
          role: 'PRIMARY',
          reference_count: 12,
          note: 'Twelve comparable Fridays were available.',
        },
      ],
      config_key: 'retail-weekly',
      config_version: 2,
    },
    reference: {
      count: 12,
      points: [
        { date: '2026-08-21', value: 49_500_000 },
        { date: '2026-08-14', value: 50_400_000 },
      ],
    },
    statistics: {
      median: 50_000_000,
      mad: 1_200_000,
      dispersion: 1_779_000,
      dispersion_basis: 'MAD',
      modified_z_score: -9.81,
      z_threshold: 3.5,
      z_threshold_note: 'Threshold from the approved detection profile.',
      statistically_significant: true,
    },
    tolerance: {
      relative_pct: 5,
      absolute: null,
      breached: true,
      relative_floor_pct: 2,
      movement_is_material: true,
    },
    year_over_year: { applied: false, factor: null },
    method: 'robust_median',
    reason: 'Modified z-score beyond threshold and tolerance breached.',
    notes: ['One comparable Friday was a public holiday and was excluded.'],
    query_count: 3,
    duration_ms: 412,
  },
}

const CONTRIBUTION = {
  result: {
    kpi: 'net_revenue',
    kpi_key: 'revenue',
    target_date: '2026-08-28',
    dimension: 'region',
    path: [],
    actual: 35_000_000,
    expected: 50_000_000,
    movement: -15_000_000,
    movement_pct: -29.4,
    status: 'ABNORMAL',
    comparison: 'Comparable Fridays',
    unit: 'currency',
    currency: 'INR',
    contributors: [
      {
        entity: 'North',
        label: 'North',
        actual: 12_000_000,
        expected: 21_000_000,
        change: -9_000_000,
        share_pct: -60,
        absolute_share_pct: 60,
        reference_count: 12,
        matched_rows: 40,
        note: null,
      },
      {
        entity: 'South',
        label: 'South',
        actual: 8_000_000,
        expected: 11_000_000,
        change: -3_000_000,
        share_pct: -20,
        absolute_share_pct: 20,
        reference_count: 12,
        matched_rows: 38,
        note: null,
      },
      {
        entity: 'West',
        label: 'West',
        actual: 6_000_000,
        expected: 7_000_000,
        change: -1_000_000,
        share_pct: -6.7,
        absolute_share_pct: 6.7,
        reference_count: 12,
        matched_rows: 30,
        note: null,
      },
    ],
    top_k: 8,
    ranked_count: 4,
    explained_pct: 86.7,
    unexplained_pct: 13.3,
    leader_is_sufficient: false,
    sufficiency_pct: 70,
    shares_available: true,
    next_dimensions: ['city'],
    notes: [],
  },
  evidence: {
    kpi_version: 4,
    kpi_version_id: 'kpiver-1',
    detection_run_id: 'detrun-1',
    contribution_run_id: 'contrun-1',
    dimension: 'region',
    additive: true,
    reference_dates: ['2026-08-21'],
    withheld_by_scope: 0,
    queries: ['SELECT region, SUM(net_revenue) FROM orders GROUP BY region'],
  },
}

/** The recommendation set, reduced to what this module needs it to render. */
const RECOMMENDATIONS = {
  result: {
    kpi: 'net_revenue',
    kpi_key: 'revenue',
    target_date: '2026-08-28',
    verdict: 'ABNORMAL',
    stance: 'ACTION',
    movement_direction: 'ADVERSE',
    headline: 'Net Revenue moved below the level its comparable Fridays support.',
    body: 'These suggestions are aimed at the KPI as a whole until a breakdown is stored.',
    confidence: { level: 'MEDIUM', reasons: ['No stored breakdown narrows this movement yet.'] },
    evidence_summary: {
      verdict: 'ABNORMAL',
      actual: 35_000_000,
      expected: 50_000_000,
      deviation_absolute: -15_000_000,
      deviation_pct: -29.4,
      unit: 'currency',
      currency: 'INR',
      comparison: 'same_day_of_week',
      reference_count: 12,
      top_contributor: null,
      top_contributor_chain: null,
      top_contributor_share_pct: null,
      breakdown_dimension: null,
    },
    target_area: null,
    recommendations: [] as unknown[],
    next_steps: [] as string[],
    monitoring: { metrics: ['Net Revenue against its comparable periods'], window: 'Next 3' },
    limitations: ['Contribution alone does not establish causation.'],
    awaiting_breakdown: true,
    causation_note: 'Contribution alone does not establish causation.',
    action_preamble: 'Based on this evidence, the following actions are recommended for review.',
    executive: {
      what_happened: 'Net Revenue moved below the level its comparable Fridays support.',
      largest_contributor: null,
      largest_contributor_share: null,
      top_action: null,
      owner: null,
      impact: null,
      confidence: 'MEDIUM',
    },
  },
  run_id: 'run-1',
  feedback: [] as unknown[],
  feedback_options: {
    usefulness: ['USEFUL', 'NOT_USEFUL', 'NEEDS_REVIEW'],
    action_status: ['NOT_STARTED', 'IN_REVIEW', 'ACTION_TAKEN'],
  },
  may_submit_feedback: true,
}

function jsonResponse(body: unknown, status = 200) {
  return { ok: status < 400, status, text: async () => JSON.stringify(body) } as Response
}

let contributionPosts: unknown[]

function setUp(permissions: string[]) {
  contributionPosts = []
  localStorage.clear()
  localStorage.setItem(
    'bi.ai.session',
    JSON.stringify({ token: 'session-token', expiresAt: '2099-01-01T00:00:00Z' }),
  )
  localStorage.setItem('bi.ai.company', 'company-1')
  vi.stubGlobal(
    'fetch',
    vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input)
      if (url.endsWith('/auth/session')) {
        return jsonResponse({ user: USER, memberships: [membership(permissions)] })
      }
      if (url.includes('/recommendation-feedback')) return jsonResponse({})
      if (url.includes('/recommendations')) return jsonResponse(RECOMMENDATIONS)
      if (url.includes('/investigation/contribution')) {
        contributionPosts.push(url)
        return jsonResponse(CONTRIBUTION)
      }
      if (url.includes('/investigation/findings')) {
        return jsonResponse({ findings: [], statuses: ['OPEN', 'RESOLVED'] })
      }
      if (url.includes('/detection-runs/run-1')) return jsonResponse(RUN)
      return jsonResponse({})
    }),
  )
}

async function renderResult() {
  const view = render(
    <MemoryRouter initialEntries={['/results/run-1']}>
      <AuthProvider>
        <Routes>
          <Route path="/results/:runId" element={<ResultDetail />} />
        </Routes>
      </AuthProvider>
    </MemoryRouter>,
  )
  await screen.findByText('What happened')
  return view
}

function bodyText(): string {
  return document.body.textContent ?? ''
}

/**
 * What a reader sees before opening anything.
 *
 * A `<details>` keeps its children in the document whether or not it is open, so
 * "not in the primary view" has to be asked of a copy with the disclosures removed
 * rather than of the document itself.
 */
function primaryText(): string {
  const clone = document.body.cloneNode(true) as HTMLElement
  clone.querySelectorAll('details').forEach((node) => node.remove())
  return clone.textContent ?? ''
}

async function findBreakdown() {
  const button = await screen.findByRole('button', { name: /find what drove this/i })
  await act(async () => {
    button.click()
  })
  await waitFor(() => expect(contributionPosts).toHaveLength(1))
}

afterEach(() => {
  cleanup()
  vi.unstubAllGlobals()
})

describe('the Result page, opened by a business reader', () => {
  it('answers what happened without putting the statistics in front of it', async () => {
    setUp(['analytics.read', 'kpi.read', 'investigation.read'])
    await renderResult()

    // The four figures, in the KPI's own currency, and the server's own deviation.
    expect(primaryText()).toContain(money(35_000_000))
    expect(primaryText()).toContain(money(50_000_000))
    expect(primaryText()).toContain('-29.4%')
    expect(primaryText()).toContain('Comparable Fridays')
    await screen.findByText(new RegExp(`Came in at ${money(35_000_000)}`))
    // A verdict in words, not the raw statistical claim. Said in the disclosure
    // too, beside the two tests that produced it, hence `primaryText` rather than
    // a document-wide query.
    expect(primaryText()).toContain('A bigger move than this KPI usually makes.')

    // None of the method reaches the primary view…
    const buried = [
      'z-score',
      'Robust median',
      'Dispersion',
      'Materiality',
      'KPI version',
      'Source queries',
      'Evaluation time',
      'Statistical test',
      '9.81',
      'robust_median',
      'GROUP BY',
    ]
    for (const term of buried) {
      expect(primaryText()).not.toContain(term)
    }
    // …and all of it is still on the page, one disclosure away.
    for (const term of buried.filter((term) => term !== 'GROUP BY')) {
      expect(bodyText()).toContain(term)
    }
    expect(bodyText()).toContain('Evidence & details')
    expect(bodyText()).toContain('One comparable Friday was a public holiday')
  })

  it('names no part of the business until somebody asks, and asks nothing on load', async () => {
    setUp(['analytics.read', 'kpi.read', 'investigation.read'])
    await renderResult()

    await screen.findByText('Key finding')
    expect(contributionPosts).toHaveLength(0)
    expect(bodyText()).not.toContain('North')
    await screen.findByText(/No part of the business is named yet/)
  })

  it('names the largest areas in at most three lines, and claims no cause', async () => {
    setUp(['analytics.read', 'kpi.read', 'investigation.read'])
    await renderResult()
    await findBreakdown()

    // Line one names the leader with its share and its movement; line two the
    // runner-up; line three how much the listed parts cover between them.
    await screen.findByText(`North accounts for 60.0% of the movement (${money(-9_000_000)}).`)
    await screen.findByText('Next largest: South, 20.0%.')
    await screen.findByText('The 3 shown of 4 cover 86.7% of it between them.')
    // The fourth region is in the full ranking, not in the finding.
    expect(primaryText()).not.toContain('West')
    expect(bodyText()).toContain('West')

    const lowered = primaryText().toLowerCase()
    for (const claim of ['caused by', 'because of', 'due to', 'north is responsible']) {
      expect(lowered).not.toContain(claim)
    }
    expect(primaryText()).toContain('A share of a movement is a size, not a proven cause.')
  })

  it('tells a reader without investigation access why, rather than offering a dead control', async () => {
    setUp(['analytics.read', 'kpi.read'])
    await renderResult()

    await screen.findByText('Key finding')
    expect(screen.queryByRole('button', { name: /find what drove this/i })).toBeNull()
    await screen.findByText(/needs investigation access/)
    expect(contributionPosts).toHaveLength(0)
  })

  /**
   * The hand-off to the investigation screen, in the address bar rather than in
   * router state.
   *
   * A reader who follows this control and then reloads — or bookmarks it, or sends
   * it to whoever owns the region — has to arrive at the same movement. Carried as
   * navigation state it would survive the click and not the refresh, and the second
   * reader would open an empty workspace and pick a KPI and a date by hand.
   */
  it('hands the movement to the investigation screen in the URL, so a refresh keeps it', async () => {
    setUp(['analytics.read', 'kpi.read', 'investigation.read'])
    await renderResult()

    const link = await screen.findByRole('link', { name: /investigate this movement/i })
    // The KPI's stored business key, not its display name, and the run's own date.
    expect(link.getAttribute('href')).toBe('/investigation?kpi=revenue&date=2026-08-28')
  })
})
