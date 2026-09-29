import { Fragment, lazy, Suspense } from 'react';
import { BrowserRouter, Routes, Route, Navigate, Outlet, useLocation, useParams } from 'react-router-dom';
import AppLayout from './layouts/AppLayout';
import { StoreProvider } from './store';
import { ClientReviewProvider } from './store/ClientReviewProvider';
import DemoLanding from './demo/DemoLanding';
import { IS_DEMO, HOME_PATH } from './demo/demoConfig';
import { ToastProvider } from './components/Toast';
import { AuthProvider, useSession } from './auth/AuthProvider';
import RequirePerm from './components/RequirePerm';
import NotFound from './components/NotFound';
import TwilioInboundListener from './components/TwilioInboundListener';
import NotificationListener from './components/NotificationListener';
import MarketingScheduler from './components/MarketingScheduler';
import InboundListener from './components/InboundListener';
import { usePermission } from './hooks/usePermission';
import { useAuth } from './hooks/useAuth';
import { MARKETING_ENABLED } from './lib/features';
import { recoverFromStaleBuild } from './lib/staleBuild';
import SnapshotSync from './components/SnapshotSync';
import AutoUpdater from './components/AutoUpdater';
import OfflineClockSync from './components/OfflineClockSync';
import OpsAlertScheduler from './components/OpsAlertScheduler';
import BuildHeartbeat from './components/BuildHeartbeat';
import OfflineChecklistSync from './components/OfflineChecklistSync';
import OfflineMediaSync from './components/OfflineMediaSync';
import MobilePushGate from './components/MobilePushGate';
import PushFlushOnSync from './components/PushFlushOnSync';
import Login from './pages/Login';

// Route-level code splitting: each page is its own chunk, loaded on first visit
// instead of shipping all ~40 pages in one ~1.7 MB bundle that every phone must
// parse on every cold start. The common crew path (Dashboard/Schedule/JobDetail/
// MyDay) and the module a given user never opens (Marketing, Quotes, Settings)
// are now separate downloads. lazyRoute() self-heals the one failure mode — an old
// client requesting a chunk a newer deploy replaced — by reloading to fetch the fresh
// asset manifest instead of crashing (lib/staleBuild: a cooldown guard, so an installed PWA
// recovers from EVERY deploy, not just the first one in its long-lived session).
function lazyRoute(factory) {
  return lazy(() =>
    factory().catch((err) => {
      if (recoverFromStaleBuild()) return new Promise(() => {}); // hang until the reload takes over
      throw err; // the reload itself just failed too: surface the real error
    }),
  );
}

const Dashboard = lazyRoute(() => import('./pages/Dashboard'));
const AccountDashboard = lazyRoute(() => import('./pages/AccountDashboard'));
const Schedule = lazyRoute(() => import('./pages/Schedule'));
const JobDetail = lazyRoute(() => import('./pages/JobDetail'));
const MyDay = lazyRoute(() => import('./pages/MyDay'));
const Variance = lazyRoute(() => import('./pages/Variance'));
const Reports = lazyRoute(() => import('./pages/Reports'));
const Payroll = lazyRoute(() => import('./pages/Payroll'));
const Hr = lazyRoute(() => import('./pages/Hr'));
const TimeClock = lazyRoute(() => import('./pages/TimeClock'));
const Inspections = lazyRoute(() => import('./pages/Inspections'));
const Clients = lazyRoute(() => import('./pages/Clients'));
const ClientDetail = lazyRoute(() => import('./pages/ClientDetail'));
const Pipeline = lazyRoute(() => import('./pages/Pipeline'));
const Invoices = lazyRoute(() => import('./pages/Invoices'));
const InvoiceDetail = lazyRoute(() => import('./pages/InvoiceDetail'));
const Messaging = lazyRoute(() => import('./pages/Messaging'));
const Marketing = lazyRoute(() => import('./pages/Marketing'));
const Quotes = lazyRoute(() => import('./pages/Quotes'));
const QuoteEditor = lazyRoute(() => import('./pages/QuoteEditor'));
const Keys = lazyRoute(() => import('./pages/Keys'));
const Supplies = lazyRoute(() => import('./pages/Supplies'));
const Reviews = lazyRoute(() => import('./pages/Reviews'));
const Review = lazyRoute(() => import('./pages/Review'));
const PublicQuote = lazyRoute(() => import('./pages/PublicQuote'));
const PublicInspection = lazyRoute(() => import('./pages/PublicInspection'));

