// Quality hub — the QC surface, mounted at /inspections (route kept so the variance
// "Assign QC" deep-link keeps working). Four tabs: Inspections (scored records with a
// frozen template snapshot), Checklists, Work Orders (the client-raised ticketing
// queue — see components/WorkOrdersPanel), and the versioned Templates that drive
// inspections/checklists. Records/checklists/templates are component-local projections
// (useState), never the blob. Photos + the shareable report reuse account_media.
import { useCallback, useEffect, useMemo, useState } from 'react';
import { useSearchParams } from 'react-router-dom';
import Badge from '../components/Badge';
import Icon from '../components/Icon';
import EmptyState from '../components/EmptyState';
import StatCard from '../components/StatCard';
import InspectionTemplateEditor from '../components/InspectionTemplateEditor';
import InspectionFill from '../components/InspectionFill';
import InspectionReportModal from '../components/InspectionReportModal';
import ChecklistFill from '../components/ChecklistFill';
import ChecklistAssignmentsModal from '../components/ChecklistAssignmentsModal';
import ConfirmDialog from '../components/ConfirmDialog';
import WorkOrdersPanel from '../components/WorkOrdersPanel';
import FilterBar from '../components/filters/FilterBar';
import { useUrlFilters } from '../hooks/useUrlFilters';
import { inspectionFilterSpecs, inspectionListQuery } from '../lib/filters/inspectionFilters';
import { usePermission } from '../hooks/usePermission';
import { useToast } from '../components/Toast';
import { useStore, useDispatch } from '../store';
import { ACTIONS } from '../store/reducer';
import { useAuth } from '../hooks/useAuth';
import { selectSiteById, selectClientById, selectUserById, selectActiveUsers, selectInspectionFollowUp } from '../store/selectors';
import { fmtDate, todayKey, getOrgTimezone } from '../lib/dates';
import { resultBadgeVariant, resultLabel } from '../lib/inspections';
import * as qcApi from '../lib/qcApi';
import { usePagedRows } from '../hooks/usePagedRows';
import ListPager from '../components/ListPager';
import { canRetryError, csvCell } from './reports/reportKit';

const EMPTY = [];

// The Inspections tab's two reads, each tagged with the filter key it answers, so a
// response for an earlier filter is never shown under a later one.
const LIST_LOADING = { key: null, rows: null, truncated: false, error: null };
const FIGURES_LOADING = { key: null, data: null, error: null };

