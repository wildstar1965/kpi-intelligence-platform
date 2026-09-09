/**
 * What the two decision screens tell the Copilot about themselves.
 *
 * The Copilot drawer opens on top of whatever page the reader is on, and the whole
 * design rests on the reader never retyping where they are: the screen publishes
 * its coordinates, the server re-resolves every one of them inside the caller's own
 * company, and the answer is anchored to the same movement the page is showing.
 *
 * That makes an under-published screen a specific, invisible defect. Nothing breaks
 * — the panel still answers — but it answers about a KPI without knowing which
 * version defines it, or about a movement without knowing the breakdown on screen,
 * and the server's stored-breakdown lookup silently widens to whichever analysis was
 * most recent. So this module asserts the coordinates leave the page, one by one.
 *
 * Two properties, and the second is the one worth having:
 *
 * 1. **Every coordinate the screen knows is published, and no figure is.** The
 *    actual, the expected value and the deviation are all rendered on these pages
 *    and none of them may appear in the request context — the server re-reads them
 *    from the run it stored, which is what stops a screen from telling the assistant
 *    a number.
 * 2. **The dimension appears only once a breakdown exists.** Publishing one before
 *    the analysis has run would narrow the server's lookup to a breakdown that is
 *    not there, turning "here are the shares" into "no breakdown is stored".
 *
 * The probe reads the assembled `requestContext` rather than the screen object,
 * because that is the shape that actually goes over the wire.
 */

import { act, cleanup, render, screen as domScreen, waitFor } from '@testing-library/react'
import { MemoryRouter, Route, Routes } from 'react-router-dom'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { AuthProvider } from './auth/AuthContext'
import { CopilotProvider, useCopilot } from './copilot/CopilotProvider'
import ResultDetail from './pages/ResultDetail'

const USER = {
  id: 'user-1',
  email: 'ana@aurora-retail.example.com',
  full_name: 'Ana Analyst',
  is_active: true,
  is_platform_admin: false,
  created_at: '2026-01-01T00:00:00Z',
}

const MEMBERSHIP = {
  company_id: 'company-1',
  company_name: 'Aurora Retail',
  company_slug: 'aurora-retail',
  role_key: 'ANALYST',
  role_name: 'Analyst',
  status: 'ACTIVE',
  is_admin_role: false,
  permissions: ['analytics.read', 'kpi.read', 'investigation.read'],
}

/** The stored evaluation. Its figures exist so the test can prove they stay put. */
const RUN = {
  result: {
    kpi: 'net_revenue',
    kpi_key: 'revenue',
    target_date: '2026-08-28',
    actual: 35_000_000,
    expected: 50_000_000,
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
      decisions: [],
      config_key: 'retail-weekly',
      config_version: 2,
    },
    reference: { count: 12, points: [] },
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
    notes: [],
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
    ],
    top_k: 8,
    ranked_count: 1,
    explained_pct: 60,
    unexplained_pct: 40,
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
    queries: [],
  },
}

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
    confidence: { level: 'MEDIUM', reasons: [] },
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
    monitoring: { metrics: [], window: 'Next 3' },
    limitations: [],
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
  feedback_options: { usefulness: ['USEFUL'], action_status: ['NOT_STARTED'] },
  may_submit_feedback: true,
}

function jsonResponse(body: unknown, status = 200) {
  return { ok: status < 400, status, text: async () => JSON.stringify(body) } as Response
}

function setUp() {
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
        return jsonResponse({ user: USER, memberships: [MEMBERSHIP] })
      }
      if (url.includes('/copilot/status')) {
        return jsonResponse({ enabled: false, available: false, provider: 'none' })
      }
      if (url.includes('/recommendations')) return jsonResponse(RECOMMENDATIONS)
      if (url.includes('/investigation/contribution')) return jsonResponse(CONTRIBUTION)
      if (url.includes('/investigation/findings')) {
        return jsonResponse({ findings: [], statuses: ['OPEN'] })
      }
      if (url.includes('/detection-runs/run-1')) return jsonResponse(RUN)
      return jsonResponse({})
    }),
  )
}

/** Renders the request context the provider would send, so a test can read it. */
function ContextProbe() {
  const { requestContext } = useCopilot()
  return <pre data-testid="request-context">{JSON.stringify(requestContext)}</pre>
}

function published(): Record<string, unknown> {
  const node = domScreen.getByTestId('request-context')
  return JSON.parse(node.textContent ?? '{}') as Record<string, unknown>
}

afterEach(() => {
  cleanup()
  vi.unstubAllGlobals()
})

describe('the Result page as the Copilot sees it', () => {
  it('publishes the KPI, its version and the date — and not one figure', async () => {
    setUp()
    render(
      <MemoryRouter initialEntries={['/results/run-1']}>
        <AuthProvider>
          <CopilotProvider>
            <ContextProbe />
            <Routes>
              <Route path="/results/:runId" element={<ResultDetail />} />
            </Routes>
          </CopilotProvider>
        </AuthProvider>
      </MemoryRouter>,
    )
    await domScreen.findByText('What happened')

    await waitFor(() => expect(published().kpi_id).toBe('revenue'))
    const context = published()
    expect(context.panel).toBe('kpi_result')
    expect(context.kpi_version).toBe(4)
    expect(context.selected_date).toBe('2026-08-28')
    expect(context.page).toBe('results/run-1')

    // Nothing measured leaves the page. Checked against the serialised form so a
    // figure smuggled in under any key name fails this, not only a known one.
    const wire = JSON.stringify(context)
    for (const figure of ['35000000', '50000000', '29.4', '15000000', 'ABNORMAL']) {
      expect(wire).not.toContain(figure)
    }
  })

  it('names no dimension until a breakdown has actually been run', async () => {
    setUp()
    render(
      <MemoryRouter initialEntries={['/results/run-1']}>
        <AuthProvider>
          <CopilotProvider>
            <ContextProbe />
            <Routes>
              <Route path="/results/:runId" element={<ResultDetail />} />
            </Routes>
          </CopilotProvider>
        </AuthProvider>
      </MemoryRouter>,
    )
    await domScreen.findByText('What happened')
    await waitFor(() => expect(published().kpi_id).toBe('revenue'))

    // Before: there is no breakdown, so there is no dimension to answer about.
    expect(published().dimension).toBeNull()

    const button = await domScreen.findByRole('button', { name: /find what drove this/i })
    await act(async () => {
      button.click()
    })

    // After: the dimension the server chose for this movement, so its stored
    // breakdown lookup lands on the analysis the reader is looking at.
    await waitFor(() => expect(published().dimension).toBe('region'))
    // Still no figures, and still no entity — this page ranks parts of the
    // business without selecting one.
    expect(published().selected_entity).toBeNull()
    expect(JSON.stringify(published())).not.toContain('9000000')
  })
})