const SettingsLayout = lazyRoute(() => import('./pages/settings/SettingsLayout'));
const SettingsHub = lazyRoute(() => import('./pages/settings/SettingsHub'));
const SettingsQuickStart = lazyRoute(() => import('./pages/settings/QuickStart'));
const SettingsCompany = lazyRoute(() => import('./pages/settings/Company'));
const SettingsOperations = lazyRoute(() => import('./pages/settings/Operations'));
const SettingsServices = lazyRoute(() => import('./pages/settings/Services'));
const SettingsTags = lazyRoute(() => import('./pages/settings/Tags'));
const SettingsTeam = lazyRoute(() => import('./pages/settings/Team'));
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
  return (
    <div style={{ padding: 40, textAlign: 'center', color: 'var(--text-muted)', fontSize: 13 }}>
      Loading…
    </div>
  );
}

function HomeRoute() {
  const hasDashboard = usePermission('dashboard.view');
  const { currentUser } = useAuth();
  if (!hasDashboard) return <Navigate to="/my-day" replace />;
  // The dashboard is varied by user type. Owner (Super Admin) gets the KPI Cockpit
  // (variant C); Manager gets the Health Triage board (variant D). Admin (and any
  // other dashboard.view holder) keeps the operational Dashboard for now. Crew never
  // reach here (no dashboard.view); they were redirected to /my-day above.
  const role = currentUser?.role;
  if (role === 'owner') return <AccountDashboard variant="C" />;
  if (role === 'manager') return <AccountDashboard variant="D" />;
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
  const isOffice = currentUser?.role === 'owner' || currentUser?.role === 'admin' || currentUser?.role === 'manager';
  return (
    <>
      {/* Inbound SMS / email / marketing-reply listeners dispatch RECEIVE_SMS / RECEIVE_EMAIL /
          RECEIVE_MARKETING_REPLY — org-wide conversation + message + notification writes.
          Office only (CS-002). */}
      {isOffice && <TwilioInboundListener />}
      {isOffice && <InboundListener />}
      {/* Financial-snapshot poll writes the org-wide financialSnapshot slice (a slice crew
          never see). Office only (CS-002). */}
      {isOffice && <SnapshotSync />}
      {/* Late & missed-shift alerts (#2): dispatches RAISE_OPS_ALERT (org-wide opsAlertEvents
          + notifications) and reads time/qc data crew can't see. Office only (CS-002); the
          go-live server cron raises these tab-independently. */}
      {isOffice && <OpsAlertScheduler />}
      {/* Automated customer reminders (booking-confirmation / post-service emails
          + SMS) are DISABLED. Never a planned feature; the scheduler is unmounted
          so nothing fires on live. lib/reminderScheduler.js + the component +
          reducer reminder-event handling stay dormant for a future deliberate
          rebuild if a client requests it. (Daniel, 2026-07-02.) */}
      <NotificationListener />
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
  return (
    <div style={{
      position: 'fixed', inset: 0, display: 'flex', alignItems: 'center',
      justifyContent: 'center', background: 'var(--card-bg)', color: 'var(--text-faint)', fontSize: 13,
    }}>
      Loading…
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
  return (
    <StoreProvider>
      <ClientReviewProvider>
        <BackgroundServices />
        <MobilePushGate />
        <Outlet />
      </ClientReviewProvider>
    </StoreProvider>
  );
}

export default function App() {
  return (
    <AuthProvider>
      <ToastProvider>
        <BrowserRouter basename={import.meta.env.BASE_URL.replace(/\/$/, '')}>
          <Suspense fallback={<RouteFallback />}>
            <Routes>
              {/* Marketing demo: the public PolishPoint landing owns the index (/), and the live app home
                  moves to /demo (see the AppLayout block below). Off in the per-client product build. */}
              {IS_DEMO && <Route index element={<DemoLanding />} />}

              {/* Public, standalone (no auth, no shared store). */}
              <Route path="/quote/:token" element={<PublicQuote />} />
              <Route path="/inspect/:token" element={<PublicInspection />} />
              <Route path="/login" element={<Login />} />

              {/* Authenticated app shell. */}
              <Route element={<AuthedShell />}>
                <Route element={<AppLayout />}>
                  {/* Demo: the live app home sits at /demo (the landing owns /). Product build keeps it at index. */}
                  {IS_DEMO
                    ? <Route path="demo" element={<HomeRoute />} />
                    : <Route index element={<HomeRoute />} />}

                  <Route path="schedule" element={<RequirePerm perm="schedule.view"><Schedule /></RequirePerm>} />
                  <Route path="schedule/:jobId" element={<RequirePerm perm="schedule.view"><KeyedByParam name="jobId"><JobDetail /></KeyedByParam></RequirePerm>} />

                  {/* Swept replacement — crew "My Day" (clock + today + upcoming) and the
                      manager variance report (Phase 2). My Day merges the former Clock +
                      My Schedule pages; /clock + /my-schedule are retired. */}
                  <Route path="my-day" element={<RequirePerm perm="time.clock"><MyDay /></RequirePerm>} />
                  <Route path="variance" element={<RequirePerm perm="variance.view"><Variance /></RequirePerm>} />
                  <Route path="reports" element={<RequirePerm perm="reports.view"><Reports /></RequirePerm>} />
                  {/* Payroll — hours × rate → gross, custom lines, CSV export. Four
                      switchable views via the ?view= picker (UI_RULES §7 tabs). */}
                  <Route path="payroll" element={<RequirePerm perm="payroll.view"><Payroll /></RequirePerm>} />
                  {/* HR — employee records, special-service pay, reimbursements, PTO, documents. */}
                  <Route path="hr" element={<RequirePerm perm="hr.view"><Hr /></RequirePerm>} />
                  {/* Manager Time Clock — every crew punch, org-wide (Sept 3). */}
                  <Route path="time" element={<RequirePerm perm="time.view"><TimeClock /></RequirePerm>} />
                  {/* Quality hub (Inspections · Checklists · Problems · Templates). Route path
                      stays /inspections — the variance "Assign QC" deep-link it was named for was
                      removed 2026-09-19 (drill pared to just "View clean details"); kept to avoid
                      breaking existing links/bookmarks. */}
                  <Route path="inspections" element={<RequirePerm perm="qc.view"><Inspections /></RequirePerm>} />

                  <Route path="contacts" element={<RequirePerm perm="contacts.view"><Clients /></RequirePerm>} />
                  {/* People are not a standalone page: a contact lives as a row in its
                      company's Contacts sub-tab. Stale person deep-links fall back to the list. */}
                  <Route path="contacts/:contactId" element={<Navigate to="/contacts" replace />} />

                  <Route path="clients" element={<RequirePerm perm="clients.view"><Clients /></RequirePerm>} />
                  <Route path="clients/contact/:contactId" element={<Navigate to="/contacts" replace />} />
                  <Route path="clients/:clientId" element={<RequirePerm perm="clients.view"><KeyedByParam name="clientId"><ClientDetail /></KeyedByParam></RequirePerm>} />

                  <Route path="pipeline" element={<RequirePerm perm="pipeline.view"><Pipeline /></RequirePerm>} />

                  <Route path="invoices" element={<RequirePerm perm="invoices.view"><Invoices /></RequirePerm>} />
                  <Route path="invoices/:invoiceId" element={<RequirePerm perm="invoices.view"><KeyedByParam name="invoiceId"><InvoiceDetail /></KeyedByParam></RequirePerm>} />

                  <Route path="reminders" element={<Navigate to={HOME_PATH} replace />} />

                  <Route path="messaging" element={<RequirePerm perm="messaging.use"><Messaging /></RequirePerm>} />
                  <Route path="messaging/:conversationId" element={<RequirePerm perm="messaging.use"><Messaging /></RequirePerm>} />

                  {/* Review — build decisions + drafts to sign off (desktop only). The perm
                      KEY stays drafts.view (renaming it would transform the matrix). /drafts
                      redirects so old links and bookmarks still land. */}
                  <Route path="review" element={<RequirePerm perm="drafts.view"><Review /></RequirePerm>} />
                  <Route path="drafts" element={<Navigate to="/review" replace />} />

                  {/* Marketing is dormant (MARKETING_ENABLED, lib/features.js). While off,
                      /marketing is unregistered and falls through to NotFound; the page +
                      backend stay in the tree. Flip the flag to restore the route. */}
                  {MARKETING_ENABLED && (
                    <Route path="marketing" element={<RequirePerm perm="marketing.view"><Marketing /></RequirePerm>} />
                  )}

                  <Route path="quotes" element={<RequirePerm perm="quotes.view"><Quotes /></RequirePerm>} />
                  <Route path="quotes/:id" element={<RequirePerm perm="quotes.view"><KeyedByParam name="id"><QuoteEditor /></KeyedByParam></RequirePerm>} />

                  <Route path="keys" element={<RequirePerm perm="keys.view"><Keys /></RequirePerm>} />

                  <Route path="supplies" element={<RequirePerm perm="supplies.view"><Supplies /></RequirePerm>} />

                  <Route path="reviews" element={<RequirePerm perm="reviews.view"><Reviews /></RequirePerm>} />

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
