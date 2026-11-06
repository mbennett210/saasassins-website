import { ROUTER_BASE } from './demo/demoConfig'; // polishpoint-demo
import { Fragment, lazy, Suspense, useEffect, useReducer } from 'react';
import { BrowserRouter, Routes, Route, Navigate, Outlet, useLocation, useParams } from 'react-router-dom';
import AppLayout from './layouts/AppLayout';
import { StoreProvider } from './store';
import { ClientReviewProvider } from './store/ClientReviewProvider';
import { ToastProvider } from './components/Toast';
import { AuthProvider, useSession } from './auth/AuthProvider';
import RequirePerm from './components/RequirePerm';
import NotFound from './components/NotFound';
import OfflineScreen from './components/OfflineScreen';
import TwilioInboundListener from './components/TwilioInboundListener';
import NotificationListener from './components/NotificationListener';
import MarketingScheduler from './components/MarketingScheduler';
import InboundListener from './components/InboundListener';
import { usePermission } from './hooks/usePermission';
import { useAuth } from './hooks/useAuth';
import { MARKETING_ENABLED, QUOTES_ENABLED } from './lib/features';
import { isOfficeRole } from './lib/roles';
import { isClientSession } from './lib/clientHub';
import { onChunkLoadFailure, CHUNK_FAILURE } from './lib/staleBuild';
import SnapshotSync from './components/SnapshotSync';
import AutoUpdater from './components/AutoUpdater';
import OfflineClockSync from './components/OfflineClockSync';
import OpsAlertScheduler from './components/OpsAlertScheduler';
import BuildHeartbeat from './components/BuildHeartbeat';
import OfflineChecklistSync from './components/OfflineChecklistSync';
import OfflineMediaSync from './components/OfflineMediaSync';
import MobilePushGate from './components/MobilePushGate';
import InstallWelcome from './components/InstallWelcome';
import PushFlushOnSync from './components/PushFlushOnSync';
import LanguageSync from './components/LanguageSync';
import { useT } from './i18n/react';
import Login from './pages/Login';

// Route-level code splitting: each page is its own chunk, loaded on first visit
// instead of shipping all ~40 pages in one ~1.7 MB bundle that every phone must
// parse on every cold start. The common crew path (Dashboard/Schedule/JobDetail/
// MyDay) and the module a given user never opens (Marketing, Quotes, Settings)
// are now separate downloads. A chunk that fails to load goes through ONE door,
// lib/staleBuild `onChunkLoadFailure`, which tells its two causes apart:
//   · no signal (CS-665) → the screen says it opens when the phone is back online
//     (components/OfflineScreen) and the app stays — it NEVER reloads offline, which landed
//     on the browser's "no internet" page and lost the app. Back online, the screen loads by
//     itself: a fresh lazy() (React.lazy keeps whatever its first load resolved to, so the
//     offline screen would otherwise stay for good) and every mounted route re-renders.
//   · a deploy replaced the chunk → reload onto the current build (a cooldown guard, so an
//     installed PWA recovers from EVERY deploy, not just the first one in its session).
// The crew's own screens rarely get here at all: the service worker keeps them on the phone.
function lazyRoute(factory) {
  const mounted = new Set();
  let Page = null;
  const load = () => {
    Page = lazy(() =>
      factory().catch(async (err) => {
        const action = await onChunkLoadFailure();
        if (action === CHUNK_FAILURE.OFFLINE) return { default: OfflineRoute };
        if (action === CHUNK_FAILURE.RELOAD) return new Promise(() => {}); // hang until the reload takes over
        throw err; // the reload itself just failed too: surface the real error
      }),
    );
  };
  const retry = () => { load(); for (const rerender of [...mounted]) rerender(); };
  function OfflineRoute() { return <OfflineScreen onRetry={retry} />; }
  load();
  return function LazyRoute(props) {
    const [, rerender] = useReducer((n) => n + 1, 0);
    useEffect(() => {
      mounted.add(rerender);
      return () => { mounted.delete(rerender); };
    }, []);
    return <Page {...props} />;
  };
}

