import { BrowserRouter, Routes, Route, Navigate } from 'react-router-dom';
import AppLayout from './layouts/AppLayout';
import { StoreProvider } from './store';
import { ToastProvider } from './components/Toast';
import RequirePerm from './components/RequirePerm';
import NotFound from './components/NotFound';
import TwilioInboundListener from './components/TwilioInboundListener';
import ReminderScheduler from './components/ReminderScheduler';
import NotificationListener from './components/NotificationListener';
import MarketingScheduler from './components/MarketingScheduler';
import MarketingInboundListener from './components/MarketingInboundListener';
import { usePermission } from './hooks/usePermission';

import Dashboard from './pages/Dashboard';
import Schedule from './pages/Schedule';
import JobDetail from './pages/JobDetail';
import Clients from './pages/Clients';
import ClientDetail from './pages/ClientDetail';
import ContactDetail from './pages/ContactDetail';
import Pipeline from './pages/Pipeline';
import Invoices from './pages/Invoices';
import InvoiceDetail from './pages/InvoiceDetail';
import Messaging from './pages/Messaging';
import Marketing from './pages/Marketing';
import Complaints from './pages/Complaints';
import Reviews from './pages/Reviews';
import QualityHub from './pages/quality/QualityHub';
import PublicInspectionReport from './pages/PublicInspectionReport';

import SettingsLayout from './pages/settings/SettingsLayout';
import SettingsCompany from './pages/settings/Company';
import SettingsServices from './pages/settings/Services';
import SettingsTags from './pages/settings/Tags';
import SettingsTeam from './pages/settings/Team';
import SettingsTeamDetail from './pages/settings/TeamDetail';
import SettingsRoles from './pages/settings/Roles';
import SettingsAccount from './pages/settings/Account';
import SettingsIntegrations from './pages/settings/Integrations';
import SettingsConnectedInboxes from './pages/settings/ConnectedInboxes';

// Demo/commerce layer — only mounted when VITE_DEMO_MODE is on (the marketing
// demo build). Per-client product builds leave IS_DEMO false and never render
// any of this.
import { IS_DEMO } from './demo/isDemo';
import { CartProvider } from './demo/cart/CartContext';
import DemoLanding from './demo/pages/DemoLanding';
import CheckoutPage from './demo/pages/CheckoutPage';
import CheckoutSuccess from './demo/pages/CheckoutSuccess';
// Prospect Q&A chat widget — TEMPORARILY DISABLED. To restore, uncomment this
// import and the <ProspectBot /> mount below.
// import ProspectBot from './demo/assistant/ProspectBot';

// Router mount point follows the Vite base: '' (root) for per-client product
// builds, '/polishpoint' for the marketing demo. BASE_URL is '/' or
// '/polishpoint/'; strip the trailing slash and fall back to '/' for the root.
const BASENAME = import.meta.env.BASE_URL.replace(/\/+$/, '') || '/';

function HomeRoute() {
  const hasDashboard = usePermission('dashboard.view');
  if (!hasDashboard) return <Navigate to="/schedule" replace />;
  return <Dashboard />;
}

