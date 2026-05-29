import React from 'react';
import axios from 'axios';
import { clsx } from 'clsx';
import { FolderGit2, Link2, Pencil, Plus, RefreshCw, Trash2, Users } from 'lucide-react';
import { getActiveProjectId, setActiveProjectId, type ProjectSummary } from '../lib/projects';

type Scope = 'owned' | 'shared';

type Member = {
  userId: string;
  role: 'owner' | 'editor' | 'viewer';
  email: string;
  displayName: string;
  status: string;
};

type Invite = {
  id: string;
  email: string;
  role: 'owner' | 'editor' | 'viewer';
  status: string;
  created_at: string;
};

type ProjectPipeline = {
  id: string;
  name: string;
  slug: string;
  default_branch: string;
  latest_version_no: number;
  branch_count?: number;
  open_merge_requests?: number;
};

type AttachablePipeline = {
  id: string;
  title: string;
  status?: string;
  linkedProjects: string[];
  inCurrentProject: boolean;
};

const getApiError = (err: unknown, fallback: string) => {
  const maybeAxios = err as { response?: { data?: { error?: { message?: string } } }; message?: string };
  return maybeAxios?.response?.data?.error?.message || maybeAxios?.message || fallback;
};

const safeArray = <T,>(value: unknown) => (Array.isArray(value) ? (value as T[]) : []);

