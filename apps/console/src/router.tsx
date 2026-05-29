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
const WizardPage = lazy(() => import('./pages/WizardPage'));

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

// Setup wizard — full-screen, no sidebar/topbar.
const setupRoute = createRoute({
  getParentRoute: () => authedRoute,
  path: '/setup',
  validateSearch: (search: Record<string, unknown>) => ({
    step: typeof search['step'] === 'number'
      ? Math.max(1, Math.min(4, Math.round(search['step'] as number)))
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

const loginRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: '/login',
  component: LoginPage,
});

const routeTree = rootRoute.addChildren([
  authedRoute.addChildren([
    dashboardRoute,
    setupRoute,
    settingsRoute.addChildren([autonomyRoute, workspaceRoute]),
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