// CSV of EVERY inspection the filters match (qcApi.exportInspections, a complete read) —
// it used to write the list, which holds only the newest 200. Dates are the org's wall
// clock (not the device's), and a text cell a spreadsheet would run as a formula is
// defused (reportKit csvCell).
function downloadInspectionsCsv(rows, labelFns) {
  const { siteLabel, clientLabel } = labelFns;
  const head = ['Date', 'Location', 'Template', 'Score', 'Result', 'Inspector'];
  const esc = (v) => `"${csvCell(v).replace(/"/g, '""')}"`;
  const lines = [head.join(',')];
  for (const r of rows) {
    lines.push([
      r.performed_at ? new Date(r.performed_at).toLocaleString(undefined, { timeZone: getOrgTimezone() }) : '',
      clientLabel(r) || siteLabel(r), r.template_name || '',
      r.overall_score != null ? `${r.overall_score}%` : '', resultLabel(r.result), r.inspector_name || '',
    ].map(esc).join(','));
  }
  const blob = new Blob([lines.join('\n')], { type: 'text/csv;charset=utf-8' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url; a.download = `inspections-${todayKey()}.csv`;
  a.click();
  URL.revokeObjectURL(url);
}

export default function Inspections() {
  const state = useStore();
  const dispatch = useDispatch();
  const toast = useToast();
  const { currentUser } = useAuth();
  const canInspect = usePermission('qc.inspect');
  const canExport = usePermission('qc.share'); // sharing/export is a manager capability (see qc.share)
  const canFollowUp = usePermission('qc.inspect'); // assigning a follow-up is a manager (inspect) capability
  const canFillChecklist = usePermission('qc.checklist.perform'); // crew-inclusive — completing checklists is a core crew task (#8)
  const canEditTpl = usePermission('qc.templates.edit');
  const canShare = usePermission('qc.share');
  const canManageProblems = usePermission('problems.manage');
  const canEditOps = usePermission('ops.edit'); // gates the master checklist-assignments organizer (same write path as Service Setup)

  // Crew can't run inspections (qc.inspect is manager-only) — their QC task is
  // checklists — so land them on Checklists instead of the view-only Inspections tab
  // whose empty-state CTA ("New inspection") they can't act on (crew audit C2).
  const [tab, setTab] = useState(() => (!canInspect && canFillChecklist ? 'checklists' : 'records'));
  const [list, setList] = useState(LIST_LOADING);
  const [figures, setFigures] = useState(FIGURES_LOADING);
  const [listReload, setListReload] = useState(0);
  const [figuresReload, setFiguresReload] = useState(0);
  const [exporting, setExporting] = useState(false);
  const [checklists, setChecklists] = useState(null);
  const [templates, setTemplates] = useState(null);
  const [fillOpen, setFillOpen] = useState(false);
  const [reportId, setReportId] = useState(null); // inspection whose report modal is open
  const [checklistOpen, setChecklistOpen] = useState(false);
  const [assignmentsOpen, setAssignmentsOpen] = useState(false);
  const [deleteTpl, setDeleteTpl] = useState(null); // template pending hard-delete confirm
  const [editorTpl, setEditorTpl] = useState(undefined); // undefined = closed, null = new, id = edit
  const [prefillSite, setPrefillSite] = useState('');
  const [searchParams, setSearchParams] = useSearchParams();

  // URL-persisted facet filters for the records tab (same engine as Variance/Schedule).
  // They run in the SERVER read (lib/filters/inspectionFilters inspectionListQuery): the
  // list is the newest 200 inspections that MATCH, the stat cards tally every match, and
  // Export CSV writes every match. They used to filter the org's newest 200 in the
  // browser, so past 200 a location's, an inspector's or an older range's inspections
  // fell out of all three (UI_RULES §117). The reads key on the values, so an unrelated
  // URL change (?tab=, a deep-link) doesn't refetch.
  const filters = useUrlFilters(inspectionFilterSpecs);
  const filterCtx = useMemo(() => ({ state, user: currentUser }), [state, currentUser]);
  const filtersKey = JSON.stringify(filters.values);
  const rangeError = useMemo(() => inspectionListQuery(JSON.parse(filtersKey)).error || null, [filtersKey]);
  const recordsOpen = tab === 'records';

  // The list and the figures load while the Inspections tab is open (a crew member lands on
  // Checklists, and a work-order deep-link never needs them), again on every filter change,
  // and fresh each time the tab is reopened; a response for an older filter is dropped.
  useEffect(() => {
    if (!recordsOpen) return undefined;
    const query = inspectionListQuery(JSON.parse(filtersKey));
    if (query.error) return undefined;
    let alive = true;
    qcApi.listInspections(query.filters)
      .then((r) => { if (alive) setList({ key: filtersKey, rows: r.inspections, truncated: r.truncated, error: null }); })
      .catch((e) => { if (alive) setList({ key: filtersKey, rows: null, truncated: false, error: e }); });
    return () => { alive = false; };
  }, [recordsOpen, filtersKey, listReload]);
  useEffect(() => {
    if (!recordsOpen) return undefined;
    const query = inspectionListQuery(JSON.parse(filtersKey));
    if (query.error) return undefined;
    let alive = true;
    qcApi.inspectionFigures(query.filters)
      .then((f) => { if (alive) setFigures({ key: filtersKey, data: f, error: null }); })
      .catch((e) => { if (alive) setFigures({ key: filtersKey, data: null, error: e }); });
    return () => { alive = false; };
  }, [recordsOpen, filtersKey, figuresReload]);
  const retryList = () => { setList(LIST_LOADING); setListReload((k) => k + 1); };
  const retryFigures = () => { setFigures(FIGURES_LOADING); setFiguresReload((k) => k + 1); };
  const reloadRecords = () => { setListReload((k) => k + 1); setFiguresReload((k) => k + 1); };

  // What the tab shows for the CURRENT filters: anything answered for other ones reads as
  // loading. `records` is null while loading and after a failed read.
  const shownList = list.key === filtersKey ? list : LIST_LOADING;
  const records = shownList.rows;
  const shownFigures = figures.key === filtersKey ? figures : FIGURES_LOADING;
  const fig = shownFigures.data;
  // The total behind a capped list, once the figures have it (read separately, so churn
  // between the two reads must not print "the newest 200 of 200").
  const matchTotal = fig && records && fig.total > records.length ? fig.total : null;

  const followUpUsers = useMemo(() => selectActiveUsers(state), [state]);
  const setFollowUp = (inspectionId, patch) => dispatch({ type: ACTIONS.SET_INSPECTION_FOLLOWUP, inspectionId, ...patch });

  // One pager per tab (all declared unconditionally — only one tab renders at a
  // time, but hooks can't be conditional). Local mode: the tab itself isn't
  // URL-backed. The StatCards and the CSV export don't read the list at all (their own
  // complete reads), and every empty-state guard reads the full list.
  const recordsPager = usePagedRows(records || EMPTY, { resetKey: filtersKey });
  const checklistsPager = usePagedRows(checklists || EMPTY);
  const templatesPager = usePagedRows(templates || EMPTY);

  // Deep-links, consumed whenever they appear (on mount AND when a later navigation, e.g.
  // global search while already on this page, adds them), then stripped from the URL:
  //   ?tab=<records|checklists|workorders|templates>  — land on a specific tab (e.g. the
  //      Dashboard "Open Complaints" tile → ?tab=workorders).
  //   ?fill=1&siteId=…  — open a new inspection (qc.inspect; managers).
  //   ?checklist=1      — open a new checklist (qc.checklist.perform; crew-inclusive).
  // Each flow is gated on the viewer's own permission, so a deep-link can't open a form the
  // viewer could not open from the page's own button.
  useEffect(() => {
    const next = new URLSearchParams(searchParams);
    let changed = false;
    const wantTab = searchParams.get('tab');
    if (wantTab && ['records', 'checklists', 'workorders', 'templates'].includes(wantTab)) {
      setTab(wantTab);
      next.delete('tab'); changed = true;
    }
    if (searchParams.get('fill') === '1') {
      if (canInspect) {
        setPrefillSite(searchParams.get('siteId') || '');
        setTab('records'); // the new-inspection flow always lands on Inspections
        setFillOpen(true);
      }
      next.delete('fill'); next.delete('siteId'); changed = true;
    }
    if (searchParams.get('checklist') === '1') {
      if (canFillChecklist) {
        setTab('checklists');
        setChecklistOpen(true);
      }
      next.delete('checklist'); changed = true;
    }
    if (changed) setSearchParams(next, { replace: true });
  }, [searchParams, setSearchParams, canInspect, canFillChecklist]);

  const loadChecklists = useCallback(async () => { try { setChecklists(await qcApi.listChecklists({})); } catch (e) { toast.error(e.message || 'Could not load checklists'); setChecklists([]); } }, [toast]);
  const loadTemplates = useCallback(async () => { try { setTemplates(await qcApi.listTemplates({})); } catch (e) { toast.error(e.message || 'Could not load templates'); setTemplates([]); } }, [toast]);
  useEffect(() => { loadChecklists(); loadTemplates(); }, [loadChecklists, loadTemplates]);

  const publish = async (id) => { try { await qcApi.publishTemplate(id); toast.success('Template published'); loadTemplates(); } catch (e) { toast.error(e.message || 'Publish failed'); } };
  // Hard delete (no archive): remove the template, scrub it from every cleaner's
  // assignment, refresh. Completed records keep their own snapshot. Since R3 there is no
  // location-wide default, so the per-cleaner map is the only binding to count.
  const templateUsage = (id) => (state.clients || []).reduce((n, c) => (
    c.crewChecklists && Object.values(c.crewChecklists).includes(id) ? n + 1 : n
  ), 0);
  const doDeleteTemplate = async (t) => {
    try {
      await qcApi.deleteTemplate(t.id);
      dispatch({ type: ACTIONS.SCRUB_CHECKLIST_TEMPLATE, templateId: t.id });
      toast.success('Template deleted');
      loadTemplates();
    } catch (e) { toast.error(e.message || 'Delete failed'); }
  };

  const siteLabel = (r) => r.site_name || (r.site_id ? selectSiteById(state, r.site_id)?.name : null) || '—';
  const clientLabel = (r) => r.client_name || (r.client_id ? selectClientById(state, r.client_id)?.name : null) || '';
  // Who completed it comes from the ROSTER: checklist_results stores only the user id
  // (CS-403 — there is no name column).
  const byLabel = (r) => (r.completed_by_user_id ? selectUserById(state, r.completed_by_user_id)?.name : null) || '—';

  // Export CSV writes EVERY inspection the filters match (a complete, paged read), not the
  // rows on screen; a read that can't complete is an error toast, never a partial file.
  const exportCsv = async () => {
    const query = inspectionListQuery(JSON.parse(filtersKey));
    if (query.error || exporting) return;
    setExporting(true);
    try {
      downloadInspectionsCsv(await qcApi.exportInspections(query.filters), { siteLabel, clientLabel });
    } catch (e) {
      toast.error(e.message || 'Could not export inspections');
    } finally {
      setExporting(false);
    }
  };

  return (
    <div className="page">
      <div className="page-head" style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', flexWrap: 'wrap', gap: 12 }}>
        <div>
          <h1>Quality</h1>
          <p className="page-sub">Inspections, checklists, work orders, and the templates that drive them.</p>
        </div>
        <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
          {tab === 'records' && canExport && !rangeError && (records?.length > 0) && (
            <button className="btn btn-success" onClick={exportCsv} disabled={exporting}><Icon name="upload" size={15} /> {exporting ? 'Exporting…' : 'Export CSV'}</button>
          )}
          {tab === 'records' && canInspect && <button className="btn btn-primary" onClick={() => { setPrefillSite(''); setFillOpen(true); }}>New inspection</button>}
          {tab === 'checklists' && canFillChecklist && <button className="btn btn-primary" onClick={() => setChecklistOpen(true)}>New checklist</button>}
          {tab === 'checklists' && canEditOps && <button className="btn btn-outline" onClick={() => setAssignmentsOpen(true)}>Checklist assignments</button>}
          {tab !== 'workorders' && canEditTpl && <button className="btn btn-success" onClick={() => setEditorTpl(null)}>New template</button>}
        </div>
      </div>

      <div className="tab-container-line" role="group" aria-label="View">
        <button type="button" className={`tab-btn ${tab === 'records' ? 'active' : ''}`} onClick={() => setTab('records')}>Inspections</button>
        <button type="button" className={`tab-btn ${tab === 'checklists' ? 'active' : ''}`} onClick={() => setTab('checklists')}>Checklists</button>
        {canManageProblems && <button type="button" className={`tab-btn ${tab === 'workorders' ? 'active' : ''}`} onClick={() => setTab('workorders')}>Work Orders</button>}
        <button type="button" className={`tab-btn ${tab === 'templates' ? 'active' : ''}`} onClick={() => setTab('templates')}>Templates</button>
      </div>

      {tab === 'records' ? (
        <>
          <FilterBar
            specs={inspectionFilterSpecs}
            values={filters.values}
            setValue={filters.setValue}
            clearAll={filters.clearAll}
            activeCount={filters.activeCount}
            ctx={filterCtx}
          />
          {/* The figures cover EVERY match (qcApi.inspectionFigures, tallied server-side),
              never just the newest 200 the list holds. "—" until they load; a failed read
              says so with Try again, never zeros. "Scored": the count and the average are
              over submitted, scored inspections, while the list also holds drafts. */}
          {!rangeError && records?.length > 0 && (shownFigures.error ? (
            <div className="callout callout-danger insp-figures-error" role="alert">
              <span className="text-sm">Couldn’t load the figures. {shownFigures.error.message || 'Check your connection and try again.'}</span>
              {canRetryError(shownFigures.error) && <button type="button" className="btn btn-primary" onClick={retryFigures}>Try again</button>}
            </div>
          ) : (
            <div className="stat-grid variance-stats">
              <StatCard label="Scored inspections" value={fig ? fig.count : '—'} />
              <StatCard label="Avg score" value={fig?.avgScore != null ? `${fig.avgScore}%` : '—'}
                trend={fig?.delta != null && fig.delta !== 0 ? `${fig.delta > 0 ? '+' : '−'}${Math.abs(fig.delta)} pts` : null}
                trendDirection={fig?.delta >= 0 ? 'up' : 'down'} />
              <StatCard label="Failed / follow-up" value={fig ? fig.failCount : '—'} />
            </div>
          ))}
          {/* Capped: said in visible text above the list (a tooltip never shows on a phone),
              with how many match once the figures know (UI_RULES §117). The figures and
              the export are complete, so this scopes the list alone. */}
          {!rangeError && shownList.truncated && records && (
            <p className="text-sm text-muted insp-cap-note">
              {matchTotal != null
                ? `Showing the newest ${records.length} of ${matchTotal.toLocaleString()} inspections. The figures above${canExport ? ' and Export CSV' : ''} cover all ${matchTotal.toLocaleString()}; narrow the filters to list older ones.`
                : `Showing the newest ${records.length} inspections; narrow the filters to list older ones.`}
            </p>
          )}
          <div className="table-wrap mobile-stack">
            <table>
              <thead><tr><th>Location</th><th>Template</th><th>Score</th><th>Result</th><th>Inspector</th><th>Date</th><th>Follow-up</th><th></th></tr></thead>
              <tbody>
                {rangeError ? (
                  <tr className="stack-plain"><td colSpan={8}><EmptyState icon={<Icon name="schedule" size={28} />} title="Check the dates" message={rangeError} /></td></tr>
                ) : shownList.error ? (
                  <tr className="stack-plain"><td colSpan={8}><EmptyState icon={<Icon name="warning" size={28} />} title="Couldn’t load inspections" message={shownList.error.message || 'Check your connection and try again.'} action={canRetryError(shownList.error) ? <button type="button" className="btn btn-primary" onClick={retryList}>Try again</button> : null} /></td></tr>
                ) : records === null ? (
                  <tr className="stack-plain"><td colSpan={8} style={{ padding: 20 }}>Loading…</td></tr>
                ) : records.length === 0 ? (
                  <tr className="stack-plain"><td colSpan={8}><EmptyState icon={<Icon name="check" size={28} />} title={filters.activeCount === 0 ? 'No inspections yet' : 'No inspections match'} message={filters.activeCount === 0 ? 'Click “New inspection” to perform one against a published template.' : 'Adjust or clear the filters to see more.'} /></td></tr>
                ) : (
                  recordsPager.pageRows.map((r) => {
                    const needsFollowUp = r.result === 'fail' || r.result === 'needs_follow_up';
                    const fu = needsFollowUp ? selectInspectionFollowUp(state, r.id) : null;
                    return (
                      <tr key={r.id}>
                        <td className="cell-primary"><span className="truncate" title={clientLabel(r) || siteLabel(r)}>{clientLabel(r) || siteLabel(r)}</span></td>
                        <td data-label="Template"><span className="truncate" title={r.template_name || ''}>{r.template_name || '—'}</span></td>
                        <td data-label="Score">{r.overall_score != null ? `${r.overall_score}%` : <span className="text-muted">—</span>}</td>
                        <td data-label="Result">{r.result ? <Badge variant={resultBadgeVariant(r.result)}>{resultLabel(r.result)}</Badge> : <span className="text-muted">Draft</span>}</td>
                        <td data-label="Inspector"><span className="truncate" title={r.inspector_name || ''}>{r.inspector_name || '—'}</span></td>
                        <td data-label="Date" style={{ whiteSpace: 'nowrap' }}>{r.performed_at ? fmtDate(r.performed_at) : '—'}</td>
                        <td data-label="Follow-up">
                          {!needsFollowUp ? (
                            <span className="text-muted text-xs">—</span>
                          ) : canFollowUp ? (
                            <div className="insp-followup">
                              <select className="input" aria-label="Assign follow-up" value={fu?.assigneeUserId || ''} onChange={(e) => setFollowUp(r.id, { assigneeUserId: e.target.value || null })}>
                                <option value="">Unassigned</option>
                                {followUpUsers.map((u) => <option key={u.id} value={u.id}>{u.name}</option>)}
                              </select>
                              <label className="insp-followup-done">
                                <input type="checkbox" checked={!!fu?.done} onChange={(e) => setFollowUp(r.id, { done: e.target.checked })} />
                                <span>Done</span>
                              </label>
                            </div>
                          ) : (
                            <Badge variant={fu?.done ? 'green' : 'amber'}>{fu?.done ? 'Resolved' : (fu?.assigneeUserId ? `Assigned: ${selectUserById(state, fu.assigneeUserId)?.name || '—'}` : 'Needs follow-up')}</Badge>
                          )}
                        </td>
                        <td className="cell-actions" style={{ textAlign: 'right', whiteSpace: 'nowrap' }}>
                          {r.status === 'submitted' && (
                            <button className="btn btn-link btn-sm" onClick={() => setReportId(r.id)}>View report</button>
                          )}
                          {canShare && r.status === 'submitted' && r.public_token && (
                            <button className="btn btn-link btn-sm" onClick={() => { navigator.clipboard?.writeText(`${window.location.origin}/inspect/${r.public_token}`); toast.success('Share link copied'); }}>Copy link</button>
                          )}
                        </td>
                      </tr>
                    );
                  })
                )}
              </tbody>
            </table>
            <ListPager pager={recordsPager} noun="inspections" />
          </div>
        </>
      ) : tab === 'checklists' ? (
        <div className="table-wrap mobile-stack">
          <table>
            <thead><tr><th>Location</th><th>Checklist</th><th>Completed</th><th>By</th><th>Date</th></tr></thead>
            <tbody>
              {checklists === null ? (
                <tr className="stack-plain"><td colSpan={5} style={{ padding: 20 }}>Loading…</td></tr>
              ) : checklists.length === 0 ? (
                <tr className="stack-plain"><td colSpan={5}><EmptyState icon={<Icon name="check" size={28} />} title="No checklists yet" message="Click “New checklist” to complete one against a published checklist template." /></td></tr>
              ) : (
                checklistsPager.pageRows.map((c) => (
                  <tr key={c.id}>
                    <td className="cell-primary"><span className="truncate" title={clientLabel(c) || siteLabel(c)}>{clientLabel(c) || siteLabel(c)}</span></td>
                    <td data-label="Checklist"><span className="truncate" title={c.template_snapshot?.name || ''}>{c.template_snapshot?.name || '—'}</span></td>
                    <td data-label="Completed">{c.completed_count}/{c.total_count}</td>
                    <td data-label="By"><span className="truncate" title={byLabel(c)}>{byLabel(c)}</span></td>
                    <td data-label="Date" style={{ whiteSpace: 'nowrap' }}>{c.performed_at ? fmtDate(c.performed_at) : '—'}</td>
                  </tr>
                ))
              )}
            </tbody>
          </table>
          <ListPager pager={checklistsPager} noun="checklists" />
        </div>
      ) : tab === 'workorders' ? (
        <WorkOrdersPanel canManage={canManageProblems} />
      ) : (
        <div className="table-wrap mobile-stack">
          <table>
            <thead><tr><th>Name</th><th>Type</th><th>Status</th><th>Updated</th><th></th></tr></thead>
            <tbody>
              {templates === null ? (
                <tr className="stack-plain"><td colSpan={5} style={{ padding: 20 }}>Loading…</td></tr>
              ) : templates.length === 0 ? (
                <tr className="stack-plain"><td colSpan={5}><EmptyState icon={<Icon name="forms" size={28} />} title="No templates yet" message={canEditTpl ? 'Click “New template” to build one.' : 'No inspection templates have been created.'} /></td></tr>
              ) : (
                templatesPager.pageRows.map((t) => (
                  <tr key={t.id}>
                    <td className="cell-primary" style={{ fontWeight: 600 }}><span className="truncate" title={t.name}>{t.name}</span></td>
                    <td data-label="Type" style={{ textTransform: 'capitalize' }}>{t.kind}</td>
                    <td data-label="Status">{t.is_published ? <Badge variant="green">Published</Badge> : <Badge variant="slate">Draft</Badge>}</td>
                    <td data-label="Updated" style={{ whiteSpace: 'nowrap' }}>{fmtDate(t.updated_at)}</td>
                    <td className="cell-actions" style={{ textAlign: 'right', whiteSpace: 'nowrap' }}>
                      {canEditTpl && <button className="btn btn-link btn-sm" onClick={() => setEditorTpl(t.id)}>Edit</button>}
                      {canEditTpl && !t.is_published && <button className="btn btn-link btn-sm" onClick={() => publish(t.id)}>Publish</button>}
                      {canEditTpl && <button className="btn btn-link btn-sm" onClick={() => setDeleteTpl(t)}>Delete</button>}
                    </td>
                  </tr>
                ))
              )}
            </tbody>
          </table>
          <ListPager pager={templatesPager} noun="templates" />
        </div>
      )}

      <InspectionFill open={fillOpen} presetSiteId={prefillSite} onClose={() => setFillOpen(false)} onSubmitted={() => { setFillOpen(false); reloadRecords(); }} />
      <InspectionReportModal open={!!reportId} inspectionId={reportId} onClose={() => setReportId(null)} />
      <ChecklistFill open={checklistOpen} onClose={() => setChecklistOpen(false)} onSubmitted={() => { setChecklistOpen(false); loadChecklists(); }} />
      <InspectionTemplateEditor open={editorTpl !== undefined} templateId={editorTpl || null} onClose={() => setEditorTpl(undefined)} onSaved={() => { setEditorTpl(undefined); loadTemplates(); }} />
      <ChecklistAssignmentsModal open={assignmentsOpen} onClose={() => setAssignmentsOpen(false)} canEdit={canEditOps} />
      <ConfirmDialog
        open={!!deleteTpl}
        title="Delete template?"
        message={deleteTpl
          ? `Delete “${deleteTpl.name}”? This can’t be undone.${templateUsage(deleteTpl.id) ? ` It’s assigned to ${templateUsage(deleteTpl.id)} customer${templateUsage(deleteTpl.id) > 1 ? 's' : ''} — those assignments will be removed.` : ''} Completed checklists keep their record.`
          : ''}
        confirmLabel="Delete template"
        variant="danger"
        onConfirm={() => deleteTpl && doDeleteTemplate(deleteTpl)}
        onClose={() => setDeleteTpl(null)}
      />
    </div>
  );
}