const Dashboard = lazyRoute(() => import('./pages/Dashboard'));
// ── The manager view redesign (Builder B, UI_RULES §152) ──
// A manager's home is ManagerHome (D1); the owner's is the KPI cockpit with a switch to the same
// Manager view (OwnerHome); the P&L board a manager used to land on has its own page (D3).
const ManagerHome = lazyRoute(() => import('./pages/ManagerHome'));
const OwnerHome = lazyRoute(() => import('./pages/OwnerHome'));
const PropertyPnl = lazyRoute(() => import('./pages/PropertyPnl'));
const Schedule = lazyRoute(() => import('./pages/Schedule'));
const JobDetail = lazyRoute(() => import('./pages/JobDetail'));
const MyDay = lazyRoute(() => import('./pages/MyDay'));
// The Cleaner Hub (Brief B): the cleaner's checklist for one clean, on its own page (UI_RULES §166).
const CrewChecklist = lazyRoute(() => import('./pages/crew/CrewChecklist'));
// ── The Cleaner Hub (Builder C, 2026-10-13): Client Requests and My Hours on the cleaner's phone ──
const CrewRequests = lazyRoute(() => import('./pages/crew/CrewRequests'));
const CrewRequest = lazyRoute(() => import('./pages/crew/CrewRequest'));
const CrewHours = lazyRoute(() => import('./pages/crew/CrewHours'));
// ── The Cleaner Hub (Builder D, 2026-10-13): Request Supplies and the QR scan ──
const CrewSupplies = lazyRoute(() => import('./pages/crew/CrewSupplies'));
// S131 Builder C: one of the cleaner's supply orders (crewPaths.supplyOrder — their supply bells open it).
const CrewSupplyOrder = lazyRoute(() => import('./pages/crew/CrewSupplyOrder'));
const CrewScan = lazyRoute(() => import('./pages/crew/CrewScan'));
// QR Wave 2 (Matt's QR-17..QR-21): the office's own scanner and the page one area of one location has.
const OfficeScan = lazyRoute(() => import('./pages/OfficeScan'));
const AreaPage = lazyRoute(() => import('./pages/AreaPage'));
// The Cleaner Hub (brief A, 2026-10-13): Today's Stops and the Clock In / Clock Out screen. Paths come
// from lib/crewPaths; both under /my-day, ALWAYS_GRANTED time.clock like Home.
const CrewStops = lazyRoute(() => import('./pages/crew/CrewStops'));
const CrewClock = lazyRoute(() => import('./pages/crew/CrewClock'));
const Variance = lazyRoute(() => import('./pages/Variance'));
const Reports = lazyRoute(() => import('./pages/Reports'));
const Payroll = lazyRoute(() => import('./pages/Payroll'));
const Hr = lazyRoute(() => import('./pages/Hr'));
const TimeClock = lazyRoute(() => import('./pages/TimeClock'));
const Approvals = lazyRoute(() => import('./pages/Approvals'));
// ── Manager view (Builder A, 2026-10-09): today's clock-ins and today's checklists, by visit ──
const ShiftCheckIn = lazyRoute(() => import('./pages/ShiftCheckIn'));
const ChecklistsToday = lazyRoute(() => import('./pages/ChecklistsToday'));
// Every building's QR codes in one place (Matt, 2026-10-30; UI_RULES §183).
const QrCodes = lazyRoute(() => import('./pages/QrCodes'));
const Inspections = lazyRoute(() => import('./pages/Inspections'));
// The manager view redesign (2026-10-09, Builder C): Client Requests, the Work Orders list as Matt's board draws it.
const ClientRequests = lazyRoute(() => import('./pages/ClientRequests'));
// S131: every account with its account manager — an Operations Manager's team, the office's all.
const TeamAccounts = lazyRoute(() => import('./pages/TeamAccounts'));
const Clients = lazyRoute(() => import('./pages/Clients'));
const ClientDetail = lazyRoute(() => import('./pages/ClientDetail'));
const Pipeline = lazyRoute(() => import('./pages/Pipeline'));
const Contracts = lazyRoute(() => import('./pages/Contracts'));
const Invoices = lazyRoute(() => import('./pages/Invoices'));
const InvoiceDetail = lazyRoute(() => import('./pages/InvoiceDetail'));
const Messaging = lazyRoute(() => import('./pages/Messaging'));
const Marketing = lazyRoute(() => import('./pages/Marketing'));
const Quotes = lazyRoute(() => import('./pages/Quotes'));
const QuoteEditor = lazyRoute(() => import('./pages/QuoteEditor'));
const Keys = lazyRoute(() => import('./pages/Keys'));
const Supplies = lazyRoute(() => import('./pages/Supplies'));
// One supply order (S131): the order page the queue's rows open.
const SupplyOrder = lazyRoute(() => import('./pages/SupplyOrder'));
// The Supply Manager's Home (S131): the Order Queue, the `supply_manager` role's `/` (HomeRoute).
const SupplyHome = lazyRoute(() => import('./pages/SupplyHome'));
// The delivery driver's page (the delivery step, 2026-10-12): supplies the office sent, to drop off.
const Deliveries = lazyRoute(() => import('./pages/Deliveries'));
const Review = lazyRoute(() => import('./pages/Review'));
const PublicQuote = lazyRoute(() => import('./pages/PublicQuote'));
const PublicInspection = lazyRoute(() => import('./pages/PublicInspection'));
// QR-2/3/5: the QR code on a wall, scanned — anyone, no login, no store (like /inspect).
const PublicAreaScan = lazyRoute(() => import('./pages/PublicAreaScan'));
const PublicSurvey = lazyRoute(() => import('./pages/PublicSurvey'));

