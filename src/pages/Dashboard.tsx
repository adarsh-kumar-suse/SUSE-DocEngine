import React, { useEffect, useState } from 'react';
import axios from 'axios';
import { Plus, Play, CheckCircle2, Clock, AlertCircle, Zap, FileText, Eye, Pencil, Trash2 } from 'lucide-react';
import { motion } from 'motion/react';
import { Link } from 'react-router-dom';
import { clsx } from 'clsx';
import { getActiveProjectId, type ProjectSummary } from '../lib/projects';

type JobStatus = 'pending' | 'processing' | 'completed' | 'failed';

type JobRecord = {
  id: string;
  googleDocTitle?: string;
  googleDocId?: string;
  projectId?: string;
  createdAt?: string;
  updatedAt?: string;
  status?: JobStatus;
};

const getApiError = (err: unknown, fallback: string) => {
  const maybeAxios = err as { response?: { data?: { error?: { message?: string } } }; message?: string };
  return maybeAxios?.response?.data?.error?.message || maybeAxios?.message || fallback;
};

const statusBadgeClass = (status: JobStatus | undefined) => {
  if (status === 'completed') return 'text-suse-pine bg-suse-pine/10';
  if (status === 'processing') return 'text-suse-water bg-suse-water/10';
  if (status === 'failed') return 'text-red-400 bg-red-400/10';
  return 'text-gray-400 bg-gray-400/10';
};

const displayStatus = (status: JobStatus | undefined) => {
  if (status === 'processing') return 'inprogress';
  return status || 'pending';
};

