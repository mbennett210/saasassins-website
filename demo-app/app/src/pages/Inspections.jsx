// Quality hub — the QC surface, mounted at /inspections (route kept so the variance
// "Assign QC" deep-link keeps working). Five tabs: Inspections (scored records with a
// frozen template snapshot), Checklists, Assignments (who holds which checklist where —
// see components/checklists/ChecklistAssignments; `ops.edit` only), Work Orders (the
// client-raised ticketing queue — see components/WorkOrdersPanel), and the versioned
// Templates that drive inspections/checklists. Records/checklists/templates are
// component-local projections (useState), never the blob. Photos + the shareable report
// reuse account_media.
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
import ChecklistResultModal from '../components/ChecklistResultModal';
import ChecklistAssignments from '../components/checklists/ChecklistAssignments';
import ConfirmDialog from '../components/ConfirmDialog';
import FilterSelect from '../components/FilterSelect';
import WorkOrdersPanel from '../components/WorkOrdersPanel';
import FilterBar from '../components/filters/FilterBar';
import { useUrlFilters } from '../hooks/useUrlFilters';
import { inspectionFilterSpecs, inspectionListQuery } from '../lib/filters/inspectionFilters';
import { templateFilterSpecs, TEMPLATE_STARTERS } from '../lib/filters/templateFilters';
import { applyFilters } from '../lib/filters/applyFilters';
import { usePermission } from '../hooks/usePermission';
import { useToast } from '../components/Toast';
import { useStore, useDispatch } from '../store';
import { ACTIONS } from '../store/reducer';
import { useAuth } from '../hooks/useAuth';
import { selectSiteById, selectClientById, selectUserById, selectActiveClients, selectInspectionFollowUp } from '../store/selectors';
import { SUPERVISOR_ROLES } from '../lib/roles';
import { personOptions } from '../lib/pickerOptions';
import { fmtDate, fmtTime, todayKey, getOrgTimezone } from '../lib/dates';
import { resultBadgeVariant, resultLabel } from '../lib/inspections';
import { mayWorkDraft, DRAFT_STATUS } from '../lib/inspectionDrafts';
import { useT } from '../i18n/react';
import { errorText } from '../i18n/errors';
import { isChecklistComplete } from '../lib/crewChecklist';
import { notCompletedCountOf } from '../lib/checklistResultView';
import * as qcApi from '../lib/qcApi';
import { appLink } from '../lib/appLink'; // a shared link: the app's own address
import { usePagedRows } from '../hooks/usePagedRows';
import ListPager from '../components/ListPager';
import { canRetryError, csvCell } from './reports/reportKit';

const EMPTY = [];

