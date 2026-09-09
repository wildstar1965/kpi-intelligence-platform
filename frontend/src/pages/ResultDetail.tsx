/**
 * The Result page: one stored evaluation, what it means, and what to do next.
 *
 * The primary view answers four questions in order and nothing else — WHAT
 * HAPPENED, KEY FINDING, RECOMMENDED NEXT ACTIONS, and the reader's own response.
 * A business reader should be able to open this page and be done in seconds.
 *
 * Everything that supports those four answers — the full contribution ranking, the
 * statistics the verdict used, the comparable periods, the queries and the engine's
 * own notes — lives behind one disclosure at the foot of the page. That is a change
 * of *placement*, not of availability: no figure was removed, and a reader who has
 * to defend a verdict can still reach every number it was built from. Hiding it
 * outright would leave an explanation whose basis nobody can check; leading with it
 * buried the answer under the method.
 *
 * The discipline of the page is unchanged: every figure on it was written by the
 * detection engine at evaluation time and read back here. Nothing is recomputed in
 * the browser — no median, no z-score, no threshold comparison, no verdict. If a
 * number is on this page, a stored column holds it, and the same page shown
 * tomorrow shows the same answer.
 *
 * Two consequences worth stating, because both are visible:
 *
 *  - **The statistics are permissioned.** The technical record reaches the client
 *    only for a reader holding `kpi.read`; the server attaches it or does not. A
 *    reader without it still gets the verdict, the movement and the comparison
 *    basis in words — and is told plainly that the statistical detail is withheld,
 *    rather than shown an empty panel that looks like missing data.
 *  - **Naming the area behind a movement is a query, so it is a decision.** The
 *    breakdown reads the company's own source for the date, so it runs when someone
 *    asks. Nothing on this page analyses every part of the business on load.
 *
 * The recommendations sit directly after the key finding because that is the order
 * the reasoning runs in: what moved, which part of the business accounts for most
 * of it, and only then what to consider doing. They are derived on read from the
 * same stored rows, so a breakdown run here sharpens them from the KPI as a whole
 * to a named area — which is why `runBreakdown` bumps their refresh token rather
 * than leaving two panels disagreeing about what is known.
 *
 * The explanation is an action on this page rather than a chat window beside it: it
 * explains *this* result, from this result's stored evidence.
 */

import { useCallback, useMemo, useState } from 'react'
import { Link, useNavigate, useParams } from 'react-router-dom'
import { api } from '../api/client'
import type {
  ContributionResponse,
  DetectionEvidence,
  DetectionRunDetail,
  Explanation,
  ExplanationResponse,
  FindingsResponse,
} from '../api/types'
import { useAuth } from '../auth/AuthContext'
import ExplanationCard, { ExplainButton } from '../components/Explanation'
import Recommendations from '../components/Recommendations'
import {
  formatCompact,
  formatCurrency,
  formatDate,
  formatDateTime,
  formatKpiName,
  formatNumber,
  titleCase,
} from '../components/format'
import {
  Alert,
  EmptyState,
  LoadError,
  LoadingState,
  PageHeader,
  Panel,
  StatusBadge,
} from '../components/ui'
import { useAction, useResource } from '../components/useResource'
import { useCopilotScreen } from '../copilot/CopilotProvider'

/** A measurement in the KPI's own unit. The unit is read from the run, never guessed. */
function measure(
  value: number | null | undefined,
  unit?: string | null,
  currency?: string | null,
): string {
  if (value === null || value === undefined) return '—'
  if (currency) return formatCurrency(value, currency, true)
  if (unit === 'currency') return formatCurrency(value, 'INR', true)
  return formatCompact(value)
}

function signed(value: number | null | undefined, digits = 1): string {
  if (value === null || value === undefined || Number.isNaN(value)) return '—'
  return `${value >= 0 ? '+' : ''}${value.toFixed(digits)}%`
}

/**
 * How the movement reads in words.
 *
 * Direction only — "above"/"below" what was expected. Deliberately not "grew" or
 * "improved": whether a rise is good is a judgement about the KPI, and this page
 * does not know which direction is favourable for an arbitrary metric.
 */
function movementSentence(
  actual: number | null,
  expected: number | null,
  absolute: number | null,
  pct: number | null,
  unit?: string | null,
  currency?: string | null,
): string {
  if (actual === null || expected === null || absolute === null) {
    return 'The movement against the expectation was not recorded for this evaluation.'
  }
  if (absolute === 0) {
    return `Came in exactly at the expected ${measure(expected, unit, currency)}.`
  }
  const direction = absolute > 0 ? 'above' : 'below'
  const size = measure(Math.abs(absolute), unit, currency)
  const share = pct === null || pct === undefined ? '' : ` (${signed(pct)})`
  return `Came in at ${measure(actual, unit, currency)} — ${size}${share} ${direction} the ${measure(
    expected,
    unit,
    currency,
  )} expected.`
}