function AppRoutes() {
  return (
    <BrowserRouter basename={BASENAME}>
      <Routes>
        {/* Standalone demo/commerce surfaces (no app sidebar), demo build only.
            In the demo the marketing LANDING is the entry at '/', and the live
            app moves under '/demo' (see the AppLayout block below). Per-client
            product builds leave IS_DEMO false, keep '/' as the Dashboard, and
            mount none of this. */}
        {IS_DEMO && <Route index element={<DemoLanding />} />}
        {IS_DEMO && <Route path="checkout" element={<CheckoutPage />} />}
        {IS_DEMO && <Route path="checkout/success" element={<CheckoutSuccess />} />}

        {/* Client-facing inspection report — shell-less, no auth, token-gated.
            A real product surface in both builds (the "your building scored 94%"
            artifact a prospect would send their customer). */}
        <Route path="inspect/:token" element={<PublicInspectionReport />} />

        <Route element={<AppLayout />}>
          {/* Demo: the live app home sits at '/demo' (the landing owns '/').
              Per-client product: the app home is the index. */}
          {IS_DEMO
            ? <Route path="demo" element={<HomeRoute />} />
            : <Route index element={<HomeRoute />} />}

          <Route path="schedule" element={<RequirePerm perm="schedule.view"><Schedule /></RequirePerm>} />
          <Route path="schedule/:jobId" element={<RequirePerm perm="schedule.view"><JobDetail /></RequirePerm>} />

          <Route path="contacts" element={<RequirePerm perm="contacts.view"><Clients /></RequirePerm>} />
          <Route path="contacts/:contactId" element={<RequirePerm perm="contacts.view"><ContactDetail /></RequirePerm>} />

          <Route path="clients" element={<RequirePerm perm="clients.view"><Clients /></RequirePerm>} />
          <Route path="clients/contact/:contactId" element={<RequirePerm perm="contacts.view"><ContactDetail /></RequirePerm>} />
          <Route path="clients/:clientId" element={<RequirePerm perm="clients.view"><ClientDetail /></RequirePerm>} />

          <Route path="pipeline" element={<RequirePerm perm="pipeline.view"><Pipeline /></RequirePerm>} />

          <Route path="invoices" element={<RequirePerm perm="invoices.view"><Invoices /></RequirePerm>} />
          <Route path="invoices/:invoiceId" element={<RequirePerm perm="invoices.view"><InvoiceDetail /></RequirePerm>} />

          <Route path="reminders" element={<Navigate to={IS_DEMO ? '/demo' : '/'} replace />} />

          <Route path="messaging" element={<RequirePerm perm="messaging.use"><Messaging /></RequirePerm>} />
          <Route path="messaging/:conversationId" element={<RequirePerm perm="messaging.use"><Messaging /></RequirePerm>} />

          <Route path="marketing" element={<RequirePerm perm="marketing.view"><Marketing /></RequirePerm>} />

          {/* Quality Control (Swept replacement) — scored inspections + the labor
              variance morning-scan. One hub, tabbed; /variance deep-links the tab. */}
          <Route path="inspections" element={<RequirePerm perm="qc.view"><QualityHub /></RequirePerm>} />
          <Route path="variance" element={<RequirePerm perm="variance.view"><QualityHub defaultTab="variance" /></RequirePerm>} />

          <Route path="complaints" element={<RequirePerm perm="complaints.view"><Complaints /></RequirePerm>} />
          <Route path="reviews" element={<RequirePerm perm="reviews.view"><Reviews /></RequirePerm>} />

          <Route path="settings" element={<SettingsLayout />}>
            <Route index element={<Navigate to="account" replace />} />
            <Route path="company" element={<RequirePerm perm="settings.company"><SettingsCompany /></RequirePerm>} />
            <Route path="services" element={<RequirePerm perm="settings.services"><SettingsServices /></RequirePerm>} />
            <Route path="tags" element={<RequirePerm perm="tags.manage"><SettingsTags /></RequirePerm>} />
            <Route path="team" element={<RequirePerm perm="settings.team.view"><SettingsTeam /></RequirePerm>} />
            <Route path="team/:userId" element={<RequirePerm perm="settings.team.view"><SettingsTeamDetail /></RequirePerm>} />
            <Route path="roles" element={<RequirePerm perm="settings.roles.edit"><SettingsRoles /></RequirePerm>} />
            <Route path="notifications" element={<Navigate to="/settings/account" replace />} />
            <Route path="account" element={<RequirePerm perm="settings.account"><SettingsAccount /></RequirePerm>} />
            <Route path="integrations" element={<RequirePerm perm="integrations.view"><SettingsIntegrations /></RequirePerm>} />
            <Route path="inboxes" element={<RequirePerm perm="messaging.use"><SettingsConnectedInboxes /></RequirePerm>} />
          </Route>

          <Route path="*" element={<NotFound />} />
        </Route>
      </Routes>

      {/* Prospect Q&A bot — a single persistent instance mounted above <Routes>,
          so the conversation survives navigation across the landing, live demo,
          and checkout. Demo build only; sits bottom-right, left of the cart FAB.
          TEMPORARILY DISABLED — uncomment the line below (and the import above) to restore. */}
      {/* {IS_DEMO && <ProspectBot />} */}
    </BrowserRouter>
  );
}

export default function App() {
  const tree = (
    <ToastProvider>
      <TwilioInboundListener />
      <ReminderScheduler />
      <NotificationListener />
      <MarketingScheduler />
      <MarketingInboundListener />
      <AppRoutes />
    </ToastProvider>
  );

  return (
    <StoreProvider>
      {IS_DEMO ? <CartProvider>{tree}</CartProvider> : tree}
    </StoreProvider>
  );
}