// The CUSTOMER hub (the client hub, 2026-10-03) — its own shell, outside AuthedShell: a
// client login has no office nav and must never boot the shared store (see HubRoot).
const HubRoot = lazyRoute(() => import('./pages/hub/HubRoot'));
// The redesign (Matt's design, 2026-10-08): `/hub` opens the current building's Home; each
// section is its own page; Properties switches the building; Account is the person's own.
const HubLanding = lazyRoute(() => import('./pages/hub/HubLanding'));
const HubHome = lazyRoute(() => import('./pages/hub/HubHome'));
const HubVisit = lazyRoute(() => import('./pages/hub/HubVisit'));
const HubProperties = lazyRoute(() => import('./pages/hub/HubProperties'));
const HubAccount = lazyRoute(() => import('./pages/hub/HubAccount'));
const HubRequests = lazyRoute(() => import('./pages/hub/HubRequests'));
const HubChecklists = lazyRoute(() => import('./pages/hub/HubChecklists'));
const HubInspections = lazyRoute(() => import('./pages/hub/HubInspections'));
const HubHistory = lazyRoute(() => import('./pages/hub/HubHistory'));
// Builder C (the redesign, plan §3.5 / §3.6): read-only invoices from QuickBooks, the documents.
const HubInvoices = lazyRoute(() => import('./pages/hub/HubInvoices'));
const HubDocuments = lazyRoute(() => import('./pages/hub/HubDocuments'));
const HubMessages = lazyRoute(() => import('./pages/hub/HubMessages'));
// Round 2 (Phase 2 Wave 2): the records.
const HubNewTicket = lazyRoute(() => import('./pages/hub/HubNewTicket'));
const HubTicket = lazyRoute(() => import('./pages/hub/HubTicket'));
const HubChecklist = lazyRoute(() => import('./pages/hub/HubChecklist'));
const HubInspection = lazyRoute(() => import('./pages/hub/HubInspection'));
// The Cleaner Hub (Builder D, D5): the customer's camera — a site code opens that building's Checklists.
const HubScan = lazyRoute(() => import('./pages/hub/HubScan'));
// QR Wave 2 (QR-16): one area's own page, which a customer's scan of its code opens.
const HubArea = lazyRoute(() => import('./pages/hub/HubArea'));

const SettingsLayout = lazyRoute(() => import('./pages/settings/SettingsLayout'));
const SettingsHub = lazyRoute(() => import('./pages/settings/SettingsHub'));
const SettingsQuickStart = lazyRoute(() => import('./pages/settings/QuickStart'));
const SettingsCompany = lazyRoute(() => import('./pages/settings/Company'));
const SettingsOperations = lazyRoute(() => import('./pages/settings/Operations'));
const SettingsServices = lazyRoute(() => import('./pages/settings/Services'));
const SettingsTags = lazyRoute(() => import('./pages/settings/Tags'));
const SettingsTeam = lazyRoute(() => import('./pages/settings/Team'));
const SettingsClientLogins = lazyRoute(() => import('./pages/settings/ClientLogins'));
const SettingsTeamDetail = lazyRoute(() => import('./pages/settings/TeamDetail'));
const SettingsRoles = lazyRoute(() => import('./pages/settings/Roles'));
const SettingsReminders = lazyRoute(() => import('./pages/settings/Reminders'));
const SettingsAccount = lazyRoute(() => import('./pages/settings/Account'));
const SettingsIntegrations = lazyRoute(() => import('./pages/settings/Integrations'));
const SettingsConnectedInboxes = lazyRoute(() => import('./pages/settings/ConnectedInboxes'));

// A different record = a fresh page. React Router reuses a route's element across param
// changes, so without this, going from record A to record B (global search, or any link
// between two records of one type) kept A's local state — an edit form seeded from A, the
// tab A was on. Keying by the id remounts the detail page per record. NOT used on
// /messaging/:conversationId, which switches threads in place by design.
function KeyedByParam({ name, children }) {
  const params = useParams();
  return <Fragment key={params[name]}>{children}</Fragment>;
}

