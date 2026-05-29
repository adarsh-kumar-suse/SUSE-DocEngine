import React from 'react';
import axios from 'axios';
import { Link } from 'react-router-dom';
import { Eye, FileText, Pencil, Plus, RefreshCw, Trash2 } from 'lucide-react';
import { clsx } from 'clsx';
import { type ProjectSummary } from '../lib/projects';

type JobStatus = 'pending' | 'processing' | 'completed' | 'failed';

type JobRecord = {
  id: string;
  googleDocTitle?: string;
  googleDocId?: string;
  projectId?: string;
  outputFolderPath?: string;
  pipelineWorkspace?: {
    rootPath?: string;
    documentbase?: string;
    dcFileName?: string;
  };
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

export default function Pipelines() {
  const [jobs, setJobs] = React.useState<JobRecord[]>([]);
  const [projects, setProjects] = React.useState<ProjectSummary[]>([]);
  const [loading, setLoading] = React.useState(true);
  const [busy, setBusy] = React.useState(false);
  const [error, setError] = React.useState('');
  const [status, setStatus] = React.useState('');
  const [editJobId, setEditJobId] = React.useState('');
  const [editTitle, setEditTitle] = React.useState('');
  const [editStatus, setEditStatus] = React.useState<JobStatus>('pending');

  const fetchJobs = React.useCallback(async () => {
    try {
      setLoading(true);
      setError('');
      const [jobsRes, projectsRes] = await Promise.all([
        axios.get('/api/jobs'),
        axios.get('/api/projects').catch(() => ({ data: [] })),
      ]);
      const fetchedJobs = Array.isArray(jobsRes.data) ? (jobsRes.data as JobRecord[]) : [];
      const fetchedProjects = Array.isArray(projectsRes.data) ? (projectsRes.data as ProjectSummary[]) : [];
      setJobs(fetchedJobs);
      setProjects(fetchedProjects);
    } catch (err: unknown) {
      setError(getApiError(err, 'Failed to load pipelines.'));
      setJobs([]);
      setProjects([]);
    } finally {
      setLoading(false);
    }
  }, []);

  React.useEffect(() => {
    fetchJobs();
    const interval = setInterval(fetchJobs, 10000);
    return () => clearInterval(interval);
  }, [fetchJobs]);

  const runAction = async (action: () => Promise<void>, successMessage: string) => {
    try {
      setBusy(true);
      setError('');
      setStatus('');
      await action();
      setStatus(successMessage);
      await fetchJobs();
    } catch (err) {
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

  const projectNameById = React.useMemo(
    () =>
      new Map(
        projects.map((project) => [project.id, project.name]),
      ),
    [projects],
  );

  const sortedJobs = React.useMemo(
    () =>
      jobs
        .slice()
        .sort((a, b) => new Date(b.createdAt || 0).getTime() - new Date(a.createdAt || 0).getTime()),
    [jobs],
  );

  const inProgressCount = jobs.filter((job) => ['pending', 'processing'].includes(job.status || 'pending')).length;
  const unassignedCount = jobs.filter((job) => !job.projectId).length;
  const completedCount = jobs.filter((job) => job.status === 'completed').length;

  return (
    <div className="max-w-6xl mx-auto space-y-6">
      <div className="rounded-2xl border border-suse-pine/30 bg-gradient-to-r from-[#032328] via-[#06343d] to-[#102641] p-5">
        <div className="flex items-center justify-between gap-4">
          <div>
            <h1 className="text-3xl font-bold text-white">Pipelines</h1>
            <p className="text-gray-300 mt-1">Landing view of your pipelines with quick edit and delete actions.</p>
          </div>
          <div className="flex items-center gap-2">
            <button onClick={fetchJobs} className="suse-button-primary px-4 py-2 flex items-center gap-2" disabled={loading || busy}>
              <RefreshCw size={16} className={clsx((loading || busy) && 'animate-spin')} />
              Refresh
            </button>
            <Link to="/new" className="suse-button-primary px-4 py-2 flex items-center gap-2">
              <Plus size={16} />
              Add Pipeline
            </Link>
          </div>
        </div>
      </div>

      <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
        <div className="suse-card p-4">
          <p className="text-xs uppercase tracking-widest text-gray-500">In Progress Pipelines</p>
          <p className="text-2xl font-bold text-white mt-2">{inProgressCount}</p>
        </div>
        <div className="suse-card p-4">
          <p className="text-xs uppercase tracking-widest text-gray-500">Open Pipelines</p>
          <p className="text-2xl font-bold text-white mt-2">{unassignedCount}</p>
          <p className="text-[10px] text-gray-500 mt-1">Not assigned to any project</p>
        </div>
        <div className="suse-card p-4">
          <p className="text-xs uppercase tracking-widest text-gray-500">Git Sync</p>
          <p className="text-2xl font-bold text-white mt-2">{completedCount}</p>
          <p className="text-[10px] text-gray-500 mt-1">Completed pipelines</p>
        </div>
      </div>

      {error ? <div className="bg-red-500/10 border border-red-500/30 rounded-xl p-3 text-red-300 text-sm">{error}</div> : null}
      {status ? <div className="bg-suse-pine/10 border border-suse-pine/30 rounded-xl p-3 text-suse-pine text-sm">{status}</div> : null}

      {editJobId ? (
        <div className="suse-card p-5 space-y-3">
          <h2 className="text-lg font-semibold flex items-center gap-2"><Pencil size={16} className="text-suse-pine" /> Edit Pipeline</h2>
          <div className="grid grid-cols-1 xl:grid-cols-[2fr_1fr] gap-2">
            <input value={editTitle} onChange={(event) => setEditTitle(event.target.value)} placeholder="Pipeline title" className="w-full bg-suse-dark/70 border border-white/10 rounded-lg px-3 py-2" />
            <select value={editStatus} onChange={(event) => setEditStatus(event.target.value as JobStatus)} className="w-full bg-suse-dark/70 border border-white/10 rounded-lg px-3 py-2">
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
          <h2 className="text-xl font-semibold">Pipelines</h2>
          <div className="text-xs text-gray-500 uppercase tracking-widest">{jobs.length} Items</div>
        </div>

        {loading ? (
          <div className="p-20 text-center">
            <RefreshCw className="animate-spin mx-auto text-suse-pine" />
          </div>
        ) : jobs.length === 0 ? (
          <div className="p-16 text-center text-gray-500 flex flex-col items-center gap-4">
            <FileText size={48} className="opacity-30" />
            <p>No pipelines available. Click Add Pipeline to upload/link content.</p>
            <Link to="/new" className="suse-button-primary px-4 py-2 inline-flex items-center gap-2">
              <Plus size={16} /> Add Pipeline
            </Link>
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
                  <tr key={job.id} className="hover:bg-white/5 transition-colors">
                    <td className="px-6 py-4">
                      <div className="flex flex-col">
                        <span className="font-medium text-gray-200">{job.googleDocTitle || 'Untitled pipeline'}</span>
                        <span className="text-[10px] font-mono text-gray-500 uppercase">{job.googleDocId || job.id}</span>
                      </div>
                    </td>
                    <td className="px-6 py-4">
                      <span className={clsx('text-xs font-semibold px-2 py-0.5 rounded uppercase tracking-wider', statusBadgeClass(job.status))}>
                        {displayStatus(job.status)}
                      </span>
                    </td>
                    <td className="px-6 py-4 text-sm text-gray-400">
                      {job.projectId ? projectNameById.get(job.projectId) || job.projectId : 'Unassigned'}
                    </td>
                    <td className="px-6 py-4 text-sm text-gray-400">
                      {job.createdAt ? new Date(job.createdAt).toLocaleString() : 'N/A'}
                    </td>
                    <td className="px-6 py-4">
                      <div className="flex items-center justify-end gap-2">
                        <Link
                          to={job.pipelineWorkspace?.rootPath ? `/pipeline-studio/${job.id}` : `/job/${job.id}`}
                          className="px-3 py-1.5 rounded-lg border border-white/10 hover:bg-white/5 text-xs inline-flex items-center gap-1"
                        >
                          <Eye size={12} /> {job.pipelineWorkspace?.rootPath ? 'Studio' : 'View'}
                        </Link>
                        <button onClick={() => openEdit(job)} className="px-3 py-1.5 rounded-lg border border-white/10 hover:bg-white/5 text-xs inline-flex items-center gap-1">
                          <Pencil size={12} /> Edit
                        </button>
                        <button onClick={() => deletePipeline(job)} className="px-3 py-1.5 rounded-lg border border-red-500/40 text-red-300 hover:bg-red-500/10 text-xs inline-flex items-center gap-1">
                          <Trash2 size={12} /> Delete
                        </button>
                      </div>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>
    </div>
  );
}
