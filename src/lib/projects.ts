export type ProjectSummary = {
  id: string;
  name: string;
  slug: string;
  description: string;
  role: 'owner' | 'editor' | 'viewer';
  isAdminOverride?: boolean;
  isPersonal: boolean;
  ownerUserId: string;
  workspacePath?: string | null;
  gitRepo?: string | null;
  gitProvider?: string | null;
  gitDefaultBranch?: string | null;
  pipelineCount: number;
  createdAt: string;
  updatedAt: string;
};

const ACTIVE_PROJECT_KEY = 'active_project_id';

export const getActiveProjectId = () => localStorage.getItem(ACTIVE_PROJECT_KEY) || '';
export const setActiveProjectId = (projectId: string) => {
  localStorage.setItem(ACTIVE_PROJECT_KEY, projectId);
  window.dispatchEvent(new CustomEvent('active-project-changed', { detail: { projectId } }));
};