const VERDICT_MEANING: Record<string, string> = {
  NORMAL: 'A normal day for this KPI.',
  ABNORMAL: 'A bigger move than this KPI usually makes.',
  LOW_CONFIDENCE:
    'Too little comparable history to judge this date. The figures stand; the verdict does not.',
}

/* ------------------------------------------------------------- WHY FLAGGED */

function StatRow({
  label,
  value,
  note,
}: {
  label: string
  value: string
  note?: string | null
}) {
  return (
    <div className="flex flex-wrap items-baseline justify-between gap-2 border-b border-slate-200/70 py-2 last:border-0">
      <div className="text-[12px] text-slate-600">{label}</div>
      <div className="text-right">
        <div className="text-[13px] font-semibold tabular-nums text-slate-800">{value}</div>
        {note && <div className="text-[11px] leading-snug text-slate-500">{note}</div>}
      </div>
    </div>
  )
}

/**
 * The two tests, reported separately.
 *
 * This is the one place the page must not simplify. A verdict can be ABNORMAL
 * because the movement cleared the materiality tolerance even though the
 * statistical test was not met — the engine records both outcomes, and collapsing
 * them into a single "flagged because" sentence would misstate the reasoning a
 * reader may have to defend. So each test gets its own line and its own result.
 */
function WhyFlagged({
  evidence,
  status,
  reason,
  unit,
  currency,
}: {
  evidence: DetectionEvidence
  status: string
  reason: string | null
  unit?: string | null
  currency?: string | null
}) {
  const { statistics: stats, tolerance, reference, bucket } = evidence
  const zLine =
    stats.modified_z_score === null || stats.z_threshold === null
      ? 'Not computed for this evaluation.'
      : `${stats.modified_z_score.toFixed(2)} against a threshold of ${stats.z_threshold.toFixed(2)}`

  return (
    <div className="space-y-4">
      <div className="grid gap-4 lg:grid-cols-2">
        <div className="rounded-xl border border-slate-200 bg-white/60 p-3">
          <div className="text-[11px] font-semibold uppercase tracking-wider text-slate-500">
            What it was compared against
          </div>
          <div className="mt-1">
            <StatRow
              label="Comparison basis"
              value={titleCase(bucket.applied)}
              note={
                bucket.decisions.find((decision) => decision.role === 'PRIMARY')?.note ??
                bucket.decisions[0]?.note ??
                null
              }
            />
            <StatRow
              label="Comparable periods used"
              value={formatNumber(reference.count)}
              note={
                reference.count === 0
                  ? 'With no comparable periods there is nothing to test against.'
                  : null
              }
            />
            <StatRow
              label="Comparison policy in force"
              value={
                bucket.config_key
                  ? `${bucket.config_key} v${bucket.config_version ?? '—'}`
                  : 'None approved'
              }
              note={
                bucket.config_key
                  ? null
                  : 'No approved comparison policy, so the engine compared recent periods and claims no weekly, monthly or seasonal pattern.'
              }
            />
            <StatRow
              label="Year-over-year adjustment"
              value={evidence.year_over_year.applied ? 'Applied' : 'Not applied'}
              note={
                evidence.year_over_year.applied && evidence.year_over_year.factor !== null
                  ? `Factor ${evidence.year_over_year.factor.toFixed(3)}`
                  : null
              }
            />
          </div>
        </div>

        <div className="rounded-xl border border-slate-200 bg-white/60 p-3">
          <div className="text-[11px] font-semibold uppercase tracking-wider text-slate-500">
            The statistics the verdict used
          </div>
          <div className="mt-1">
            <StatRow
              label="Robust median of comparable periods"
              value={measure(stats.median, unit, currency)}
            />
            <StatRow
              label={`Dispersion (${stats.dispersion_basis ?? 'not recorded'})`}
              value={stats.mad === null ? '—' : formatNumber(stats.mad, 2)}
              note={
                stats.dispersion_basis && stats.dispersion_basis !== 'MAD'
                  ? 'Median absolute deviation was zero or unusable, so a fallback dispersion applied.'
                  : null
              }
            />
            <StatRow label="Modified z-score" value={zLine} note={stats.z_threshold_note} />
            <StatRow
              label="Materiality tolerance"
              value={
                tolerance.relative_pct !== null
                  ? `${tolerance.relative_pct.toFixed(1)}%`
                  : tolerance.absolute !== null
                    ? formatNumber(tolerance.absolute, 2)
                    : 'Not set'
              }
              note={
                tolerance.relative_floor_pct !== null
                  ? `Scale-aware floor ${tolerance.relative_floor_pct.toFixed(1)}% of the KPI's own level.`
                  : null
              }
            />
          </div>
        </div>
      </div>

      {/* The two findings, each labelled with its own outcome. */}
      <div className="grid gap-3 sm:grid-cols-2">
        <div
          className={`rounded-xl border p-3 ${
            stats.statistically_significant
              ? 'border-rose-200 bg-rose-50/60'
              : 'border-slate-200 bg-white/60'
          }`}
        >
          <div className="text-[11px] font-semibold uppercase tracking-wider text-slate-500">
            Statistical test
          </div>
          <div className="mt-1 text-[13px] font-semibold text-slate-800">
            {stats.statistically_significant ? 'Met' : 'Not met'}
          </div>
          <p className="mt-1 text-[12px] leading-relaxed text-slate-600">
            {stats.statistically_significant
              ? 'The movement is larger than this KPI’s own comparable history explains.'
              : 'The movement is within what this KPI’s comparable history explains.'}
          </p>
        </div>
        <div
          className={`rounded-xl border p-3 ${
            tolerance.breached ? 'border-rose-200 bg-rose-50/60' : 'border-slate-200 bg-white/60'
          }`}
        >
          <div className="text-[11px] font-semibold uppercase tracking-wider text-slate-500">
            Materiality
          </div>
          <div className="mt-1 text-[13px] font-semibold text-slate-800">
            {tolerance.breached ? 'Tolerance breached' : 'Within tolerance'}
          </div>
          <p className="mt-1 text-[12px] leading-relaxed text-slate-600">
            {tolerance.movement_is_material
              ? 'The movement is large enough, against this KPI’s own level, to matter.'
              : 'The movement is too small, against this KPI’s own level, to be worth acting on.'}
          </p>
        </div>
      </div>

      <div className="rounded-xl border border-sky-200 bg-sky-50/60 p-3">
        <div className="flex flex-wrap items-center gap-2">
          <span className="text-[11px] font-semibold uppercase tracking-wider text-sky-800">
            Final verdict
          </span>
          <StatusBadge status={status} />
        </div>
        <p className="mt-1.5 text-[13px] leading-relaxed text-slate-700">
          {VERDICT_MEANING[status] ??
            'This verdict came from an earlier version of the engine and is reported as stored.'}
        </p>
        {reason && (
          <p className="mt-1.5 text-[12px] leading-relaxed text-slate-600">
            Engine’s recorded reason: {reason}
          </p>
        )}
      </div>

      {evidence.notes.length > 0 && (
        <div className="rounded-xl border border-slate-200 bg-white/60 p-3">
          <div className="text-[11px] font-semibold uppercase tracking-wider text-slate-500">
            What the engine noted while evaluating
          </div>
          <ul className="mt-1.5 space-y-1 text-[12px] leading-relaxed text-slate-600">
            {evidence.notes.map((note) => (
              <li key={note}>· {note}</li>
            ))}
          </ul>
        </div>
      )}
    </div>
  )
}