function CollaborationWorkspace({ scope }: { scope: Scope }) {
  const [projects, setProjects] = React.useState<ProjectSummary[]>([]);
  const [activeProjectId, setActiveProjectIdState] = React.useState(getActiveProjectId());

  const [members, setMembers] = React.useState<Member[]>([]);
  const [invites, setInvites] = React.useState<Invite[]>([]);
  const [pipelines, setPipelines] = React.useState<ProjectPipeline[]>([]);
  const [attachable, setAttachable] = React.useState<AttachablePipeline[]>([]);

  const [loading, setLoading] = React.useState(true);
  const [busy, setBusy] = React.useState(false);
  const [status, setStatus] = React.useState('');
  const [error, setError] = React.useState('');

  const [showCreateProject, setShowCreateProject] = React.useState(false);
  const [newProjectName, setNewProjectName] = React.useState('');
  const [newProjectRepo, setNewProjectRepo] = React.useState('');
  const [newProjectDefaultBranch, setNewProjectDefaultBranch] = React.useState('main');
  const [showEditProject, setShowEditProject] = React.useState(false);
  const [editProjectId, setEditProjectId] = React.useState('');
  const [editProjectName, setEditProjectName] = React.useState('');
  const [editProjectRepo, setEditProjectRepo] = React.useState('');
  const [editProjectDefaultBranch, setEditProjectDefaultBranch] = React.useState('main');
  const [deleteTarget, setDeleteTarget] = React.useState<ProjectSummary | null>(null);
  const [deleteConfirmText, setDeleteConfirmText] = React.useState('');
  const [inviteEmail, setInviteEmail] = React.useState('');
  const [inviteRole, setInviteRole] = React.useState<'owner' | 'editor' | 'viewer'>('editor');
  const [selectedAttachJobId, setSelectedAttachJobId] = React.useState('');

  const activeProject = projects.find((project) => project.id === activeProjectId);
  const isOwnerRole = activeProject?.role === 'owner';
  const canWrite = activeProject ? activeProject.role === 'owner' || activeProject.role === 'editor' : false;

  const loadProjects = React.useCallback(async (): Promise<string> => {
    const [projectsRes, settingsRes] = await Promise.all([
      axios.get('/api/projects'),
      axios.get('/api/user/settings').catch(() => ({ data: { defaultRepo: '' } })),
    ]);
    const fetched = safeArray<ProjectSummary>(projectsRes.data);
    const scoped = fetched.filter((project) => (scope === 'owned' ? project.role === 'owner' : project.role !== 'owner'));
    setProjects(scoped);
    if (!newProjectRepo.trim()) {
      setNewProjectRepo((settingsRes.data?.defaultRepo as string) || '');
    }
    if (scoped.length === 0) {
      setActiveProjectId('');
      setActiveProjectIdState('');
      return '';
    }
    const current = getActiveProjectId();
    const effective = scoped.some((project) => project.id === current) ? current : scoped[0].id;
    setActiveProjectId(effective);
    setActiveProjectIdState(effective);
    return effective;
  }, [newProjectRepo, scope]);

  const loadProjectData = React.useCallback(async (projectId: string) => {
    if (!projectId) {
      setMembers([]);
      setInvites([]);
      setPipelines([]);
      setAttachable([]);
      setSelectedAttachJobId('');
      return;
    }

    const [membersRes, invitesRes, pipelinesRes, attachableRes] = await Promise.all([
      axios.get(`/api/projects/${projectId}/members`).catch(() => ({ data: [] })),
      axios.get(`/api/projects/${projectId}/invites`).catch(() => ({ data: [] })),
      axios.get(`/api/projects/${projectId}/pipelines`).catch(() => ({ data: [] })),
      axios.get(`/api/projects/${projectId}/attachable-pipelines`).catch(() => ({ data: { items: [] } })),
    ]);

    const attachableItems = safeArray<AttachablePipeline>(attachableRes.data?.items);
    setMembers(safeArray<Member>(membersRes.data));
    setInvites(safeArray<Invite>(invitesRes.data));
    setPipelines(safeArray<ProjectPipeline>(pipelinesRes.data));
    setAttachable(attachableItems);
    setSelectedAttachJobId((prev) => {
      if (prev && attachableItems.some((item) => item.id === prev)) return prev;
      const firstNew = attachableItems.find((item) => !item.inCurrentProject);
      return firstNew?.id || attachableItems[0]?.id || '';
    });
  }, []);

  const refreshAll = React.useCallback(async () => {
    try {
      setLoading(true);
      setError('');
      const projectId = await loadProjects();
      await loadProjectData(projectId);
    } catch (err) {
      setError(getApiError(err, 'Failed to load collaboration data.'));
    } finally {
      setLoading(false);
    }
  }, [loadProjectData, loadProjects]);

  React.useEffect(() => {
    refreshAll();
    const onProjectChanged = async (event: Event) => {
      const custom = event as CustomEvent<{ projectId: string }>;
      const projectId = custom.detail?.projectId || '';
      setActiveProjectIdState(projectId);
      try {
        await loadProjectData(projectId);
      } catch (err) {
        setError(getApiError(err, 'Failed to switch project.'));
      }
    };
    window.addEventListener('active-project-changed', onProjectChanged);
    return () => window.removeEventListener('active-project-changed', onProjectChanged);
  }, [loadProjectData, refreshAll]);

  const runAction = async (action: () => Promise<void>, successMessage: string) => {
    try {
      setBusy(true);
      setError('');
      setStatus('');
      await action();
      setStatus(successMessage);
      await loadProjectData(getActiveProjectId());
    } catch (err) {
      setError(getApiError(err, 'Action failed.'));
    } finally {
      setBusy(false);
    }
  };

  const createProject = async () => {
    if (!newProjectName.trim() || !newProjectRepo.trim()) return;
    await runAction(async () => {
      const response = await axios.post('/api/projects', {
        name: newProjectName.trim(),
        gitRepo: newProjectRepo.trim(),
        gitDefaultBranch: newProjectDefaultBranch.trim() || 'main',
      });
      const projectId = response.data?.id as string | undefined;
      setShowCreateProject(false);
      setNewProjectName('');
      const nextActiveProject = projectId || (await loadProjects());
      if (nextActiveProject) {
        setActiveProjectId(nextActiveProject);
        setActiveProjectIdState(nextActiveProject);
      }
    }, 'Project created.');
  };

  const openEditProject = (project: ProjectSummary) => {
    setShowEditProject(true);
    setEditProjectId(project.id);
    setEditProjectName(project.name || '');
    setEditProjectRepo(project.gitRepo || '');
    setEditProjectDefaultBranch(project.gitDefaultBranch || 'main');
  };

  const saveProjectEdits = async () => {
    if (!editProjectId || !editProjectName.trim()) return;
    await runAction(async () => {
      await axios.patch(`/api/projects/${editProjectId}`, {
        name: editProjectName.trim(),
        gitRepo: editProjectRepo.trim(),
        gitDefaultBranch: editProjectDefaultBranch.trim() || 'main',
      });
      setShowEditProject(false);
      setEditProjectId('');
      const effectiveProjectId = await loadProjects();
      await loadProjectData(effectiveProjectId);
    }, 'Project updated.');
  };

  const deleteProject = async () => {
    if (!deleteTarget) return;
    if (deleteConfirmText.trim() !== deleteTarget.name.trim()) {
      setError('Type the exact project name to confirm delete.');
      return;
    }
    try {
      setBusy(true);
      setError('');
      setStatus('');
      await axios.delete(`/api/projects/${deleteTarget.id}`);
      const nextProjectId = await loadProjects();
      await loadProjectData(nextProjectId);
      setDeleteTarget(null);
      setDeleteConfirmText('');
      setStatus('Project deleted.');
    } catch (err) {
      setError(getApiError(err, 'Failed to delete project.'));
    } finally {
      setBusy(false);
    }
  };

  const createInvite = async () => {
    if (!activeProjectId || !inviteEmail.trim() || !isOwnerRole) return;
    await runAction(async () => {
      await axios.post(`/api/projects/${activeProjectId}/invites`, {
        email: inviteEmail.trim(),
        role: inviteRole,
      });
      setInviteEmail('');
    }, 'Invite sent.');
  };

  const attachPipeline = async () => {
    if (!activeProjectId || !selectedAttachJobId || !canWrite) return;
    const selected = attachable.find((item) => item.id === selectedAttachJobId);
    const name = selected?.title || `pipeline-${selectedAttachJobId.slice(-6)}`;
    await runAction(async () => {
      await axios.post(`/api/projects/${activeProjectId}/pipelines`, {
        name,
        baseJobId: selectedAttachJobId,
      });
      setSelectedAttachJobId('');
    }, 'Pipeline attached to project.');
  };

  const attachDisabledReason = !activeProject
    ? 'Select a project first.'
    : !canWrite
      ? 'Your authority is read-only in this shared project.'
      : attachable.length === 0
        ? 'No pipeline available. Create pipeline first from New Pipeline.'
        : !selectedAttachJobId
          ? 'Select a pipeline to attach.'
          : attachable.find((item) => item.id === selectedAttachJobId)?.inCurrentProject
            ? 'Selected pipeline is already attached to this project.'
            : '';

  if (loading) {
    return (
      <div className="p-20 text-center">
        <RefreshCw className="animate-spin mx-auto text-suse-pine" />
      </div>
    );
  }

  return (
    <div className="max-w-7xl mx-auto space-y-6 pb-8">
      <div className="rounded-2xl border border-suse-pine/30 bg-gradient-to-r from-[#052a2a] via-[#073535] to-[#0a1f33] p-5">
        <div className="flex items-center justify-between gap-4">
          <div>
            <h1 className="text-3xl font-bold text-white flex items-center gap-3">
              <FolderGit2 className="text-suse-pine" />
              {scope === 'owned' ? 'Project Owned' : 'Shared Projects'}
            </h1>
            <p className="text-gray-300 mt-1">
              {scope === 'owned'
                ? 'Landing page for your owned projects. Open a project to manage collaborators and attach pipelines.'
                : 'Landing page for projects shared with you. Open a project to view authority and attach your own pipelines.'}
            </p>
          </div>
          <div className="flex gap-2">
            <button onClick={refreshAll} className="suse-button-primary px-4 py-2 flex items-center gap-2" disabled={busy}>
              <RefreshCw size={16} className={clsx(busy && 'animate-spin')} />
              Refresh
            </button>
            {scope === 'owned' ? (
              <button onClick={() => setShowCreateProject((prev) => !prev)} className="suse-button-primary px-4 py-2 flex items-center gap-2">
                <Plus size={16} />
                Add Project
              </button>
            ) : null}
          </div>
        </div>
      </div>

      {error ? <div className="bg-red-500/10 border border-red-500/30 rounded-xl p-3 text-red-300 text-sm">{error}</div> : null}
      {status ? <div className="bg-suse-pine/10 border border-suse-pine/30 rounded-xl p-3 text-suse-pine text-sm">{status}</div> : null}

      {showCreateProject && scope === 'owned' ? (
        <div className="suse-card p-5 space-y-3">
          <h2 className="text-lg font-semibold flex items-center gap-2"><Plus size={16} className="text-suse-pine" /> Create Project</h2>
          <div className="grid grid-cols-1 xl:grid-cols-3 gap-2">
            <input value={newProjectName} onChange={(event) => setNewProjectName(event.target.value)} placeholder="Project name" className="w-full bg-suse-dark/70 border border-white/10 rounded-lg px-3 py-2" />
            <input value={newProjectRepo} onChange={(event) => setNewProjectRepo(event.target.value)} placeholder="owner/repo (required)" className="w-full bg-suse-dark/70 border border-white/10 rounded-lg px-3 py-2 font-mono text-sm" />
            <input value={newProjectDefaultBranch} onChange={(event) => setNewProjectDefaultBranch(event.target.value)} placeholder="Default branch (main)" className="w-full bg-suse-dark/70 border border-white/10 rounded-lg px-3 py-2" />
          </div>
          <div className="flex gap-2">
            <button onClick={createProject} disabled={busy || !newProjectName.trim() || !newProjectRepo.trim()} className="suse-button-primary px-4 py-2">Create Project</button>
            <button onClick={() => setShowCreateProject(false)} className="px-4 py-2 rounded-lg border border-white/10 hover:bg-white/5">Cancel</button>
          </div>
        </div>
      ) : null}

      {showEditProject && scope === 'owned' ? (
        <div className="suse-card p-5 space-y-3">
          <h2 className="text-lg font-semibold flex items-center gap-2"><Pencil size={16} className="text-suse-pine" /> Edit Project</h2>
          <div className="grid grid-cols-1 xl:grid-cols-3 gap-2">
            <input value={editProjectName} onChange={(event) => setEditProjectName(event.target.value)} placeholder="Project name" className="w-full bg-suse-dark/70 border border-white/10 rounded-lg px-3 py-2" />
            <input value={editProjectRepo} onChange={(event) => setEditProjectRepo(event.target.value)} placeholder="owner/repo (required)" className="w-full bg-suse-dark/70 border border-white/10 rounded-lg px-3 py-2 font-mono text-sm" />
            <input value={editProjectDefaultBranch} onChange={(event) => setEditProjectDefaultBranch(event.target.value)} placeholder="Default branch (main)" className="w-full bg-suse-dark/70 border border-white/10 rounded-lg px-3 py-2" />
          </div>
          <div className="flex gap-2">
            <button onClick={saveProjectEdits} disabled={busy || !editProjectName.trim()} className="suse-button-primary px-4 py-2">Save Changes</button>
            <button onClick={() => setShowEditProject(false)} className="px-4 py-2 rounded-lg border border-white/10 hover:bg-white/5">Cancel</button>
          </div>
        </div>
      ) : null}

      {deleteTarget && scope === 'owned' ? (
        <div className="suse-card p-5 space-y-3 border border-red-500/40">
          <h2 className="text-lg font-semibold text-red-300 flex items-center gap-2"><Trash2 size={16} /> Delete Project</h2>
          <p className="text-sm text-gray-300">
            Delete <span className="font-semibold text-white">{deleteTarget.name}</span>. This will remove collaboration records for this project.
            Jobs will be reassigned to your personal project.
          </p>
          <p className="text-xs text-gray-400">Type <span className="font-mono text-white">{deleteTarget.name}</span> to confirm.</p>
          <input value={deleteConfirmText} onChange={(event) => setDeleteConfirmText(event.target.value)} placeholder="Type project name to confirm" className="w-full bg-suse-dark/70 border border-white/10 rounded-lg px-3 py-2" />
          <div className="flex gap-2">
            <button onClick={deleteProject} disabled={busy || deleteConfirmText.trim() !== deleteTarget.name.trim()} className="px-4 py-2 rounded-lg bg-red-600/90 hover:bg-red-600 text-white disabled:opacity-60">Delete Project</button>
            <button onClick={() => { setDeleteTarget(null); setDeleteConfirmText(''); }} className="px-4 py-2 rounded-lg border border-white/10 hover:bg-white/5">Cancel</button>
          </div>
        </div>
      ) : null}

      <div className="suse-card overflow-hidden">
        <div className="p-5 border-b border-white/5 flex items-center justify-between">
          <h2 className="text-lg font-semibold">{scope === 'owned' ? 'Owned Project List' : 'Shared Project List'}</h2>
          <span className="text-xs uppercase tracking-widest text-gray-500">{projects.length} project(s)</span>
        </div>
        {projects.length === 0 ? (
          <div className="p-14 text-center text-gray-400">
            <p>{scope === 'owned' ? 'No owned project yet.' : 'No shared project yet.'}</p>
            {scope === 'owned' ? (
              <button onClick={() => setShowCreateProject(true)} className="suse-button-primary mt-4 px-4 py-2 inline-flex items-center gap-2">
                <Plus size={16} /> Add Project
              </button>
            ) : null}
          </div>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full text-left">
              <thead>
                <tr className="bg-white/5 text-gray-400 text-xs uppercase tracking-widest">
                  <th className="px-5 py-3 font-semibold">Project</th>
                  <th className="px-5 py-3 font-semibold">Repository</th>
                  <th className="px-5 py-3 font-semibold">Authority</th>
                  <th className="px-5 py-3 font-semibold">Pipelines</th>
                  <th className="px-5 py-3 font-semibold text-right">Actions</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-white/5">
                {projects.map((project) => (
                  <tr key={project.id} className={clsx('hover:bg-white/5', activeProjectId === project.id && 'bg-suse-pine/10')}>
                    <td className="px-5 py-3">
                      <p className="font-semibold text-white">{project.name}</p>
                      {project.isPersonal ? <p className="text-[10px] uppercase tracking-widest text-gray-500 mt-1">Personal</p> : null}
                    </td>
                    <td className="px-5 py-3 text-xs font-mono text-gray-400">{project.gitRepo || 'repo not configured'}</td>
                    <td className="px-5 py-3 text-xs uppercase tracking-widest text-suse-pine">{project.role}</td>
                    <td className="px-5 py-3 text-sm text-gray-400">{project.pipelineCount}</td>
                    <td className="px-5 py-3">
                      <div className="flex items-center justify-end gap-2">
                        <button
                          onClick={async () => {
                            setActiveProjectId(project.id);
                            setActiveProjectIdState(project.id);
                            await loadProjectData(project.id);
                          }}
                          className="px-3 py-1.5 rounded-lg border border-white/10 hover:bg-white/5 text-xs"
                        >
                          Open
                        </button>
                        {scope === 'owned' ? (
                          <>
                            <button onClick={() => openEditProject(project)} className="px-3 py-1.5 rounded-lg border border-white/10 hover:bg-white/5 text-xs inline-flex items-center gap-1">
                              <Pencil size={12} /> Edit
                            </button>
                            <button
                              onClick={() => {
                                setDeleteTarget(project);
                                setDeleteConfirmText('');
                              }}
                              disabled={project.isPersonal}
                              className="px-3 py-1.5 rounded-lg border border-red-500/40 text-red-300 hover:bg-red-500/10 text-xs inline-flex items-center gap-1 disabled:opacity-50"
                            >
                              <Trash2 size={12} /> Delete
                            </button>
                          </>
                        ) : null}
                      </div>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>

      {activeProject ? (
        <div className="grid grid-cols-1 xl:grid-cols-2 gap-6">
          <div className="suse-card p-5 space-y-4">
            <h3 className="font-semibold text-lg">Project Details</h3>
            <div className="rounded-lg border border-white/10 bg-black/10 p-4 space-y-2">
              <p className="text-sm text-white"><span className="text-gray-400">Name:</span> {activeProject.name}</p>
              <p className="text-sm text-white"><span className="text-gray-400">Authority:</span> {activeProject.role}{activeProject.isAdminOverride ? ' (admin override)' : ''}</p>
              <p className="text-sm text-white"><span className="text-gray-400">Repository:</span> {activeProject.gitRepo || '-'}</p>
              <p className="text-sm text-white"><span className="text-gray-400">Default Branch:</span> {activeProject.gitDefaultBranch || 'main'}</p>
            </div>

            {scope === 'owned' ? (
              <div className="space-y-3">
                <h4 className="font-semibold flex items-center gap-2"><Users size={14} className="text-suse-pine" /> Invite Collaborator</h4>
                <input value={inviteEmail} onChange={(event) => setInviteEmail(event.target.value)} placeholder="collaborator@email.com" className="w-full bg-suse-dark/70 border border-white/10 rounded-lg px-3 py-2" />
                <select value={inviteRole} onChange={(event) => setInviteRole(event.target.value as 'owner' | 'editor' | 'viewer')} className="w-full bg-suse-dark/70 border border-white/10 rounded-lg px-3 py-2">
                  <option value="owner">Owner</option>
                  <option value="editor">Editor</option>
                  <option value="viewer">Viewer</option>
                </select>
                <button onClick={createInvite} disabled={busy || !inviteEmail.trim() || !isOwnerRole} className="suse-button-primary w-full py-2">
                  Send Invite
                </button>
                {!isOwnerRole ? <p className="text-xs text-gray-400">Only owners can invite and manage collaborator roles.</p> : null}
              </div>
            ) : (
              <div className="rounded-lg border border-white/10 bg-black/10 p-4">
                <p className="text-sm text-gray-300">
                  Shared project authority: <span className="text-suse-pine font-semibold">{activeProject.role}</span>.
                  {activeProject.role === 'viewer' ? ' Read-only access.' : ' You can attach and publish your own pipelines.'}
                </p>
              </div>
            )}
          </div>

          <div className="suse-card p-5 space-y-4">
            <h3 className="font-semibold text-lg flex items-center gap-2"><Link2 size={16} className="text-suse-pine" /> Attach Existing Pipeline</h3>
            <select value={selectedAttachJobId} onChange={(event) => setSelectedAttachJobId(event.target.value)} disabled={!!attachDisabledReason && attachable.length === 0} className="w-full bg-suse-dark/70 border border-white/10 rounded-lg px-3 py-2">
              <option value="">Select your personal pipeline</option>
              {attachable.map((item) => (
                <option key={item.id} value={item.id}>
                  {item.title}{item.inCurrentProject ? ' (Already attached)' : ''}
                </option>
              ))}
            </select>
            <button onClick={attachPipeline} disabled={busy || !!attachDisabledReason} className="suse-button-primary w-full py-2">
              Attach Pipeline
            </button>
            {attachDisabledReason ? <p className="text-xs text-gray-400">{attachDisabledReason}</p> : null}

            <div className="rounded-lg border border-white/10 bg-black/10 p-3 space-y-2 max-h-[220px] overflow-y-auto">
              <p className="text-xs uppercase tracking-widest text-gray-500">Attached Pipelines</p>
              {pipelines.length === 0 ? (
                <p className="text-sm text-gray-500">No attached pipeline yet.</p>
              ) : (
                pipelines.map((pipeline) => (
                  <div key={pipeline.id} className="rounded-lg border border-white/10 px-3 py-2">
                    <p className="text-sm text-white">{pipeline.name}</p>
                    <p className="text-xs text-gray-500">Branch: {pipeline.default_branch} | Version: {pipeline.latest_version_no}</p>
                  </div>
                ))
              )}
            </div>
          </div>

          <div className="suse-card p-5 xl:col-span-2">
            <h3 className="font-semibold text-lg mb-3">Collaborators</h3>
            <div className="grid grid-cols-1 xl:grid-cols-2 gap-4">
              <div className="rounded-lg border border-white/10 bg-black/10 p-3 space-y-2 max-h-[260px] overflow-y-auto">
                <p className="text-xs uppercase tracking-widest text-gray-500">Members</p>
                {members.length === 0 ? (
                  <p className="text-sm text-gray-500">No members found.</p>
                ) : (
                  members.map((member) => (
                    <div key={member.userId} className="rounded border border-white/10 px-3 py-2">
                      <p className="text-sm text-white">{member.displayName || member.email}</p>
                      <p className="text-xs text-gray-500">{member.email} - {member.role}</p>
                    </div>
                  ))
                )}
              </div>
              <div className="rounded-lg border border-white/10 bg-black/10 p-3 space-y-2 max-h-[260px] overflow-y-auto">
                <p className="text-xs uppercase tracking-widest text-gray-500">Pending Invites</p>
                {invites.length === 0 ? (
                  <p className="text-sm text-gray-500">No pending invites.</p>
                ) : (
                  invites.map((invite) => (
                    <div key={invite.id} className="rounded border border-white/10 px-3 py-2">
                      <p className="text-sm text-white">{invite.email}</p>
                      <p className="text-xs text-gray-500">{invite.status} - {invite.role} - {new Date(invite.created_at).toLocaleString()}</p>
                    </div>
                  ))
                )}
              </div>
            </div>
          </div>
        </div>
      ) : (
        <div className="suse-card p-10 text-center text-gray-500">Select a project from the list to open details.</div>
      )}
    </div>
  );
}

export function OwnedProjectsWorkspace() {
  return <CollaborationWorkspace scope="owned" />;
}

export function SharedProjectsWorkspace() {
  return <CollaborationWorkspace scope="shared" />;
}

export default OwnedProjectsWorkspace;