function RouteFallback() {
  const t = useT();
  return (
    <div style={{ padding: 40, textAlign: 'center', color: 'var(--text-muted)', fontSize: 13 }}>
      {t('common.loading')}
    </div>
  );
}

function HomeRoute() {
  const hasDashboard = usePermission('dashboard.view');
  const { currentUser } = useAuth();
  if (!hasDashboard) return <Navigate to="/my-day" replace />;
  // The dashboard is varied by user type. Owner (Super Admin) gets the KPI Cockpit (variant C)
  // with a switch to the Manager view (OwnerHome; how Matt uses it on the shared owner login);
  // Manager gets the manager Home — inspections, hours, requests, supplies and the P&L tile
  // (D1; the Health Triage board it used to land on is /pnl now, D3). The Supply Manager gets the
  // Order Queue (S131 Wave 2: pages/SupplyHome, Matt's sm-web-01 / sm-mobile-01) — never the
  // operational Dashboard, whose figures are the office's. Admin (and any other dashboard.view
  // holder) keeps the operational Dashboard. Crew never reach here (no dashboard.view); they were
  // redirected to /my-day above. The owner's "View as" a manager or a supply manager resolves to
  // that person's role here, so it shows their Home.
  const role = currentUser?.role;
  if (role === 'owner') return <OwnerHome />;
  if (role === 'manager') return <ManagerHome />;
  if (role === 'supply_manager') return <SupplyHome />;
  return <Dashboard />;
}

// Headless background workers. Mounted only once authenticated + the shared
// store is live, so they never poll the backend from the login screen.
//
// CS-002 — OFFICE-ONLY WRITERS. A background worker that writes ORG-WIDE data into the
// org_state blob must not run on a crew tab: crew hold only a projection, so its writes
// would be dropped by the server merge anyway, and it would 403 / churn reading data crew
// can't see. Gate those on the effective role (works in connected mode — the crew claim —
// AND in the demo user-switcher). The rest are per-user / read-only and run for everyone:
//   · NotificationListener — the current user's own toasts + tab badge (per-user)
//   · PushFlushOnSync      — fires /api/push/flush (idempotent; no org write)
//   · BuildHeartbeat       — /api/state/heartbeat (per-tab)
//   · AutoUpdater          — checks the build (no write)
//   · OfflineClock/Checklist/MediaSync — replay the crew's OWN punches / checklists / media
//     to the time / qc / account-media routes (per-user, not the blob)
function BackgroundServices() {
  const { currentUser } = useAuth();
  // The office set (lib/roles OFFICE_ROLES — the server's own list), never a hand list: a new
  // office tier (the supply manager, S131) must not read as crew here while the server treats it
  // as office.
  const isOffice = isOfficeRole(currentUser?.role);
  // The late / missed-shift scheduler's first read every tick is the covered cleans
  // (api/time covered-jobs, time.view): an office member without that key — a supply manager by
  // default — would draw a 403 every minute and raise nothing, so it runs for holders only.
  const canTimeView = usePermission('time.view');
  // The financial-snapshot poll follows the FINANCIAL permission, not the office roles
  // (CS-019). `invoices.view` defaults to owner + manager and deliberately NOT admin
  // (Q24: Admin must not see financials), and /api/settings/snapshot now refuses anyone
  // else — so mounting this for every office role would 403 an admin's tab every 60 s to
  // fetch numbers their dashboard does not render anyway.
  const canFinancials = usePermission('invoices.view');
  return (
    <>
      {/* Inbound SMS / email / marketing-reply listeners dispatch RECEIVE_SMS / RECEIVE_EMAIL /
          RECEIVE_MARKETING_REPLY — org-wide conversation + message + notification writes.
          Office only (CS-002). */}
      {isOffice && <TwilioInboundListener />}
      {isOffice && <InboundListener />}
      {/* Financial-snapshot poll writes the org-wide financialSnapshot slice (a slice crew
          never see). Holders of invoices.view only (CS-002 + CS-019). */}
      {canFinancials && <SnapshotSync />}
      {/* Late & missed-shift alerts (#2): dispatches RAISE_OPS_ALERT (org-wide opsAlertEvents
          + notifications) and reads time/qc data crew can't see. Office only (CS-002); the
          go-live server cron raises these tab-independently. */}
      {isOffice && canTimeView && <OpsAlertScheduler />}
      {/* Customer messages are sent by the SERVER alone (api/reminders/run.js, every 5 minutes),
          never from a tab: the client-side scheduler that flooded the office on 2026-07-02 is
          gone (2026-10-19). */}
      <NotificationListener />
      {/* The screen's language follows the person (their saved choice, else this phone),
          and this phone's language is recorded on their row for the server's alerts
          (CS-193). Per-user, every role. */}
      <LanguageSync />
      {/* Marketing is dormant (MARKETING_ENABLED, lib/features.js): don't mount the
          local/demo drip dispatcher. The scheduler + engine stay in the tree. */}
      {MARKETING_ENABLED && isOffice && <MarketingScheduler />}
      <AutoUpdater />
      <OfflineClockSync />
      <BuildHeartbeat />
      <OfflineChecklistSync />
      <OfflineMediaSync />
      <PushFlushOnSync />
    </>
  );
}