/* ------------------------------------------------------------- CONTRIBUTORS */

function Contributors({
  data,
  unit,
  currency,
}: {
  data: ContributionResponse
  unit?: string | null
  currency?: string | null
}) {
  const { result } = data
  const ranked = result.contributors
  const widest = Math.max(
    ...ranked.map((row) => Math.abs(row.absolute_share_pct ?? row.share_pct ?? 0)),
    1,
  )

  return (
    <div className="space-y-3">
      <div className="flex flex-wrap items-center gap-2 text-[11px] uppercase tracking-wider text-slate-500">
        <span className="chip">Broken down by {titleCase(result.dimension)}</span>
        <span className="chip">
          Movement {measure(result.movement, unit, currency)}
          {result.movement_pct !== null ? ` (${signed(result.movement_pct)})` : ''}
        </span>
        {result.shares_available ? (
          <span className="chip">
            Top {ranked.length} of {result.ranked_count} account for{' '}
            {result.explained_pct === null ? '—' : `${result.explained_pct.toFixed(1)}%`}
          </span>
        ) : (
          // A ratio, an average or a distinct count: no share of its movement is
          // arithmetic, so the page shows movements without inventing percentages.
          <span className="chip">Shares not arithmetic for this KPI</span>
        )}
      </div>

      {ranked.length === 0 ? (
        <EmptyState
          title="No contributors ranked"
          description="The breakdown returned no parts for this dimension on this date."
        />
      ) : (
        <ul className="space-y-2">
          {ranked.map((row, index) => {
            const share = row.absolute_share_pct ?? row.share_pct
            const width = share === null ? 0 : (Math.abs(share) / widest) * 100
            return (
              <li
                key={`${row.entity ?? row.label}-${index}`}
                className={`rounded-xl border p-3 ${
                  index === 0 ? 'border-sky-300 bg-sky-50/60' : 'border-slate-200 bg-white/60'
                }`}
              >
                <div className="flex flex-wrap items-baseline justify-between gap-2">
                  <div className="flex items-center gap-2">
                    <span className="text-[13px] font-semibold text-slate-800">{row.label}</span>
                    {index === 0 && <span className="chip">Top contributor</span>}
                  </div>
                  <div className="text-right text-[12px] text-slate-600">
                    <span className="font-semibold tabular-nums text-slate-800">
                      {measure(row.change, unit, currency)}
                    </span>{' '}
                    movement
                  </div>
                </div>
                {/* "Accounts for", never "caused": a share of a movement is a size,
                    and this platform does not establish causation. */}
                <div className="mt-1 text-[12px] text-slate-600">
                  {share === null
                    ? 'No arithmetic share of the movement is available for this KPI.'
                    : `Accounts for ${Math.abs(share).toFixed(1)}% of the observed movement.`}
                </div>
                <div className="mt-2 h-1.5 w-full overflow-hidden rounded-full bg-slate-200">
                  <div
                    className={index === 0 ? 'h-full bg-sky-500' : 'h-full bg-slate-400'}
                    style={{ width: `${width}%` }}
                  />
                </div>
                {row.note && (
                  <div className="mt-1.5 text-[11px] leading-snug text-slate-500">{row.note}</div>
                )}
              </li>
            )
          })}
        </ul>
      )}

      {result.notes.length > 0 && (
        <ul className="space-y-1 text-[11px] leading-relaxed text-slate-500">
          {result.notes.map((note) => (
            <li key={note}>· {note}</li>
          ))}
        </ul>
      )}

      {data.evidence && data.evidence.withheld_by_scope > 0 && (
        <Alert tone="info">
          {data.evidence.withheld_by_scope} part
          {data.evidence.withheld_by_scope === 1 ? '' : 's'} of this breakdown lie outside your row
          scope and were excluded before the query ran.
        </Alert>
      )}
    </div>
  )
}

