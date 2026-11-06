// "Visitor ratings" — QR-30 (Matt, 2026-10-16): "Should visitors be able to rate an area thumbs up
// or down? — Yes, and only the office sees the results, by building."
//
// Runs INLINE like every report: period (7 / 30 / 90 days, 30 by default) → Run → the thumbs up,
// thumbs down, share positive and buildings rated → a table by BUILDING, worst first, 20 a page,
// each building opening onto its areas (a list inside its row, worst first) → CSV, one row per area.
//
// THE NUMBERS ARE THE SERVER'S (scanCodesApi.fetchVisitorRatings → GET /api/qc/reports/visitor-
// ratings, EP-416: the Reports page's key AND an office role — never crew, never a customer): every
// vote of the period's ORG days read completely and tallied by the one rule, lib/areaRatings
// visitorRatingsReport (the demo runs the same rule over its own votes). Nothing about a phone is
// ever in it. Listed only for office roles (Reports.jsx `office`).
//
// Written on the catalog from its first line (UI_RULES §140): `visitorRatings.report.*`.
import { Fragment, useCallback, useMemo, useState } from 'react';
import { useT } from '../../i18n/react';
import { todayKey } from '../../lib/dates';
import { fetchVisitorRatings } from '../../lib/scanCodesApi';
import { REMOVED_AREA, REMOVED_LOCATION } from '../../lib/areaRatings';
import usePagedRows from '../../hooks/usePagedRows';
import ListPager from '../../components/ListPager';
import Badge from '../../components/Badge';
import Icon from '../../components/Icon';
import {
  PeriodField, PERIODS, FilterRow, RunActions, KpiRow, StatCard, RunSurface, downloadReportCsv, NoRows,
  reportErrorMessage, canRetryError, useRunGuard,
} from './reportKit';

// The report's own periods: the kit's rolling 7 / 30 / 90 days (the route answers those three).
const RATING_PILLS = PERIODS.filter((p) => ['7d', '30d', '90d'].includes(p.value));
const DAYS_OF = { '7d': 7, '30d': 30, '90d': 90 };