// The hub's tabs, in the order they render. ONE list: the tab bar maps it, `?tab=` is
// validated against it, and the master-search registry carries an entry per non-default
// tab (lint:search reconciles those).
const TAB_KEYS = ['records', 'checklists', 'assignments', 'workorders', 'templates'];

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
  const canEditOps = usePermission('ops.edit'); // gates the Assignments tab (same write path as Service setup)

  const [list, setList] = useState(LIST_LOADING);
  const [figures, setFigures] = useState(FIGURES_LOADING);
  const [listReload, setListReload] = useState(0);
  const [figuresReload, setFiguresReload] = useState(0);
  const [exporting, setExporting] = useState(false);
  const [checklists, setChecklists] = useState(null);
  // The list is the newest CHECKLIST_LIST_LIMIT; how many there are in all (CS-335).
  const [checklistTotals, setChecklistTotals] = useState({ total: 0, truncated: false });
  const [templates, setTemplates] = useState(null);
  const [fillOpen, setFillOpen] = useState(false);
  const [reportId, setReportId] = useState(null); // inspection whose report modal is open
  const [checklistOpen, setChecklistOpen] = useState(false);
  const [resultRow, setResultRow] = useState(null); // submitted checklist whose result pop-up is open
  const [deleteTpl, setDeleteTpl] = useState(null); // template pending hard-delete confirm
  const [editorTpl, setEditorTpl] = useState(undefined); // undefined = closed, null = new, id = edit
  const [prefillSite, setPrefillSite] = useState('');
  // `?templateId=` (the New Inspection form, 2026-10-09): with a building too, the form opens
  // straight onto that template's list.
  const [prefillTemplate, setPrefillTemplate] = useState('');
  // An inspection LEFT OPEN to finish later (Matt, 2026-10-06; lib/inspectionDrafts): the draft
  // the form reopens (Continue), and the one waiting on Discard's confirm. New words on this
  // not-yet-converted screen come from the catalog (UI_RULES §140).
  const t = useT();
  // CS-669: the Templates list's "unpublished changes" badge (read here: the list's rows are `t`).
  const unpublishedLabel = t('tplList.unpublishedChanges');
  const [resumeId, setResumeId] = useState('');
  const [discardRow, setDiscardRow] = useState(null);
  const [searchParams, setSearchParams] = useSearchParams();

  // ── The open tab is URL STATE (`?tab=`), not component state ───────────────
  // It was born as a ONE-SHOT deep link (6840f04, 2026-09-19) so the Dashboard's Open
  // Complaints tile could land on Work Orders: read once, then stripped, copying the
  // `?fill=1` / `?checklist=1` shape. But those two OPEN A FORM, and a reload must not
  // reopen it — a tab is not a modal. Stripping it meant a copied link never came back to
  // the tab you were on, and once Assignments kept real state in the URL (?view / ?q / ?f
  // / ?customer / ?cleaner) a shared link restored that state onto the WRONG tab. So the
  // tab now lives in the URL, written with replace:true like every other list filter
  // (CLAUDE.md nav conventions) so tab clicks don't stack history entries.
  //
  // The DEFAULT tab is left OUT of the URL (the `useTableSearch` contract: drop the param
  // when it carries nothing), and it depends on the viewer: crew can't run inspections
  // (qc.inspect is manager-only) — their QC task is checklists — so they land on
  // Checklists instead of the view-only Inspections tab whose empty-state CTA ("New
  // inspection") they can't act on (crew audit C2).
  const defaultTab = !canInspect && canFillChecklist ? 'checklists' : 'records';
  // A tab the page gates tighter than the route falls back to the default rather than
  // rendering nothing: a stale link, or one shared by someone with more permission, must
  // not land on a blank panel.
  const tabAllowed = useCallback((t) => (
    t === 'assignments' ? canEditOps : t === 'workorders' ? canManageProblems : TAB_KEYS.includes(t)
  ), [canEditOps, canManageProblems]);
  const wantTab = searchParams.get('tab');
  const tab = TAB_KEYS.includes(wantTab) && tabAllowed(wantTab) ? wantTab : defaultTab;
  const setTab = useCallback((t) => setSearchParams((prev) => {
    const next = new URLSearchParams(prev);
    if (t && t !== defaultTab) next.set('tab', t); else next.delete('tab');
    return next;
  }, { replace: true }), [setSearchParams, defaultTab]);

  // URL-persisted facet filters for the records tab (same engine as Variance/Schedule).
  // They run in the SERVER read (lib/filters/inspectionFilters inspectionListQuery): the
  // list is the newest 200 inspections that MATCH, the stat cards tally every match, and
  // Export CSV writes every match. They used to filter the org's newest 200 in the
  // browser, so past 200 a location's, an inspector's or an older range's inspections
  // fell out of all three (UI_RULES §117). The reads key on the values, so an unrelated
  // URL change (?tab=, a deep-link) doesn't refetch.
  const filters = useUrlFilters(inspectionFilterSpecs);
  const filterCtx = useMemo(() => ({ state, user: currentUser }), [state, currentUser]);

  // The Templates tab's own Customer facet (R2, plan step 5) — the SAME URL-filter engine,
  // on its own key (`cust`) so it can't collide with the records facets. The templates list
  // is a complete client-side read, so this one filters in the browser through the shared
  // applyFilters, with the same rule the server query uses (lib/filters/templateFilters).
  const tplFilters = useUrlFilters(templateFilterSpecs);
  const customers = useMemo(
    () => [...(selectActiveClients(state) || [])].sort((a, b) => (a.name || '').localeCompare(b.name || '')),
    [state],
  );
  const tplFilterCtx = useMemo(() => ({ customers }), [customers]);
  // A checklist names its customer; a starter names none; an inspection template is
  // company-wide — "All customers", not a dash, because it is not MISSING a customer.
  const templateCustomer = useCallback((t) => {
    if (t.kind !== 'checklist') return 'All customers';
    if (!t.client_id) return 'Starter';
    return selectClientById(state, t.client_id)?.name || t.client_id;
  }, [state]);
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

  // The office follows up a failed inspection (CS-724): owners, admins and managers by name, in the
  // capped searchable picker — never a native select of every login on each failed row (1,541
  // options a row, 28,427 nodes for 20 rows at Matt's size). Someone assigned before, who is no
  // longer in the office list, stays named on their row (followUpOptionsFor), right under
  // "Unassigned", so the picker never shows a row as unassigned when it is not. Its menu floats
  // (FilterSelect `float`): the table's scroller would cut it off on a bottom row.
  const followUpOptions = useMemo(() => [
    { value: '', label: t('inspections.followUp.unassigned') },
    ...personOptions(state.users, { roles: SUPERVISOR_ROLES }),
  ], [state.users, t]);
  const followUpOptionsFor = (assigneeId) => {
    if (!assigneeId || followUpOptions.some((o) => o.value === assigneeId)) return followUpOptions;
    const name = selectUserById(state, assigneeId)?.name || '—';
    return [followUpOptions[0], { value: assigneeId, label: name }, ...followUpOptions.slice(1)];
  };
  const setFollowUp = (inspectionId, patch) => dispatch({ type: ACTIONS.SET_INSPECTION_FOLLOWUP, inspectionId, ...patch });

  // One pager per tab (all declared unconditionally — only one tab renders at a
  // time, but hooks can't be conditional). Local mode: the tab itself isn't
  // URL-backed. The StatCards and the CSV export don't read the list at all (their own
  // complete reads), and every empty-state guard reads the full list.
  const recordsPager = usePagedRows(records || EMPTY, { resetKey: filtersKey });
  const checklistsPager = usePagedRows(checklists || EMPTY);
  // The Customer facet narrows the complete list in the browser (it is one read of every
  // template, not a server query), and the pager resets to page 1 when it changes.
  const tplKey = JSON.stringify(tplFilters.values);
  const shownTemplates = useMemo(
    () => (templates ? applyFilters(templates, JSON.parse(tplKey), templateFilterSpecs, tplFilterCtx) : null),
    [templates, tplKey, tplFilterCtx],
  );
  const templatesPager = usePagedRows(shownTemplates || EMPTY, { resetKey: tplKey });

  // Deep-links, consumed whenever they appear (on mount AND when a later navigation, e.g.
  // global search while already on this page, adds them), then stripped from the URL:
  //   ?fill=1&siteId=…&templateId=…  — open a new inspection (qc.inspect; managers); with
  //                     both a building and a template it opens straight onto the list.
  //   ?checklist=1      — open a new checklist (qc.checklist.perform; crew-inclusive).
  // Both OPEN A FORM, so they are consumed once: a reload must not reopen it. Each is
  // gated on the viewer's own permission, so a deep-link can't open a form the viewer
  // could not open from the page's own button, and each also moves the tab — written
  // into the same URL change, because the tab is URL state now (see `setTab` above).
  // `?tab=` itself is NOT consumed here; it is the tab.
  useEffect(() => {
    const next = new URLSearchParams(searchParams);
    let changed = false;
    // Put the form's own tab in the SAME URL write that strips the one-shot param, so the
    // two never land as separate navigations (the second would drop the first).
    const land = (t) => { if (t === defaultTab) next.delete('tab'); else next.set('tab', t); };
    if (searchParams.get('fill') === '1') {
      if (canInspect) {
        setPrefillSite(searchParams.get('siteId') || '');
        setPrefillTemplate(searchParams.get('templateId') || '');
        setResumeId('');
        land('records'); // the new-inspection flow always lands on Inspections
        setFillOpen(true);
      }
      next.delete('fill'); next.delete('siteId'); next.delete('templateId'); changed = true;
    }
    if (searchParams.get('checklist') === '1') {
      if (canFillChecklist) {
        land('checklists');
        setChecklistOpen(true);
      }
      next.delete('checklist'); changed = true;
    }
    if (changed) setSearchParams(next, { replace: true });
  }, [searchParams, setSearchParams, canInspect, canFillChecklist, defaultTab]);

  const loadChecklists = useCallback(async () => {
    try {
      const r = await qcApi.listChecklistsNewest();
      setChecklists(r.checklists);
      setChecklistTotals({ total: r.total, truncated: r.truncated });
    } catch (e) {
      toast.error(e.message || 'Could not load checklists');
      setChecklists([]);
      setChecklistTotals({ total: 0, truncated: false });
    }
  }, [toast]);
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
  const byName = (r) => (r.completed_by_user_id ? selectUserById(state, r.completed_by_user_id)?.name : null) || null;
  const byLabel = (r) => byName(r) || '—';
  // A row's "View result" is one of up to 20 identical-looking buttons, so its accessible
  // name has to say WHICH result it opens (CS-549's lesson). The visible words lead it, so
  // a voice user can still say what they read (WCAG 2.5.3).
  //
  // It carries the CLEANER and the TIME, not just the day: two cleaners submit the same
  // checklist at the same customer on the same night whenever one covers for the other
  // (`lib/jobCover`), and checklist + customer + day alone gave them one name — less than
  // the visible row says, since the By column is right there.
  const resultActionLabel = (c) => ['View result', c.template_snapshot?.name, clientLabel(c) || siteLabel(c),
    byName(c), c.performed_at ? `${fmtDate(c.performed_at)} ${fmtTime(c.performed_at)}` : null]
    .filter(Boolean).join(' · ');

  // A DRAFT row (an inspection left open to finish later) offers Continue and Discard to whoever
  // may work it: the person who started it, or the office — the rule the server enforces
  // (lib/inspectionDrafts mayWorkDraft), so nobody is offered a button the server refuses (§118).
  const mayWork = (r) => canInspect && r.status === DRAFT_STATUS
    && mayWorkDraft({ role: currentUser?.role || null, userId: currentUser?.id || null }, r);
  const continueDraft = (r) => { setPrefillSite(''); setPrefillTemplate(''); setResumeId(r.id); setFillOpen(true); };
  const doDiscard = async (r) => {
    try {
      await qcApi.discardInspectionDraft(r.id);
      toast.success(t('inspectionFill.draft.discarded'));
    } catch (e) {
      toast.error(errorText(t, e, 'inspectionFill.draft.discardFailed', {
        'not-a-draft': 'inspectionFill.draft.notOpen', 'not-your-draft': 'inspectionFill.draft.notYours', 'not-found': 'inspectionFill.draft.gone',
      }));
    }
    reloadRecords();
  };

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
          {tab === 'records' && canInspect && <button className="btn btn-primary" onClick={() => { setPrefillSite(''); setPrefillTemplate(''); setResumeId(''); setFillOpen(true); }}>New inspection</button>}
          {tab === 'checklists' && canFillChecklist && <button className="btn btn-primary" onClick={() => setChecklistOpen(true)}>New checklist</button>}
          {tab !== 'workorders' && tab !== 'assignments' && canEditTpl && <button className="btn btn-success" onClick={() => setEditorTpl(null)}>New template</button>}
        </div>
      </div>

      <div className="tab-container-line" role="group" aria-label="View">
        <button type="button" className={`tab-btn ${tab === 'records' ? 'active' : ''}`} onClick={() => setTab('records')}>Inspections</button>
        <button type="button" className={`tab-btn ${tab === 'checklists' ? 'active' : ''}`} onClick={() => setTab('checklists')}>Checklists</button>
        {canEditOps && <button type="button" className={`tab-btn ${tab === 'assignments' ? 'active' : ''}`} onClick={() => setTab('assignments')}>Assignments</button>}
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
                    // An inspection LEFT OPEN to finish later: In progress, when it was started and
                    // how far it got — never a score (it has none until Submit).
                    const isDraft = r.status === DRAFT_STATUS;
                    const place = clientLabel(r) || siteLabel(r);
                    return (
                      <tr key={r.id}>
                        <td className="cell-primary"><span className="truncate" title={place}>{place}</span></td>
                        <td data-label="Template"><span className="truncate" title={r.template_name || ''}>{r.template_name || '—'}</span></td>
                        <td data-label="Score">{r.overall_score != null ? `${r.overall_score}%`
                          : isDraft && Number.isFinite(r.draft_total) ? <span className="text-muted text-xs">{t('inspectionFill.draft.answered', { done: r.draft_answered, total: r.draft_total })}</span>
                            : <span className="text-muted">—</span>}</td>
                        <td data-label="Result">{r.result ? <Badge variant={resultBadgeVariant(r.result)}>{resultLabel(r.result)}</Badge>
                          : isDraft ? <Badge variant="slate">{t('inspectionFill.draft.inProgress')}</Badge> : <span className="text-muted">—</span>}</td>
                        <td data-label="Inspector"><span className="truncate" title={r.inspector_name || ''}>{r.inspector_name || '—'}</span></td>
                        <td data-label="Date" style={{ whiteSpace: 'nowrap' }}>{isDraft && r.performed_at ? t('inspectionFill.draft.started', { at: r.performed_at }) : r.performed_at ? fmtDate(r.performed_at) : '—'}</td>
                        <td data-label="Follow-up">
                          {!needsFollowUp ? (
                            <span className="text-muted text-xs">—</span>
                          ) : canFollowUp ? (
                            <div className="insp-followup">
                              <FilterSelect
                                value={fu?.assigneeUserId || ''}
                                onChange={(v) => setFollowUp(r.id, { assigneeUserId: v || null })}
                                options={followUpOptionsFor(fu?.assigneeUserId)}
                                ariaLabel={t('inspections.followUp.assign')}
                                float
                              />
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
                          {mayWork(r) && (
                            <>
                              <button type="button" className="btn btn-link btn-sm" aria-label={t('inspectionFill.draft.continueAria', { place, at: r.performed_at })} onClick={() => continueDraft(r)}>{t('inspectionFill.draft.continue')}</button>
                              <button type="button" className="btn btn-link btn-sm" aria-label={t('inspectionFill.draft.discardAria', { place, at: r.performed_at })} onClick={() => setDiscardRow(r)}>{t('inspectionFill.draft.discard')}</button>
                            </>
                          )}
                          {canShare && r.status === 'submitted' && r.public_token && (
                            <button className="btn btn-link btn-sm" onClick={() => { navigator.clipboard?.writeText(appLink(`/inspect/${r.public_token}`)); toast.success('Share link copied'); }}>Copy link</button>
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
        <>
          {/* Capped (CS-335): the list holds the newest CHECKLIST_LIST_LIMIT, said in visible
              text above it with how many there are in all — the Inspections tab's treatment
              (UI_RULES §117). */}
          {checklistTotals.truncated && (
            <p className="text-sm text-muted insp-cap-note">{t('checklistList.capped', { shown: checklists.length, total: checklistTotals.total })}</p>
          )}
          <div className="table-wrap mobile-stack">
            <table>
              <thead><tr><th>Location</th><th>Checklist</th><th>Completed</th><th>By</th><th>Date</th><th></th></tr></thead>
              <tbody>
                {checklists === null ? (
                  <tr className="stack-plain"><td colSpan={6} style={{ padding: 20 }}>Loading…</td></tr>
                ) : checklists.length === 0 ? (
                  <tr className="stack-plain"><td colSpan={6}><EmptyState icon={<Icon name="check" size={28} />} title="No checklists yet" message="Click “New checklist” to complete one against a published checklist template." /></td></tr>
                ) : (
                  checklistsPager.pageRows.map((c) => (
                    <tr key={c.id}>
                      <td className="cell-primary"><span className="truncate" title={clientLabel(c) || siteLabel(c)}>{clientLabel(c) || siteLabel(c)}</span></td>
                      <td data-label="Checklist"><span className="truncate" title={c.template_snapshot?.name || ''}>{c.template_snapshot?.name || '—'}</span></td>
                      {/* "24/26" alone never said whether that was a finished checklist — the
                          same verdict the clock-out gate reached is said in words here
                          (lib/crewChecklist isChecklistComplete, over the row's OWN counts). */}
                      <td data-label="Completed">
                        {c.completed_count}/{c.total_count}
                        {/* Tasks the cleaner marked "not completed" (Matt, 2026-10-13) count in the
                            stored n/m — they unlocked the clock-out — so the row says how many,
                            read off the row's own items (null on a row without them). */}
                        {notCompletedCountOf(c) > 0 && <span className="text-muted"> · {notCompletedCountOf(c)} not completed</span>}
                        {!isChecklistComplete(c) && <span className="cr-row-flag"><Badge variant="red">Not finished</Badge></span>}
                      </td>
                      <td data-label="By"><span className="truncate" title={byLabel(c)}>{byLabel(c)}</span></td>
                      <td data-label="Date" style={{ whiteSpace: 'nowrap' }}>{c.performed_at ? fmtDate(c.performed_at) : '—'}</td>
                      {/* The result opens from a REAL control, never a click handler on the
                          <tr>: a row cannot carry a focus ring, an accessible name or a role
                          without breaking the table for assistive tech, and the Inspections
                          tab one click away already opens its report this way. */}
                      <td className="cell-actions" style={{ textAlign: 'right', whiteSpace: 'nowrap' }}>
                        <button type="button" className="btn btn-link btn-sm" aria-label={resultActionLabel(c)} onClick={() => setResultRow(c)}>View result</button>
                      </td>
                    </tr>
                  ))
                )}
              </tbody>
            </table>
            <ListPager pager={checklistsPager} noun="checklists" />
          </div>
        </>
      ) : tab === 'assignments' ? (
        // Gated on ops.edit both here and on the tab button: a viewer who cannot assign has
        // no reason to be handed a screen whose every action the server would refuse.
        canEditOps ? <ChecklistAssignments canEdit={canEditOps} /> : null
      ) : tab === 'workorders' ? (
        <WorkOrdersPanel canManage={canManageProblems} />
      ) : (
        <>
          {/* A checklist belongs to ONE customer (R2), so the list says whose each one is
              and can be narrowed to one — at ~750 customers the flat list is unreadable
              otherwise. Same engine and same bar as the Inspections tab. */}
          <FilterBar
            specs={templateFilterSpecs}
            values={tplFilters.values}
            setValue={tplFilters.setValue}
            clearAll={tplFilters.clearAll}
            activeCount={tplFilters.activeCount}
            ctx={tplFilterCtx}
          />
          <div className="table-wrap mobile-stack">
            <table>
              <thead><tr><th>Name</th><th>Type</th><th>Customer</th><th>Status</th><th>Updated</th><th></th></tr></thead>
              <tbody>
                {templates === null ? (
                  <tr className="stack-plain"><td colSpan={6} style={{ padding: 20 }}>Loading…</td></tr>
                ) : shownTemplates.length === 0 ? (
                  <tr className="stack-plain"><td colSpan={6}><EmptyState
                    icon={<Icon name="forms" size={28} />}
                    title={templates.length === 0 ? 'No templates yet' : 'No templates match'}
                    message={templates.length === 0
                      ? (canEditTpl ? 'Click “New template” to build one.' : 'No inspection templates have been created.')
                      : (tplFilters.values.cust === TEMPLATE_STARTERS
                        ? 'No starters yet. A starter is a checklist filed under no customer, offered under “Start from…”.'
                        : 'This customer has no checklists yet. Create one, or start from another customer’s.')}
                  /></td></tr>
                ) : (
                  templatesPager.pageRows.map((t) => (
                    <tr key={t.id}>
                      <td className="cell-primary" style={{ fontWeight: 600 }}><span className="truncate" title={t.name}>{t.name}</span></td>
                      <td data-label="Type" style={{ textTransform: 'capitalize' }}>{t.kind}</td>
                      <td data-label="Customer">
                        {t.kind === 'checklist' && !t.client_id
                          ? <Badge variant="slate">Starter</Badge>
                          : <span className="truncate" title={templateCustomer(t)}>{templateCustomer(t)}</span>}
                      </td>
                      <td data-label="Status">
                        {t.is_published ? <Badge variant="green">Published</Badge> : <Badge variant="slate">Draft</Badge>}
                        {/* CS-669: a saved draft of a published template is not live yet — its
                            name and pass mark wait for Publish, and the list says so. */}
                        {t.is_published && t.has_draft && (
                          <Badge variant="amber">{unpublishedLabel}</Badge>
                        )}
                      </td>
                      <td data-label="Updated" style={{ whiteSpace: 'nowrap' }}>{fmtDate(t.updated_at)}</td>
                      <td className="cell-actions" style={{ textAlign: 'right', whiteSpace: 'nowrap' }}>
                        {canEditTpl && <button className="btn btn-link btn-sm" onClick={() => setEditorTpl(t.id)}>Edit</button>}
                        {canEditTpl && (!t.is_published || t.has_draft) && <button className="btn btn-link btn-sm" onClick={() => publish(t.id)}>Publish</button>}
                        {canEditTpl && <button className="btn btn-link btn-sm" onClick={() => setDeleteTpl(t)}>Delete</button>}
                      </td>
                    </tr>
                  ))
                )}
              </tbody>
            </table>
            <ListPager pager={templatesPager} noun="templates" />
          </div>
        </>
      )}

      {/* Closing the form keeps a started inspection as a draft (finish it later), so the list
          reloads on every close to show it In progress. */}
      <InspectionFill open={fillOpen} presetSiteId={prefillSite} presetTemplateId={prefillTemplate} resumeId={resumeId} onClose={() => { setFillOpen(false); reloadRecords(); }} onSubmitted={() => { setFillOpen(false); reloadRecords(); }} />
      <ConfirmDialog
        open={!!discardRow}
        title={t('inspectionFill.draft.discardTitle')}
        message={discardRow ? t('inspectionFill.draft.discardMessage', { place: clientLabel(discardRow) || siteLabel(discardRow) }) : ''}
        confirmLabel={t('inspectionFill.draft.discardConfirm')}
        variant="danger"
        onConfirm={() => discardRow && doDiscard(discardRow)}
        onClose={() => setDiscardRow(null)}
      />
      <InspectionReportModal open={!!reportId} inspectionId={reportId} onClose={() => setReportId(null)} />
      <ChecklistFill open={checklistOpen} onClose={() => setChecklistOpen(false)} onSubmitted={() => { setChecklistOpen(false); loadChecklists(); }} />
      {/* Read-only, and it reads the row the table already holds — no fetch, no permission
          of its own: `checklists/list` is crew-scoped server-side, so a viewer can only
          open a result they were already handed (CS-552). */}
      <ChecklistResultModal open={!!resultRow} result={resultRow} onClose={() => setResultRow(null)} />
      {/* With the Templates tab narrowed to ONE customer, a new checklist is almost always
          for that customer — so it arrives pre-set and the editor locks it. On All, or on
          Starters (which has no customer to inherit), the editor asks. */}
      <InspectionTemplateEditor
        open={editorTpl !== undefined}
        templateId={editorTpl || null}
        clientId={!editorTpl && tplFilters.values.cust && tplFilters.values.cust !== TEMPLATE_STARTERS ? tplFilters.values.cust : null}
        onClose={() => setEditorTpl(undefined)}
        onSaved={() => { setEditorTpl(undefined); loadTemplates(); }}
      />
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