export default function Dashboard() {
  const [jobs, setJobs] = useState<JobRecord[]>([]);
  const [projects, setProjects] = useState<ProjectSummary[]>([]);
  const [activeProjectId, setActiveProjectId] = useState(getActiveProjectId());
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [status, setStatus] = useState('');
  const [busy, setBusy] = useState(false);
  const [editJobId, setEditJobId] = useState('');
  const [editTitle, setEditTitle] = useState('');
  const [editStatus, setEditStatus] = useState<JobStatus>('pending');

  const fetchJobs = async () => {
    try {
      const projectId = getActiveProjectId();
      const response = await axios.get('/api/jobs', {
        params: projectId ? { projectId } : undefined,
      });
      setJobs(Array.isArray(response.data) ? (response.data as JobRecord[]) : []);
      setError('');
    } catch (err: unknown) {
      setError(getApiError(err, 'Failed to load jobs'));
      setJobs([]);
    } finally {
      setLoading(false);
    }
  };

  const fetchProjects = async () => {
    try {
      const response = await axios.get('/api/projects');
      const nextProjects = Array.isArray(response.data) ? (response.data as ProjectSummary[]) : [];
      setProjects(nextProjects);
      const selected = getActiveProjectId();
      if (selected !== activeProjectId) {
        setActiveProjectId(selected);
      }
    } catch {
      setProjects([]);
    }
  };

  useEffect(() => {
    fetchProjects();
    fetchJobs();

    const interval = setInterval(fetchJobs, 10000);
    const onProjectChange = (event: Event) => {
      const custom = event as CustomEvent<{ projectId: string }>;
      setActiveProjectId(custom.detail?.projectId || '');
      setLoading(true);
      fetchJobs();
    };
    window.addEventListener('active-project-changed', onProjectChange);
    return () => {
      clearInterval(interval);
      window.removeEventListener('active-project-changed', onProjectChange);
    };
  }, []);

  const safeProjects = Array.isArray(projects) ? projects : [];
  const activeProject = safeProjects.find((project) => project.id === activeProjectId);
  const ownedProjects = safeProjects.filter((project) => project.role === 'owner');
  const sharedProjects = safeProjects.filter((project) => project.role !== 'owner');
  const projectNameById = new Map(safeProjects.map((project) => [project.id, project.name]));
  const sortedJobs = jobs
    .slice()
    .sort((a, b) => new Date(b.createdAt || 0).getTime() - new Date(a.createdAt || 0).getTime());

  const getStatusIcon = (status: JobStatus | undefined) => {
    switch (status) {
      case 'completed':
        return <CheckCircle2 className="text-suse-pine" size={18} />;
      case 'processing':
        return <Clock className="text-suse-water animate-spin" size={18} />;
      case 'failed':
        return <AlertCircle className="text-red-500" size={18} />;
      default:
        return <Clock className="text-gray-500" size={18} />;
    }
  };

  const runAction = async (action: () => Promise<void>, successMessage: string) => {
    try {
      setBusy(true);
      setError('');
      setStatus('');
      await action();
      setStatus(successMessage);
      await fetchJobs();
    } catch (err: unknown) {
      setError(getApiError(err, 'Action failed.'));
    } finally {
      setBusy(false);
    }
  };

  const openEdit = (job: JobRecord) => {
    setEditJobId(job.id);
    setEditTitle(job.googleDocTitle || '');
    setEditStatus((job.status || 'pending') as JobStatus);
  };

  const saveEdit = async () => {
    if (!editJobId || !editTitle.trim()) return;
    await runAction(async () => {
      await axios.patch(`/api/jobs/${editJobId}`, {
        googleDocTitle: editTitle.trim(),
        status: editStatus,
      });
      setEditJobId('');
      setEditTitle('');
      setEditStatus('pending');
    }, 'Pipeline updated.');
  };

  const deletePipeline = async (job: JobRecord) => {
    const okay = window.confirm(`Delete pipeline "${job.googleDocTitle || job.id}"?`);
    if (!okay) return;
    await runAction(async () => {
      await axios.delete(`/api/jobs/${job.id}`);
      if (editJobId === job.id) {
        setEditJobId('');
        setEditTitle('');
        setEditStatus('pending');
      }
    }, 'Pipeline deleted.');
  };

  return (
    <div className="space-y-8 max-w-6xl mx-auto">
      <div className="flex justify-between items-center">
        <div>
          <h1 className="text-3xl font-bold mb-2">Documentation Pipeline</h1>
          <p className="text-gray-400 font-mono text-sm uppercase tracking-wider">
            {activeProject ? `Project: ${activeProject.name}` : 'Overview of active document transformations'}
          </p>
        </div>
        <Link to="/new" className="suse-button-primary flex items-center gap-2 px-6">
          <Plus size={20} />
          New Import
        </Link>
      </div>

      <div className="grid grid-cols-1 md:grid-cols-3 gap-6">
        <div className="suse-card p-6 flex items-center justify-between">
          <div>
            <p className="text-gray-400 text-sm mb-1 uppercase tracking-widest font-semibold">Total Pipelines</p>
            <p className="text-4xl font-bold text-white">{jobs.length}</p>
          </div>
          <div className="p-3 bg-suse-pine/10 rounded-xl">
            <Play className="text-suse-pine" size={24} />
          </div>
        </div>
        <div className="suse-card p-6 flex items-center justify-between">
          <div>
            <p className="text-gray-400 text-sm mb-1 uppercase tracking-widest font-semibold">Successful Syncs</p>
            <p className="text-4xl font-bold text-suse-pine">{jobs.filter((j) => j.status === 'completed').length}</p>
          </div>
          <div className="p-3 bg-suse-pine/10 rounded-xl">
            <CheckCircle2 className="text-suse-pine" size={24} />
          </div>
        </div>
        <div className="suse-card p-6 flex items-center justify-between">
          <div>
            <p className="text-gray-400 text-sm mb-1 uppercase tracking-widest font-semibold">Active Workers</p>
            <p className="text-4xl font-bold text-suse-water">01</p>
          </div>
          <div className="p-3 bg-suse-water/10 rounded-xl">
            <Zap className="text-suse-water" size={24} />
          </div>
        </div>
      </div>

      <div className="grid grid-cols-1 xl:grid-cols-2 gap-6">
        <div className="suse-card p-6">
          <h2 className="text-lg font-semibold mb-3">Project Owned</h2>
          <div className="space-y-2 max-h-48 overflow-y-auto">
            {ownedProjects.length === 0 ? (
              <p className="text-sm text-gray-500">No owned projects yet.</p>
            ) : (
              ownedProjects.map((project) => (
                <div key={project.id} className="border border-white/10 rounded-lg px-3 py-2 bg-black/10">
                  <p className="text-sm font-medium text-gray-100">{project.name}</p>
                  <p className="text-xs text-gray-500">Pipelines: {project.pipelineCount}</p>
                </div>
              ))
            )}
          </div>
        </div>
        <div className="suse-card p-6">
          <h2 className="text-lg font-semibold mb-3">Shared Projects</h2>
          <div className="space-y-2 max-h-48 overflow-y-auto">
            {sharedProjects.length === 0 ? (
              <p className="text-sm text-gray-500">No shared projects yet.</p>
            ) : (
              sharedProjects.map((project) => (
                <div key={project.id} className="border border-white/10 rounded-lg px-3 py-2 bg-black/10">
                  <p className="text-sm font-medium text-gray-100">{project.name}</p>
                  <p className="text-xs text-gray-500">Role: {project.role} • Pipelines: {project.pipelineCount}</p>
                </div>
              ))
            )}
          </div>
        </div>
      </div>

      {error ? <div className="bg-red-500/10 border border-red-500/30 rounded-xl p-3 text-red-300 text-sm">{error}</div> : null}
      {status ? <div className="bg-suse-pine/10 border border-suse-pine/30 rounded-xl p-3 text-suse-pine text-sm">{status}</div> : null}

      {editJobId ? (
        <div className="suse-card p-5 space-y-3">
          <h2 className="text-lg font-semibold flex items-center gap-2">
            <Pencil size={16} className="text-suse-pine" /> Edit Pipeline
          </h2>
          <div className="grid grid-cols-1 xl:grid-cols-[2fr_1fr] gap-2">
            <input
              value={editTitle}
              onChange={(event) => setEditTitle(event.target.value)}
              placeholder="Pipeline title"
              className="w-full bg-suse-dark/70 border border-white/10 rounded-lg px-3 py-2"
            />
            <select
              value={editStatus}
              onChange={(event) => setEditStatus(event.target.value as JobStatus)}
              className="w-full bg-suse-dark/70 border border-white/10 rounded-lg px-3 py-2"
            >
              <option value="pending">pending</option>
              <option value="processing">inprogress</option>
              <option value="completed">completed</option>
              <option value="failed">failed</option>
            </select>
          </div>
          <div className="flex gap-2">
            <button onClick={saveEdit} disabled={busy || !editTitle.trim()} className="suse-button-primary px-4 py-2">Save</button>
            <button onClick={() => setEditJobId('')} className="px-4 py-2 rounded-lg border border-white/10 hover:bg-white/5">Cancel</button>
          </div>
        </div>
      ) : null}

      <div className="suse-card overflow-hidden">
        <div className="p-6 border-b border-white/5 flex items-center justify-between">
          <h2 className="text-xl font-semibold">Recent Activity</h2>
          <div className="text-xs text-gray-500 uppercase tracking-widest">Local-First Feed</div>
        </div>

        {loading ? (
          <div className="p-20 flex justify-center">
            <div className="animate-spin rounded-full h-8 w-8 border-t-2 border-suse-pine"></div>
          </div>
        ) : jobs.length === 0 ? (
          <div className="p-20 text-center text-gray-500 flex flex-col items-center gap-4">
            <FileText size={48} className="opacity-20" />
            <p>No documentation pipelines found. Start by importing a Google Doc.</p>
          </div>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full text-left">
              <thead>
                <tr className="bg-white/5 text-gray-400 text-xs uppercase tracking-widest">
                  <th className="px-6 py-4 font-semibold">Title</th>
                  <th className="px-6 py-4 font-semibold">Status</th>
                  <th className="px-6 py-4 font-semibold">Project</th>
                  <th className="px-6 py-4 font-semibold">Created On</th>
                  <th className="px-6 py-4 font-semibold text-right">Action</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-white/5">
                {sortedJobs.map((job) => (
                  <motion.tr
                    key={job.id}
                    initial={{ opacity: 0 }}
                    animate={{ opacity: 1 }}
                    className="hover:bg-white/5 transition-colors group"
                  >
                    <td className="px-6 py-4">
                      <div className="flex flex-col">
                        <span className="font-medium text-gray-200">{job.googleDocTitle || 'Untitled pipeline'}</span>
                        <span className="text-[10px] font-mono text-gray-500 uppercase tracking-tight">{job.googleDocId || job.id}</span>
                      </div>
                    </td>
                    <td className="px-6 py-4">
                      <div className="flex items-center gap-2">
                        {getStatusIcon(job.status)}
                        <span className={clsx('text-xs font-semibold px-2 py-0.5 rounded uppercase tracking-wider', statusBadgeClass(job.status))}>
                          {displayStatus(job.status)}
                        </span>
                      </div>
                    </td>
                    <td className="px-6 py-4 text-sm text-gray-400">
                      {job.projectId ? projectNameById.get(job.projectId) || job.projectId : 'Unassigned'}
                    </td>
                    <td className="px-6 py-4 text-sm text-gray-400">
                      {job.createdAt ? new Date(job.createdAt).toLocaleString() : 'N/A'}
                    </td>
                    <td className="px-6 py-4">
                      <div className="flex items-center justify-end gap-2">
                        <Link to={`/job/${job.id}`} className="px-3 py-1.5 rounded-lg border border-white/10 hover:bg-white/5 text-xs inline-flex items-center gap-1">
                          <Eye size={12} /> View
                        </Link>
                        <button onClick={() => openEdit(job)} className="px-3 py-1.5 rounded-lg border border-white/10 hover:bg-white/5 text-xs inline-flex items-center gap-1">
                          <Pencil size={12} /> Edit
                        </button>
                        <button onClick={() => deletePipeline(job)} className="px-3 py-1.5 rounded-lg border border-red-500/40 text-red-300 hover:bg-red-500/10 text-xs inline-flex items-center gap-1">
                          <Trash2 size={12} /> Delete
                        </button>
                      </div>
                    </td>
                  </motion.tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>
    </div>
  );
}
