import { lazy, Suspense } from 'react';
import {
  createRouter,
  createRoute,
  createRootRoute,
  Outlet,
  redirect,
} from '@tanstack/react-router';
import LoginPage from './pages/LoginPage';
import { getSessionInfo } from './api';

// Route components are lazy-loaded so Vite produces separate chunks per route.
const DashboardPage = lazy(() => import('./pages/DashboardPage'));
const AutonomyPage = lazy(() =>
  import('./pages/SettingsPage').then(m => ({ default: m.AutonomyPage })),
);
const WorkspacePage = lazy(() =>
  import('./pages/SettingsPage').then(m => ({ default: m.WorkspacePage })),
);
const SkillsPage = lazy(() =>
  import('./pages/RegistrySettings').then(m => ({ default: m.SkillsPage })),
);
const AgentsPage = lazy(() =>
  import('./pages/RegistrySettings').then(m => ({ default: m.AgentsPage })),
);
const ChannelsPage = lazy(() =>
  import('./pages/ChannelSettings').then(m => ({ default: m.ChannelsPage })),
);
const WizardPage = lazy(() => import('./pages/WizardPage'));
const ContactsPage = lazy(() => import('./pages/ContactsPage'));
const JobsPage = lazy(() => import('./pages/JobsPage'));
const TasksPage = lazy(() => import('./pages/TasksPage'));
const KgPage = lazy(() => import('./pages/KgPage'));
const ChatPage = lazy(() => import('./pages/ChatPage'));

const rootRoute = createRootRoute({
  component: () => (
    <Suspense fallback={null}>
      <Outlet />
    </Suspense>
  ),
});

// Layout route that guards all protected pages.
// Checks auth and first-run state in one shot to avoid a double-fetch.
const authedRoute = createRoute({
  getParentRoute: () => rootRoute,
  id: 'authed',
  beforeLoad: async ({ location }) => {
    const session = await getSessionInfo();
    if (!session.valid) throw redirect({ to: '/login' });
    // First-run redirect: push to /setup if not yet configured, unless already
    // heading there (avoids a redirect loop).
    if (!session.configured && location.pathname !== '/setup') {
      throw redirect({ to: '/setup', search: { step: 1 } });
    }
  },
});

const dashboardRoute = createRoute({
  getParentRoute: () => authedRoute,
  path: '/',
  component: DashboardPage,
});

const chatRoute = createRoute({
  getParentRoute: () => authedRoute,
  path: '/chat',
  component: ChatPage,
});

// Setup wizard — full-screen, no sidebar/topbar.
const setupRoute = createRoute({
  getParentRoute: () => authedRoute,
  path: '/setup',
  validateSearch: (search: Record<string, unknown>) => ({
    // Wizard now has 5 steps after the "About you" principal step was added at
    // step 1 (issue #771). Clamp incoming ?step= values so a stale link from
    // before the renumbering doesn't blow up route rendering.
    step: typeof search['step'] === 'number'
      ? Math.max(1, Math.min(5, Math.round(search['step'] as number)))
      : 1,
  }),
  component: WizardPage,
});

// Settings layout route — bare /settings redirects to the default section.
const settingsRoute = createRoute({
  getParentRoute: () => authedRoute,
  path: '/settings',
  beforeLoad: ({ location }) => {
    if (location.pathname === '/settings' || location.pathname === '/settings/') {
      throw redirect({ to: '/settings/autonomy' });
    }
  },
  component: () => (
    <Suspense fallback={null}>
      <Outlet />
    </Suspense>
  ),
});

const autonomyRoute = createRoute({
  getParentRoute: () => settingsRoute,
  path: '/autonomy',
  component: AutonomyPage,
});

const workspaceRoute = createRoute({
  getParentRoute: () => settingsRoute,
  path: '/workspace',
  component: WorkspacePage,
});

// Skills and Agents are now standalone top-level pages (peer to Contacts/Tasks),
// no longer rendered inside the settings shell. The two routes below preserve the
// old /settings/skills and /settings/agents URLs by redirecting to the new paths.
const skillsSettingsRedirect = createRoute({
  getParentRoute: () => settingsRoute,
  path: '/skills',
  beforeLoad: () => { throw redirect({ to: '/skills' }); },
});

const agentsSettingsRedirect = createRoute({
  getParentRoute: () => settingsRoute,
  path: '/agents',
  beforeLoad: () => { throw redirect({ to: '/agents' }); },
});

const loginRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: '/login',
  component: LoginPage,
});

const contactsRoute = createRoute({
  getParentRoute: () => authedRoute,
  path: '/contacts',
  component: ContactsPage,
});

const jobsRoute = createRoute({
  getParentRoute: () => authedRoute,
  path: '/jobs',
  component: JobsPage,
});

const tasksRoute = createRoute({
  getParentRoute: () => authedRoute,
  path: '/tasks',
  component: TasksPage,
});

const skillsRoute = createRoute({
  getParentRoute: () => authedRoute,
  path: '/skills',
  component: SkillsPage,
});

const agentsRoute = createRoute({
  getParentRoute: () => authedRoute,
  path: '/agents',
  component: AgentsPage,
});

const channelsRoute = createRoute({
  getParentRoute: () => authedRoute,
  path: '/channels',
  component: ChannelsPage,
});

const kgRoute = createRoute({
  getParentRoute: () => authedRoute,
  path: '/kg',
  validateSearch: (search: Record<string, unknown>) => ({
    q: typeof search['q'] === 'string' ? search['q'] : undefined,
    node: typeof search['node'] === 'string' ? search['node'] : undefined,
  }),
  component: KgPage,
});

const routeTree = rootRoute.addChildren([
  authedRoute.addChildren([
    dashboardRoute,
    chatRoute,
    setupRoute,
    contactsRoute,
    jobsRoute,
    tasksRoute,
    skillsRoute,
    agentsRoute,
    channelsRoute,
    kgRoute,
    settingsRoute.addChildren([autonomyRoute, workspaceRoute, skillsSettingsRedirect, agentsSettingsRedirect]),
  ]),
  loginRoute,
]);

export const router = createRouter({ routeTree });

// Register router type for full type-safety on useNavigate, Link, etc.
declare module '@tanstack/react-router' {
  interface Register {
    router: typeof router;
  }
}