function AuthLoading() {
  const t = useT();
  return (
    <div style={{
      position: 'fixed', inset: 0, display: 'flex', alignItems: 'center',
      justifyContent: 'center', background: 'var(--card-bg)', color: 'var(--text-faint)', fontSize: 13,
    }}>
      {t('common.loading')}
    </div>
  );
}

// Auth gate for the whole app shell. When Supabase auth is configured, requires
// a valid session (else → /login). In local mode (no Supabase env) it passes
// straight through so offline UI work still works. Provides the shared store +
// background services to everything inside.
function AuthedShell() {
  const { configured, loading, session } = useSession();
  const location = useLocation();
  if (configured && loading) return <AuthLoading />;
  if (configured && !session) return <Navigate to="/login" replace state={{ from: location }} />;
  // 🔴 A CUSTOMER LOGIN NEVER BOOTS THE OFFICE SHELL. StoreProvider is one line below, and a
  // client login cannot read org_state (office-only since CS-002) — every /api/state/* route
  // refuses role 'client' outright — so mounting it would be a sync manager retrying a 403
  // behind a nav of pages they are refused. Sending them to /hub costs one redirect and is
  // also what makes the plain sign-in flow work: Login lands on `from` (default "/") and this
  // puts a customer where they belong. The server, not this line, is the boundary.
  if (isClientSession(session)) return <Navigate to="/hub" replace />;
  return (
    <StoreProvider>
      <ClientReviewProvider>
        <BackgroundServices />
        <MobilePushGate />
        {/* A phone's browser, until the app is on its Home Screen (UI_RULES §178); the push prompt
            waits for a visit without it. */}
        <InstallWelcome />
        <Outlet />
      </ClientReviewProvider>
    </StoreProvider>
  );
}