/* -------------------------------------------------------------- KEY FINDING */

/**
 * The one to three sentences a reader needs before reading a recommendation.
 *
 * Every figure comes from the stored breakdown the server returned; the wording is
 * fixed here so the page cannot say more than was measured. Three rules hold:
 *
 *  - **"Accounts for", never "caused".** A share of a movement is a size. Nothing
 *    in this platform establishes causation, so nothing on this line may imply it.
 *  - **No share is invented.** A ratio, an average or a distinct count has no
 *    arithmetic share of its own movement, and for those the line names the largest
 *    mover in the KPI's own unit instead of printing a percentage that would not add
 *    up.
 *  - **At most three.** The fourth-largest contributor to a movement has never
 *    changed a decision, and the full ranking is one disclosure away.
 */
function keyFindings(
  data: ContributionResponse,
  unit?: string | null,
  currency?: string | null,
): string[] {
  const { result } = data
  const ranked = result.contributors
  if (ranked.length === 0) {
    return [
      `No ${result.dimension} values are recorded for this date, so no part of the business is named.`,
    ]
  }

  const shareOf = (row: (typeof ranked)[number]): number | null => {
    const share = row.absolute_share_pct ?? row.share_pct
    return share === null || share === undefined ? null : Math.abs(share)
  }

  const lines: string[] = []
  const leader = ranked[0]
  const leaderShare = shareOf(leader)
  lines.push(
    leaderShare === null
      ? `Largest ${result.dimension}: ${leader.label}, ${measure(leader.change, unit, currency)} of movement.`
      : `${leader.label} accounts for ${leaderShare.toFixed(1)}% of the movement (${measure(
          leader.change,
          unit,
          currency,
        )}).`,
  )

  const second = ranked[1]
  if (second) {
    const secondShare = shareOf(second)
    lines.push(
      secondShare === null
        ? `Next largest: ${second.label}, ${measure(second.change, unit, currency)}.`
        : `Next largest: ${second.label}, ${secondShare.toFixed(1)}%.`,
    )
  }

  // The server's own judgement of whether the leader settles the question, or
  // failing that, how much of the movement the listed parts cover between them.
  if (result.leader_is_sufficient && leaderShare !== null) {
    lines.push(`${leader.label} alone accounts for most of this movement; the rest is small.`)
  } else if (result.shares_available && result.explained_pct !== null) {
    lines.push(
      `The ${ranked.length} shown of ${result.ranked_count} cover ${Math.abs(
        result.explained_pct,
      ).toFixed(1)}% of it between them.`,
    )
  }

  return lines.slice(0, 3)
}

