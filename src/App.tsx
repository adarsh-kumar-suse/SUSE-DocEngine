import { useState, useEffect, useCallback } from 'react';
import { BrowserRouter, Routes, Route, Navigate } from 'react-router-dom';
import axios from 'axios';
import Dashboard from './pages/Dashboard';
import Login from './pages/Login';
import NewJob from './pages/NewJob';
import JobDetail from './pages/JobDetail';
import ProjectSetup from './pages/ProjectSetup';
import Settings from './pages/Settings';
import Collaboration, { SharedProjectsWorkspace } from './pages/Collaboration';
import Pipelines from './pages/Pipelines';
import PipelineStudio from './pages/PipelineStudio';
import { Layout } from './components/Layout';
import type { SessionUser } from './lib/session';
import { auth } from './lib/firebase';

const applyTheme = (themeName: string) => {
  document.documentElement.classList.remove('dark-green', 'light-green');
  document.documentElement.classList.add(themeName === 'light-green' ? 'light-green' : 'dark-green');
};

export default function App() {
  const [user, setUser] = useState<SessionUser | null>(null);
  const [loading, setLoading] = useState(true);

  const refreshSession = useCallback(async () => {
    try {
      const response = await axios.get('/api/auth/me');
      setUser(response.data.user || null);
    } catch {
      setUser(null);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    const theme = localStorage.getItem('theme') || 'dark-green';
    applyTheme(theme);
    refreshSession();
  }, [refreshSession]);

  const handleLogout = async () => {
    try {
      await axios.post('/api/auth/logout');
    } catch {
      // Ignore logout API errors and force local logout state.
    } finally {
      setUser(null);
      localStorage.removeItem('google_token');
      await auth.signOut().catch(() => undefined);
    }
  };

  if (loading) {
    return (
      <div className="min-h-screen bg-suse-dark flex items-center justify-center">
        <div className="animate-spin rounded-full h-12 w-12 border-t-2 border-b-2 border-suse-pine"></div>
      </div>
    );
  }

  return (
    <BrowserRouter>
      <Routes>
        <Route path="/login" element={!user ? <Login onAuthenticated={setUser} /> : <Navigate to="/" />} />
        <Route element={user ? <Layout user={user} onLogout={handleLogout} /> : <Navigate to="/login" />}>
          <Route path="/" element={<Dashboard />} />
          <Route path="/pipelines" element={<Pipelines />} />
          <Route path="/new" element={<NewJob />} />
          <Route path="/pipeline-studio/:jobId" element={<PipelineStudio />} />
          <Route path="/setup/:id" element={<ProjectSetup />} />
          <Route path="/job/:id" element={<JobDetail />} />
          <Route path="/collaboration" element={<Navigate to="/projects-owned" replace />} />
          <Route path="/projects-owned" element={<Collaboration />} />
          <Route path="/projects-shared" element={<SharedProjectsWorkspace />} />
          <Route path="/settings" element={<Settings />} />
        </Route>
      </Routes>
    </BrowserRouter>
  );
}