export default function App() {
  return (
    <AuthProvider>
      <ToastProvider>
        <BrowserRouter basename={ROUTER_BASE}>
          <Suspense fallback={<RouteFallback />}>
            <Routes>
              {/* Public, standalone (no auth, no shared store). */}
              <Route path="/quote/:token" element={<PublicQuote />} />
              <Route path="/inspect/:token" element={<PublicInspection />} />
              <Route path="/scan/:token" element={<PublicAreaScan />} />
              <Route path="/survey/:token" element={<PublicSurvey />} />
              <Route path="/login" element={<Login />} />

              {/* The CUSTOMER hub: signed in, but not the office app — its own shell (the
                  redesign's sidebar and phone tabs), no shared store (HubRoot). The sections nest
                  here; the request pages keep /tickets/ because the emails already sent link there. */}
              <Route path="/hub" element={<HubRoot />}>
                <Route index element={<HubLanding />} />
                {/* Absolute child paths, so the back-arrow and route sweeps see the real URL. */}
                <Route path="/hub/properties" element={<HubProperties />} />
                <Route path="/hub/account" element={<HubAccount />} />
                <Route path="/hub/b/:buildingId" element={<HubHome />} />
                <Route path="/hub/b/:buildingId/visit" element={<HubVisit />} />
                <Route path="/hub/b/:buildingId/tickets" element={<HubRequests />} />
                <Route path="/hub/b/:buildingId/tickets/new" element={<HubNewTicket />} />
                <Route path="/hub/b/:buildingId/tickets/:ticketId" element={<KeyedByParam name="ticketId"><HubTicket /></KeyedByParam>} />
                <Route path="/hub/b/:buildingId/checklists" element={<HubChecklists />} />
                <Route path="/hub/b/:buildingId/checklists/:checklistId" element={<HubChecklist />} />
                <Route path="/hub/b/:buildingId/inspections" element={<HubInspections />} />
                <Route path="/hub/b/:buildingId/inspections/:inspectionId" element={<HubInspection />} />
                <Route path="/hub/b/:buildingId/history" element={<HubHistory />} />
                <Route path="/hub/b/:buildingId/invoices" element={<HubInvoices />} />
                <Route path="/hub/b/:buildingId/documents" element={<HubDocuments />} />
                <Route path="/hub/b/:buildingId/messages" element={<HubMessages />} />
                <Route path="/hub/b/:buildingId/areas/:areaId" element={<KeyedByParam name="areaId"><HubArea /></KeyedByParam>} />
                <Route path="/hub/scan" element={<HubScan />} />
                <Route path="*" element={<Navigate to="/hub" replace />} />
              </Route>

              {/* Authenticated app shell. */}
              <Route element={<AuthedShell />}>
                <Route element={<AppLayout />}>
                  <Route index element={<HomeRoute />} />

                  <Route path="schedule" element={<RequirePerm perm="schedule.view"><Schedule /></RequirePerm>} />
                  <Route path="schedule/:jobId" element={<RequirePerm perm="schedule.view"><KeyedByParam name="jobId"><JobDetail /></KeyedByParam></RequirePerm>} />

                  {/* Swept replacement — crew "My Day" (clock + today + upcoming) and the
                      manager variance report (Phase 2). My Day merges the former Clock +
                      My Schedule pages; /clock + /my-schedule are retired. */}
                  <Route path="my-day" element={<RequirePerm perm="time.clock"><MyDay /></RequirePerm>} />
                  {/* My Checklist (Cleaner Hub, Brief B): crewPaths.checklist(jobId). Its own key, the one
                      the checklist submit route checks: qc.checklist.perform (every role holds it). Keyed by
                      the clean, so one clean's draft and sheets never carry into the next. */}
                  <Route path="my-day/checklist/:jobId" element={<RequirePerm perm="qc.checklist.perform"><KeyedByParam name="jobId"><CrewChecklist /></KeyedByParam></RequirePerm>} />
                  {/* The Cleaner Hub (Builder C): the cleaner's Client Requests and My Hours. Under
                      /my-day (ALWAYS_GRANTED time.clock); each read is SELF-scoped on the server by
                      the login's claim (api/qc problems/mine EP-380, api/time my-hours EP-381). */}
                  <Route path="my-day/requests" element={<RequirePerm perm="time.clock"><CrewRequests /></RequirePerm>} />
                  <Route path="my-day/requests/:ticketId" element={<RequirePerm perm="time.clock"><KeyedByParam name="ticketId"><CrewRequest /></KeyedByParam></RequirePerm>} />
                  <Route path="my-day/hours" element={<RequirePerm perm="time.clock"><CrewHours /></RequirePerm>} />
                  {/* The Cleaner Hub (Builder D): Request Supplies holds its own key's gate on the page
                      (`supplies.request` — a switched-off cleaner reads why, never "Page not
                      available"); the scan is everyone's (`time.clock`), the server scopes it. */}
                  <Route path="my-day/supplies" element={<RequirePerm perm="time.clock"><CrewSupplies /></RequirePerm>} />
                  <Route path="my-day/supplies/orders/:id" element={<RequirePerm perm="time.clock"><KeyedByParam name="id"><CrewSupplyOrder /></KeyedByParam></RequirePerm>} />
                  <Route path="my-day/scan" element={<RequirePerm perm="time.clock"><CrewScan /></RequirePerm>} />
                  {/* The Cleaner Hub's own screens (Matt's design, 2026-10-13): Home is /my-day above. */}
                  <Route path="my-day/stops" element={<RequirePerm perm="time.clock"><CrewStops /></RequirePerm>} />
                  <Route path="my-day/clock/:jobId" element={<RequirePerm perm="time.clock"><KeyedByParam name="jobId"><CrewClock /></KeyedByParam></RequirePerm>} />
                  <Route path="variance" element={<RequirePerm perm="variance.view"><Variance /></RequirePerm>} />
                  <Route path="reports" element={<RequirePerm perm="reports.view"><Reports /></RequirePerm>} />
                  {/* Property P&L — the QuickBooks board per property (variant D, its period picker),
                      reached from the manager Home's tile (D3). The money gate, like the board's data. */}
                  <Route path="pnl" element={<RequirePerm perm="financials.view"><PropertyPnl /></RequirePerm>} />
                  {/* Payroll — hours × rate → gross, custom lines, CSV export. Four
                      switchable views via the ?view= picker (UI_RULES §7 tabs). */}
                  <Route path="payroll" element={<RequirePerm perm="payroll.view"><Payroll /></RequirePerm>} />
                  {/* HR — employee records, special-service pay, reimbursements, PTO, documents. */}
                  <Route path="hr" element={<RequirePerm perm="hr.view"><Hr /></RequirePerm>} />
                  {/* Manager Approvals — approve every clock-in/out (+ overtime, missing time)
                      before payroll (W2-U). Phones allowed; gated time.approve. */}
                  <Route path="approvals" element={<RequirePerm perm="time.approve"><Approvals /></RequirePerm>} />
                  {/* ── Manager view (Builder A, 2026-10-09) ── Shift check-in: today's visits, who
                      arrived, who is late, who hasn't checked in (time.approve: who approves time
                      watches attendance). Checklists today: each visit's checklist (qc.view). Both
                      office-only (crew are refused in the page; the nav hides them, managerOnly). */}
                  <Route path="check-in" element={<RequirePerm perm="time.approve"><ShiftCheckIn /></RequirePerm>} />
                  <Route path="checklists" element={<RequirePerm perm="qc.view"><ChecklistsToday /></RequirePerm>} />
                  {/* QR codes (UI_RULES §183): every building, its areas and its codes. Gated as the codes are
                      (sites.edit); the page also refuses a crew role (lib/scanCodes scanCodesAllowed). */}
                  <Route path="qr-codes" element={<RequirePerm perm="sites.edit"><QrCodes /></RequirePerm>} />
                  {/* Manager Time Clock — every crew punch, org-wide (Sept 3). */}
                  <Route path="time" element={<RequirePerm perm="time.view"><TimeClock /></RequirePerm>} />
                  {/* Quality hub (Inspections · Checklists · Problems · Templates). Route path
                      stays /inspections — the variance "Assign QC" deep-link it was named for was
                      removed 2026-09-19 (drill pared to just "View clean details"); kept to avoid
                      breaking existing links/bookmarks. */}
                  <Route path="inspections" element={<RequirePerm perm="qc.view"><Inspections /></RequirePerm>} />
                  {/* Client Requests (the manager view redesign, 2026-10-09, Builder C): the open work
                      orders, most urgent deadline first, under the deadlines Matt answered. Gated as the
                      Quality hub's Work Orders tab is (problems.manage); the tab keeps its own screen (D4). */}
                  <Route path="requests" element={<RequirePerm perm="problems.manage"><ClientRequests /></RequirePerm>} />
                  {/* Accounts (S131, UI_RULES §169): gated like the customer list; the page itself is the
                      team viewers' (owner, admin, an Operations Manager — lib/teamScope seesTeamPages). */}
                  <Route path="team-accounts" element={<RequirePerm perm="clients.view"><TeamAccounts /></RequirePerm>} />
                  {/* QR Wave 2 (UI_RULES §172, §175): the office's scanner (every login: the page hands a cleaner
                      on to /my-day/scan) and the area page an office scan lands on (the customer page's own
                      key), a fresh page per location and area. */}
                  <Route path="areas/scan" element={<RequirePerm perm="time.clock"><OfficeScan /></RequirePerm>} />
                  <Route path="areas/:siteId/:areaId" element={<RequirePerm perm="clients.view"><KeyedByParam name="siteId"><KeyedByParam name="areaId"><AreaPage /></KeyedByParam></KeyedByParam></RequirePerm>} />

                  <Route path="contacts" element={<RequirePerm perm="contacts.view"><Clients /></RequirePerm>} />
                  {/* People are not a standalone page: a contact lives as a row in its
                      company's Contacts sub-tab. Stale person deep-links fall back to the list. */}
                  <Route path="contacts/:contactId" element={<Navigate to="/contacts" replace />} />

                  <Route path="clients" element={<RequirePerm perm="clients.view"><Clients /></RequirePerm>} />
                  <Route path="clients/contact/:contactId" element={<Navigate to="/contacts" replace />} />
                  <Route path="clients/:clientId" element={<RequirePerm perm="clients.view"><KeyedByParam name="clientId"><ClientDetail /></KeyedByParam></RequirePerm>} />

                  <Route path="pipeline" element={<RequirePerm perm="pipeline.view"><Pipeline /></RequirePerm>} />

                  {/* Contracts — the signed agreements, their year prices, renewals and the
                      book total (CON-1..CON-14, CS-194). The VALUE on it follows the billing
                      rule server-side (invoices.view, CS-019); this key only opens the page. */}
                  <Route path="contracts" element={<RequirePerm perm="contracts.view"><Contracts /></RequirePerm>} />

                  <Route path="invoices" element={<RequirePerm perm="invoices.view"><Invoices /></RequirePerm>} />
                  <Route path="invoices/:invoiceId" element={<RequirePerm perm="invoices.view"><KeyedByParam name="invoiceId"><InvoiceDetail /></KeyedByParam></RequirePerm>} />

                  <Route path="reminders" element={<Navigate to="/" replace />} />

                  <Route path="messaging" element={<RequirePerm perm="messaging.use"><Messaging /></RequirePerm>} />
                  <Route path="messaging/:conversationId" element={<RequirePerm perm="messaging.use"><Messaging /></RequirePerm>} />

                  {/* Review — build decisions + drafts to sign off (desktop only). The perm
                      KEY stays drafts.view (renaming it would transform the matrix). /drafts
                      redirects so old links and bookmarks still land. */}
                  <Route path="review" element={<Navigate to="/" replace />} />
                  <Route path="drafts" element={<Navigate to="/review" replace />} />

                  {/* Marketing is dormant (MARKETING_ENABLED, lib/features.js). While off,
                      /marketing is unregistered and falls through to NotFound; the page +
                      backend stay in the tree. Flip the flag to restore the route. */}
                  {MARKETING_ENABLED && (
                    <Route path="marketing" element={<RequirePerm perm="marketing.view"><Marketing /></RequirePerm>} />
                  )}

                  {/* Quotes is dormant (QUOTES_ENABLED, lib/features.js: Matt uses PandaDoc, MISC-7).
                      While off, /quotes and /quotes/:id fall through to NotFound; the public
                      /quote/:token signing page above stays, so a link already sent still opens. */}
                  {QUOTES_ENABLED && (
                    <>
                      <Route path="quotes" element={<RequirePerm perm="quotes.view"><Quotes /></RequirePerm>} />
                      <Route path="quotes/:id" element={<RequirePerm perm="quotes.view"><KeyedByParam name="id"><QuoteEditor /></KeyedByParam></RequirePerm>} />
                    </>
                  )}

                  <Route path="keys" element={<RequirePerm perm="keys.view"><Keys /></RequirePerm>} />

                  <Route path="supplies" element={<RequirePerm perm="supplies.view"><Supplies /></RequirePerm>} />
                  <Route path="supplies/orders/:id" element={<RequirePerm perm="supplies.view"><KeyedByParam name="id"><SupplyOrder /></KeyedByParam></RequirePerm>} />
                  <Route path="deliveries" element={<RequirePerm perm="supplies.deliver"><Deliveries /></RequirePerm>} />

                  <Route path="settings" element={<SettingsLayout />}>
                    {/* The hub IS /settings now — it replaced the flat pill row that
                        used to sit on every settings page (see settingsNav.js). */}
                    <Route index element={<SettingsHub />} />
                    <Route path="quickstart" element={<RequirePerm perm="settings.account"><SettingsQuickStart /></RequirePerm>} />
                    <Route path="company" element={<RequirePerm perm="settings.company"><SettingsCompany /></RequirePerm>} />
                    <Route path="operations" element={<RequirePerm perm="time.config"><SettingsOperations /></RequirePerm>} />
                    <Route path="services" element={<RequirePerm perm="settings.services"><SettingsServices /></RequirePerm>} />
                    <Route path="tags" element={<RequirePerm perm="tags.manage"><SettingsTags /></RequirePerm>} />
                    <Route path="team" element={<RequirePerm perm="settings.team.view"><SettingsTeam /></RequirePerm>} />
                    <Route path="team/:userId" element={<RequirePerm perm="settings.team.view"><KeyedByParam name="userId"><SettingsTeamDetail /></KeyedByParam></RequirePerm>} />
                    <Route path="roles" element={<RequirePerm perm="settings.roles.edit"><SettingsRoles /></RequirePerm>} />
                    {/* Who on the CUSTOMER's side can sign in, and which buildings they see. */}
                    <Route path="client-logins" element={<RequirePerm perm="hub.users.view"><SettingsClientLogins /></RequirePerm>} />
                    <Route path="reminders" element={<RequirePerm perm="reminders.view"><SettingsReminders /></RequirePerm>} />
                    <Route path="notifications" element={<Navigate to="/settings/account" replace />} />
                    <Route path="account" element={<RequirePerm perm="settings.account"><SettingsAccount /></RequirePerm>} />
                    <Route path="integrations" element={<RequirePerm perm="integrations.view"><SettingsIntegrations /></RequirePerm>} />
                    <Route path="inboxes" element={<RequirePerm perm="messaging.startConversation"><SettingsConnectedInboxes /></RequirePerm>} />
                  </Route>

                  <Route path="*" element={<NotFound />} />
                </Route>
              </Route>
            </Routes>
          </Suspense>
        </BrowserRouter>
      </ToastProvider>
    </AuthProvider>
  );
}