export default function VisitorRatingsReport() {
  const t = useT();
  const [period, setPeriod] = useState('30d');
  const [result, setResult] = useState(null);
  const [running, setRunning] = useState(false);
  const [error, setError] = useState(null); // { message, canRetry }
  const [open, setOpen] = useState(() => new Set());
  const guard = useRunGuard();

  const run = useCallback(async () => {
    const token = guard.begin();
    setRunning(true); setError(null); setOpen(new Set());
    try {
      const r = await fetchVisitorRatings({ days: DAYS_OF[period] || 30 });
      if (guard.isCurrent(token)) setResult(r);
    } catch (e) {
      if (guard.isCurrent(token)) { setResult(null); setError({ message: reportErrorMessage(e), canRetry: canRetryError(e) }); }
    } finally { if (guard.isCurrent(token)) setRunning(false); }
  }, [period, guard]);

  // The server's "removed" names, in the reader's words.
  const nameOf = useCallback((b) => (b.name === REMOVED_LOCATION ? t('visitorRatings.report.removedLocation') : b.name), [t]);
  const labelOf = useCallback((a) => (a.label === REMOVED_AREA ? t('visitorRatings.report.removedArea') : a.label), [t]);
  const pct = useCallback((v) => (v == null ? '—' : t('visitorRatings.report.pct', { pct: v })), [t]);

  const buildings = useMemo(() => result?.buildings || [], [result]);
  const pager = usePagedRows(buildings, { resetKey: buildings });
  const totals = result?.totals || null;

  const toggle = (key) => setOpen((cur) => {
    const next = new Set(cur);
    if (next.has(key)) next.delete(key); else next.add(key);
    return next;
  });

  // The CSV: one row per area, its building beside it.
  const csvColumns = useMemo(() => [
    { key: 'building', label: t('visitorRatings.report.col.building'), value: (r) => r.building },
    { key: 'area', label: t('visitorRatings.report.col.area'), value: (r) => r.area },
    { key: 'location', label: t('visitorRatings.report.col.location'), value: (r) => r.location || '' },
    { key: 'up', label: t('visitorRatings.report.col.up'), value: (r) => r.up },
    { key: 'down', label: t('visitorRatings.report.col.down'), value: (r) => r.down },
    { key: 'positive', label: t('visitorRatings.report.col.positive'), value: (r) => (r.pctPositive == null ? '' : r.pctPositive) },
  ], [t]);
  const csvRows = useMemo(() => buildings.flatMap((b) => b.areas.map((a) => ({
    building: nameOf(b), area: labelOf(a), location: a.location, up: a.up, down: a.down, pctPositive: a.pctPositive,
  }))), [buildings, nameOf, labelOf]);

  const shown = result ? buildings : null;

  return (
    <>
      <FilterRow>
        <PeriodField period={period} onPeriod={(p) => { setPeriod(p); guard.invalidate(); setResult(null); setError(null); setRunning(false); }} periods={RATING_PILLS} />
      </FilterRow>

      <RunActions
        running={running}
        hasRows={csvRows.length > 0}
        onRun={run}
        onExport={() => downloadReportCsv(`visitor-ratings-${todayKey()}.csv`, csvColumns, csvRows)}
        note={t('visitorRatings.report.note')}
      />

      <RunSurface
        rows={shown}
        running={running}
        error={error?.message}
        onRetry={error?.canRetry ? run : undefined}
        empty={<NoRows title={t('visitorRatings.report.emptyTitle')} message={t('visitorRatings.report.emptyHint')} />}
      >
        <KpiRow>
          <StatCard label={t('visitorRatings.report.kpi.up')} value={totals?.up ?? 0} />
          <StatCard label={t('visitorRatings.report.kpi.down')} value={totals?.down ?? 0} tone={(totals?.down || 0) > (totals?.up || 0) ? 'warn' : undefined} />
          <StatCard label={t('visitorRatings.report.kpi.positive')} value={pct(totals?.pctPositive)} />
          <StatCard label={t('visitorRatings.report.kpi.buildings')} value={totals?.buildings ?? 0} />
        </KpiRow>
        <div className="table-wrap mobile-stack">
          <table className="vr-table">
            <thead>
              <tr>
                <th>{t('visitorRatings.report.col.building')}</th>
                <th>{t('visitorRatings.report.col.up')}</th>
                <th>{t('visitorRatings.report.col.down')}</th>
                <th>{t('visitorRatings.report.col.positive')}</th>
              </tr>
            </thead>
            <tbody>
              {pager.pageRows.map((b) => {
                const isOpen = open.has(b.key);
                const areasId = `vr-areas-${b.key.replace(/[^A-Za-z0-9_-]/g, '_')}`;
                return (
                  <Fragment key={b.key}>
                    <tr className={isOpen ? 'vr-row is-open' : 'vr-row'}>
                      <td className="cell-primary">
                        <button
                          type="button"
                          className="btn btn-link vr-toggle"
                          aria-expanded={isOpen}
                          aria-controls={areasId}
                          onClick={() => toggle(b.key)}
                        >
                          <Icon name={isOpen ? 'chevronDown' : 'chevronRight'} size={14} />
                          <span className="truncate">{nameOf(b)}</span>
                        </button>
                        {b.archived && <Badge variant="slate">{t('visitorRatings.report.archived')}</Badge>}
                      </td>
                      <td data-label={t('visitorRatings.report.col.up')} className="tnum">{b.up}</td>
                      <td data-label={t('visitorRatings.report.col.down')} className="tnum">{b.down}</td>
                      <td data-label={t('visitorRatings.report.col.positive')} className="tnum">{pct(b.pctPositive)}</td>
                    </tr>
                    {isOpen && (
                      <tr className="vr-areas-row">
                        <td colSpan={4}>
                          <ul className="vr-areas" id={areasId} aria-label={t('visitorRatings.report.areasOf', { building: nameOf(b) })}>
                            {b.areas.map((a) => (
                              <li key={a.key} className="vr-area">
                                <span className="vr-area-name">
                                  {labelOf(a)}
                                  {a.location && <span className="text-muted"> · {a.location}</span>}
                                </span>
                                <span className="vr-area-figures tnum text-sm">
                                  {t('visitorRatings.report.areaFigures', { up: a.up, down: a.down, pct: a.pctPositive ?? 0 })}
                                </span>
                              </li>
                            ))}
                          </ul>
                        </td>
                      </tr>
                    )}
                  </Fragment>
                );
              })}
            </tbody>
          </table>
        </div>
        <ListPager pager={pager} noun={t('pager.noun.buildings')} />
      </RunSurface>
    </>
  );
}