/* ------------------------------------------------------------------- page */

export default function ResultDetail() {
  const { runId = '' } = useParams()
  const navigate = useNavigate()
  const { companyId, can } = useAuth()
  const mayView = can('analytics.read')
  const mayInvestigate = can('investigation.read')

  const detail = useResource<DetectionRunDetail>(
    () => api.get(`/companies/${companyId}/detection-runs/${runId}`),
    [companyId, runId],
    { enabled: Boolean(companyId && runId) && mayView },
  )

  const result = detail.data?.result ?? null
  const evidence = detail.data?.evidence

  const [contribution, setContribution] = useState<ContributionResponse | null>(null)
  const breakdown = useAction()

  // Bumped when a breakdown is stored. The recommendation set is derived on read
  // from whatever breakdown exists, so a fresh contribution changes the answer —
  // from "no part of the business is named" to a named area — and the panel has to
  // ask again to show it. A counter rather than the contribution object itself,
  // because what changed is the *server's* evidence, not this page's state.
  const [recommendationToken, setRecommendationToken] = useState(0)

  const [explanation, setExplanation] = useState<Explanation | null>(null)
  const explaining = useAction()

  // Notes already written against this movement. A read, so it loads with the
  // page; writing them belongs to the Investigation Center, which is where the
  // evidence a note is about is on screen.
  const findings = useResource<FindingsResponse>(
    () =>
      api.get(`/companies/${companyId}/investigation/findings`, {
        query: { kpi_id: result?.kpi_key, target_date: result?.target_date },
      }),
    [companyId, result?.kpi_key, result?.target_date],
    { enabled: Boolean(companyId && result?.kpi_key) && mayInvestigate },
  )

  const runBreakdown = useCallback(async () => {
    if (!result) return
    const response = await breakdown.run(() =>
      api.post<ContributionResponse>(`/companies/${companyId}/investigation/contribution`, {
        kpi_id: result.kpi_key,
        target_date: result.target_date,
        dimension: null,
        path: [],
        top_k: 8,
      }),
    )
    if (response) {
      setContribution(response)
      setRecommendationToken((token) => token + 1)
    }
  }, [breakdown, companyId, result])

  const explainResult = useCallback(async () => {
    if (!result) return
    const response = await explaining.run(() =>
      api.post<ExplanationResponse>(`/companies/${companyId}/results/explain`, {
        kpi_id: result.kpi_key,
        target_date: result.target_date,
      }),
    )
    if (response) setExplanation(response.explanation)
  }, [companyId, explaining, result])

  const investigationLink = useMemo(
    () =>
      result
        ? `/investigation?kpi=${encodeURIComponent(result.kpi_key)}&date=${result.target_date}`
        : '/investigation',
    [result],
  )

  // What the Copilot drawer inherits while this page is open, so a question asked
  // from the sidebar is already about the movement on screen and the reader never
  // retypes its coordinates. `kpi_result` is the panel that anchors an answer to a
  // stored evaluation, which is exactly what this page is showing.
  //
  // No figures are published. The actual, the expected and the deviation are all
  // rendered above, and none of them is sent: the server re-reads them from the run
  // it stored, so the Copilot cannot be told a number by a screen.
  //
  // The version and the dimension are coordinates too, and both matter to the
  // answer. The version because an older definition of this KPI may mean something
  // different; the dimension because the server narrows the stored breakdown it
  // attaches to the one in view — so it is published only once a breakdown has
  // actually been run here, and stays null until then rather than naming a
  // dimension whose analysis does not exist. No entity is published because this
  // page ranks contributors without selecting one; drilling into a part of the
  // business is the Investigation Center's job.
  useCopilotScreen({
    panel: 'kpi_result',
    kpiId: result?.kpi_key ?? null,
    kpiVersion: evidence?.kpi_version ?? null,
    selectedDate: result?.target_date ?? null,
    dimension: contribution?.result.dimension ?? null,
    label: result ? formatKpiName(result.kpi) : null,
  })

  if (!mayView) {
    return (
      <Alert tone="warn">
        You do not have permission to view stored results for this company.
      </Alert>
    )
  }

  if (detail.loading && !detail.data)
    return (
      <LoadingState
        label="Loading the stored result…"
        detail="Reading the evaluation the platform saved for this date."
      />
    )

  if (detail.error) {
    return (
      <LoadError
        message="Unable to load this result."
        detail={detail.error}
        onRetry={() => void detail.reload()}
        action={
          <button type="button" className="btn btn-xs btn-ghost" onClick={() => navigate('/results')}>
            Back to results
          </button>
        }
      />
    )
  }

  if (!result) {
    return (
      <EmptyState
        title="No stored result at this address"
        description="The result may belong to another company, or the evaluation may have been removed."
      />
    )
  }

  const openFindings = (findings.data?.findings ?? []).filter(
    (finding) => finding.status !== 'RESOLVED',
  )

  return (
    <div className="space-y-5">
      {/* ------------------------------------------------------------ header */}
      <PageHeader
        eyebrow={
          <span className="flex items-center gap-2 normal-case tracking-normal">
            <Link to="/results" className="hover:text-slate-300">
              Results
            </Link>
            <span>/</span>
            <span className="uppercase tracking-[0.18em]">Result</span>
          </span>
        }
        title={formatKpiName(result.kpi)}
        subtitle={
          <>
            Evaluated for {formatDate(result.target_date)}
            {detail.data?.executed_at ? ` · stored ${formatDateTime(detail.data.executed_at)}` : ''}
          </>
        }
        actions={
          <>
            <StatusBadge status={result.status} />
            {mayInvestigate && (
              <Link to={investigationLink} className="btn btn-xs btn-ghost">
                Investigate this movement
              </Link>
            )}
          </>
        }
      />

      {/* ----------------------------------------------------- WHAT HAPPENED */}
      <Panel title="What happened">
        <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-4">
          <div>
            <div className="text-[11px] uppercase tracking-wider text-slate-500">Actual</div>
            <div className="mt-1 text-2xl font-semibold tabular-nums text-slate-100">
              {measure(result.actual, result.unit, result.currency)}
            </div>
          </div>
          <div>
            <div className="text-[11px] uppercase tracking-wider text-slate-500">Expected</div>
            <div className="mt-1 text-2xl font-semibold tabular-nums text-slate-100">
              {measure(result.expected, result.unit, result.currency)}
            </div>
            <div className="mt-1 text-[11px] text-slate-500">
              {result.comparison ?? 'Comparison basis not recorded'}
            </div>
          </div>
          <div>
            <div className="text-[11px] uppercase tracking-wider text-slate-500">Movement</div>
            <div className="mt-1 text-2xl font-semibold tabular-nums text-slate-100">
              {measure(result.deviation_absolute, result.unit, result.currency)}
            </div>
            <div className="mt-1 text-[11px] text-slate-500">{signed(result.deviation_pct)}</div>
          </div>
          <div>
            <div className="text-[11px] uppercase tracking-wider text-slate-500">Verdict</div>
            <div className="mt-1.5">
              <StatusBadge status={result.status} />
            </div>
            <div className="mt-1 text-[11px] leading-snug text-slate-500">
              {VERDICT_MEANING[result.status] ?? 'Stored by an earlier version of the engine.'}
            </div>
          </div>
        </div>

        <p className="mt-4 text-sm leading-relaxed text-slate-200">
          {movementSentence(
            result.actual,
            result.expected,
            result.deviation_absolute,
            result.deviation_pct,
            result.unit,
            result.currency,
          )}
        </p>
        {result.headline && (
          <p className="mt-1.5 text-[13px] leading-relaxed text-slate-500">{result.headline}</p>
        )}

        {mayInvestigate && openFindings.length > 0 && (
          <div className="mt-4 rounded-xl border border-amber-200 bg-amber-50/60 p-3">
            <div className="text-[11px] font-semibold uppercase tracking-wider text-amber-700">
              Notes already recorded on this movement ({openFindings.length} open)
            </div>
            <ul className="mt-1.5 space-y-1.5">
              {openFindings.slice(0, 3).map((finding) => (
                <li key={finding.id} className="text-[12px] leading-relaxed text-amber-900">
                  <span className="font-semibold">{finding.status.replace(/_/g, ' ')}</span> ·{' '}
                  {finding.title}
                  {finding.scope_label ? ` — ${finding.scope_label}` : ''}
                </li>
              ))}
            </ul>
          </div>
        )}
      </Panel>

      {/* -------------------------------------------------------- KEY FINDING */}
      {/* What moved the KPI, in at most three lines, plus the governed explanation
          when a reader asks for one. The full ranking these lines are drawn from is
          in the disclosure at the foot of the page. */}
      <Panel
        title="Key finding"
        actions={
          <>
            {mayInvestigate && (
              <button
                type="button"
                className="btn btn-xs btn-ghost"
                onClick={runBreakdown}
                disabled={breakdown.pending}
              >
                {breakdown.pending
                  ? 'Reading the data…'
                  : contribution
                    ? 'Check again'
                    : 'Find what drove this'}
              </button>
            )}
            <ExplainButton
              label="Explain in business terms"
              pending={explaining.pending}
              onClick={explainResult}
              title="Explain this result from its stored evidence and the documents you may see"
            />
          </>
        }
      >
        <div className="space-y-3">
          {breakdown.error && <Alert tone="error">{breakdown.error}</Alert>}

          {contribution ? (
            <ul className="space-y-2">
              {keyFindings(contribution, result.unit, result.currency).map((line) => (
                <li key={line} className="flex gap-2.5 text-sm leading-snug text-slate-200">
                  <span className="mt-[7px] h-1.5 w-1.5 shrink-0 rounded-full bg-accent" />
                  <span>{line}</span>
                </li>
              ))}
            </ul>
          ) : mayInvestigate ? (
            <p className="text-sm text-slate-500">
              No part of the business is named yet. Find what drove this to rank the areas behind
              the movement.
            </p>
          ) : (
            <p className="text-sm text-slate-500">
              Naming the area behind a movement reads the company&rsquo;s own data for the date, so
              it needs investigation access.
            </p>
          )}

          {/* Rendered only once asked for. An empty explanation card in the primary
              view would spend four lines saying nothing has been requested. */}
          {(explanation || explaining.pending || explaining.error) && (
            <ExplanationCard
              explanation={explanation}
              error={explaining.error}
              pending={explaining.pending}
              footer={
                mayInvestigate && explanation ? (
                  <Link to={investigationLink} className="btn btn-xs btn-ghost">
                    Investigate which parts of the business account for this
                  </Link>
                ) : undefined
              }
            />
          )}

          <p className="text-[11px] text-slate-500">
            A share of a movement is a size, not a proven cause.
          </p>
        </div>
      </Panel>

      {/* ------------------------------------------- RECOMMENDED NEXT ACTIONS */}
      {/* Directly after the contributors, because that is the order the reasoning
          runs in — and reusing this page's own breakdown action rather than a
          second implementation of it, so the two panels can never be looking at
          different evidence. */}
      <Recommendations
        companyId={companyId ?? ''}
        runId={runId}
        enabled={Boolean(companyId && runId)}
        refreshToken={recommendationToken}
        onRunBreakdown={mayInvestigate ? runBreakdown : undefined}
        breakdownPending={breakdown.pending}
      />

      {/* ---------------------------------------------- EVIDENCE AND DETAILS */}
      {/* One disclosure, closed by default, holding everything the four answers
          above were built from. Placement, not availability: a reader who has to
          defend a verdict still reaches every stored figure, and a reader who does
          not never has to read past the answer to find it. */}
      <details className="group panel">
        <summary className="flex cursor-pointer list-none items-center justify-between gap-3 px-4 py-3 [&::-webkit-details-marker]:hidden">
          <span>
            <span className="panel-title">Evidence &amp; details</span>
            <span className="ml-2 text-[11px] text-slate-500">
              The full breakdown, the statistics behind the verdict, and the periods it was
              compared against
            </span>
          </span>
          <span className="btn btn-xs btn-ghost shrink-0">
            <span className="group-open:hidden">View</span>
            <span className="hidden group-open:inline">Hide</span>
          </span>
        </summary>

        <div className="space-y-6 border-t border-ink-800/80 p-4">
          {/* -------------------------------------------------- CONTRIBUTORS */}
          <section>
            <h3 className="text-[11px] font-semibold uppercase tracking-[0.14em] text-slate-500">
              Every part of the business, ranked
            </h3>
            <div className="mt-2">
              {!mayInvestigate ? (
                <Alert tone="info">
                  Breaking a movement down reads the company&rsquo;s own data for the date, so it
                  requires investigation access.
                </Alert>
              ) : contribution ? (
                <Contributors data={contribution} unit={result.unit} currency={result.currency} />
              ) : (
                <p className="text-sm text-slate-500">
                  Not broken down yet. &ldquo;Find what drove this&rdquo; above queries this
                  KPI&rsquo;s own source for {formatDate(result.target_date)} and ranks the parts of
                  the business by how much of the movement each accounts for.
                </p>
              )}
            </div>
          </section>

          {/* --------------------------------------------------- WHY FLAGGED */}
          <section>
            <h3 className="text-[11px] font-semibold uppercase tracking-[0.14em] text-slate-500">
              Why this verdict
            </h3>
            <div className="mt-2">
              {evidence ? (
                <WhyFlagged
                  evidence={evidence}
                  status={result.status}
                  reason={evidence.reason}
                  unit={result.unit}
                  currency={result.currency}
                />
              ) : (
                <Alert tone="info">
                  The statistical record behind this verdict — comparable periods, robust median,
                  dispersion, z-score and tolerance — is available to roles holding KPI governance
                  access. Your role sees the verdict, the movement and the comparison basis.
                </Alert>
              )}
            </div>
          </section>

          {/* ------------------------------------------------------ EVIDENCE */}
          <section>
            <h3 className="text-[11px] font-semibold uppercase tracking-[0.14em] text-slate-500">
              The record behind this evaluation
            </h3>
            <div className="mt-2">
              {evidence ? (
                <div className="space-y-4">
                  <div className="grid gap-3 text-[12px] sm:grid-cols-2 xl:grid-cols-4">
                    <div className="rounded-xl border border-slate-200 bg-white/60 p-3">
                      <div className="text-[11px] uppercase tracking-wider text-slate-500">
                        KPI version
                      </div>
                      <div className="mt-1 font-semibold text-slate-800">
                        v{evidence.kpi_version}
                      </div>
                    </div>
                    <div className="rounded-xl border border-slate-200 bg-white/60 p-3">
                      <div className="text-[11px] uppercase tracking-wider text-slate-500">
                        Method
                      </div>
                      <div className="mt-1 font-semibold text-slate-800">
                        {evidence.method ?? 'Not recorded'}
                      </div>
                    </div>
                    <div className="rounded-xl border border-slate-200 bg-white/60 p-3">
                      <div className="text-[11px] uppercase tracking-wider text-slate-500">
                        Source queries
                      </div>
                      <div className="mt-1 font-semibold text-slate-800">
                        {evidence.query_count ?? '—'}
                      </div>
                    </div>
                    <div className="rounded-xl border border-slate-200 bg-white/60 p-3">
                      <div className="text-[11px] uppercase tracking-wider text-slate-500">
                        Evaluation time
                      </div>
                      <div className="mt-1 font-semibold text-slate-800">
                        {evidence.duration_ms === null || evidence.duration_ms === undefined
                          ? '—'
                          : `${formatNumber(evidence.duration_ms)} ms`}
                      </div>
                    </div>
                  </div>

                  <div>
                    <div className="text-[11px] font-semibold uppercase tracking-wider text-slate-500">
                      Comparable periods the expectation was built from ({evidence.reference.count})
                    </div>
                    {evidence.reference.points.length === 0 ? (
                      <p className="mt-1.5 text-[12px] text-slate-500">
                        None. With no comparable periods the engine has nothing to test this date
                        against, which is what a LOW CONFIDENCE verdict records.
                      </p>
                    ) : (
                      <div className="mt-2 max-h-56 overflow-y-auto rounded-xl border border-slate-200">
                        <table className="min-w-full text-[12px]">
                          <thead className="bg-slate-50">
                            <tr>
                              <th className="px-3 py-1.5 text-left font-semibold text-slate-600">
                                Period
                              </th>
                              <th className="px-3 py-1.5 text-right font-semibold text-slate-600">
                                Value
                              </th>
                            </tr>
                          </thead>
                          <tbody>
                            {evidence.reference.points.map((point) => (
                              <tr key={point.date} className="border-t border-slate-200">
                                <td className="px-3 py-1.5 text-slate-700">
                                  {formatDate(point.date)}
                                </td>
                                <td className="px-3 py-1.5 text-right tabular-nums text-slate-800">
                                  {measure(point.value, result.unit, result.currency)}
                                </td>
                              </tr>
                            ))}
                          </tbody>
                        </table>
                      </div>
                    )}
                  </div>

                  {evidence.bucket.decisions.length > 0 && (
                    <div>
                      <div className="text-[11px] font-semibold uppercase tracking-wider text-slate-500">
                        How the comparison basis was chosen
                      </div>
                      <ul className="mt-1.5 space-y-1.5">
                        {evidence.bucket.decisions.map((decision, index) => (
                          <li
                            key={`${decision.bucket}-${index}`}
                            className="rounded-lg border border-slate-200 bg-white/60 p-2.5 text-[12px]"
                          >
                            <div className="flex flex-wrap items-center gap-2">
                              <span className="font-semibold text-slate-800">
                                {titleCase(decision.bucket)}
                              </span>
                              <span className="chip">{titleCase(decision.role)}</span>
                              <span className="text-slate-500">
                                {decision.reference_count} comparable period
                                {decision.reference_count === 1 ? '' : 's'}
                              </span>
                            </div>
                            <div className="mt-1 leading-relaxed text-slate-600">
                              {decision.note}
                            </div>
                          </li>
                        ))}
                      </ul>
                    </div>
                  )}
                </div>
              ) : (
                <Alert tone="info">
                  The technical record for this evaluation is available to roles holding KPI
                  governance access.
                </Alert>
              )}
            </div>
          </section>
        </div>
      </details>
    </div>
  )
}
