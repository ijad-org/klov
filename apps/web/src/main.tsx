import './index.css';

import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { BrowserRouter, Link, Route, Routes } from 'react-router';

import { Card, EmptyState, Shell } from './components/Shell';
import { LaunchDashboard } from './pages/LaunchDashboard';
import { ProjectPage } from './pages/ProjectPage';
import { ProjectsOverview } from './pages/ProjectsOverview';

const queryClient = new QueryClient({
  defaultOptions: {
    queries: {
      staleTime: 2_000,
      refetchOnWindowFocus: false,
      // Keep showing the previous data while refetching, so live views never flash.
      placeholderData: (previous: unknown) => previous,
    },
  },
});

function NotFound() {
  return (
    <Shell>
      <Card>
        <EmptyState title="Page not found">
          <Link to="/" className="text-accent hover:underline">
            Back to projects
          </Link>
        </EmptyState>
      </Card>
    </Shell>
  );
}

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <QueryClientProvider client={queryClient}>
      <BrowserRouter>
        <Routes>
          <Route path="/" element={<ProjectsOverview />} />
          <Route path="/projects/:slug" element={<ProjectPage />} />
          <Route path="/projects/:slug/launches/:launchId" element={<LaunchDashboard />} />
          <Route path="*" element={<NotFound />} />
        </Routes>
      </BrowserRouter>
    </QueryClientProvider>
  </StrictMode>,
);
