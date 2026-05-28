import { lazy, Suspense } from 'react';
import {
  createRouter,
  createRoute,
  createRootRoute,
  Outlet,
  redirect,
} from '@tanstack/react-router';
import LoginPage from './pages/LoginPage';
import { checkSession } from './api';

// Route components are lazy-loaded so Vite produces separate chunks per route.
const DashboardPage = lazy(() => import('./pages/DashboardPage'));

const rootRoute = createRootRoute({
  component: () => (
    <Suspense fallback={null}>
      <Outlet />
    </Suspense>
  ),
});

// Layout route that guards all protected pages.
// beforeLoad runs before any child route renders — 401 from /api/identity → /login.
const authedRoute = createRoute({
  getParentRoute: () => rootRoute,
  id: 'authed',
  beforeLoad: async () => {
    if (!(await checkSession())) {
      throw redirect({ to: '/login' });
    }
  },
});

const dashboardRoute = createRoute({
  getParentRoute: () => authedRoute,
  path: '/',
  component: DashboardPage,
});

const loginRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: '/login',
  component: LoginPage,
});

const routeTree = rootRoute.addChildren([
  authedRoute.addChildren([dashboardRoute]),
  loginRoute,
]);

export const router = createRouter({ routeTree });

// Register router type for full type-safety on useNavigate, Link, etc.
declare module '@tanstack/react-router' {
  interface Register {
    router: typeof router;
  }
}
