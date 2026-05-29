import React, { useState, useEffect } from 'react';
import { useParams } from 'react-router-dom';
import { 
  FileCode, 
  Github, 
  Save, 
  Play, 
  RefreshCw, 
  ChevronRight, 
  ExternalLink,
  MessageSquare,
  Zap,
  CheckCircle2,
  Loader2,
  Download,
  File,
  Split,
  GitBranch,
  Settings2,
  Terminal,
  Wand2,
  MoreHorizontal,
  Layout,
  Maximize2
} from 'lucide-react';
import { motion, AnimatePresence } from 'motion/react';
import axios from 'axios';
import { clsx } from 'clsx';

type ApiErrorDetails = {
  phase?: string;
  hints?: string[];
  details?: unknown;
};

const formatApiErrorDetails = (value: ApiErrorDetails | unknown) => {
  if (!value || typeof value !== 'object') return [] as string[];
  const details = value as ApiErrorDetails;
  const parts: string[] = [];
  if (details.phase) parts.push(`Phase: ${details.phase}`);
  if (Array.isArray(details.hints) && details.hints.length > 0) {
    parts.push(`Check: ${details.hints.join(', ')}`);
  }
  if (typeof details.details === 'string' && details.details.trim()) {
    parts.push(details.details.trim());
  }
  return parts;
};

export default function JobDetail() {
  const { id } = useParams();
  const [job, setJob] = useState<any>(null);
  const [loading, setLoading] = useState(true);
  const [processing, setProcessing] = useState(false);
  const [syncing, setSyncing] = useState(false);
  const [showTools, setShowTools] = useState(false);
  const [previewContent, setPreviewContent] = useState('');
  const [renderMode, setRenderMode] = useState<'html' | 'pdf'>('html');
  const [renderPreviewUrl, setRenderPreviewUrl] = useState('');
  const [rendering, setRendering] = useState(false);
  const [renderError, setRenderError] = useState<string | null>(null);
  const [isRenderFullscreen, setIsRenderFullscreen] = useState(false);
  const [githubConfig, setGithubConfig] = useState({
    repo: '',
    branch: localStorage.getItem('suse_branch') || 'main',
    path: '',
    message: 'docs: transformed from Google Doc'
  });

  const [extractionData, setExtractionData] = useState<any>(null);
  const [loadingExtraction, setLoadingExtraction] = useState(false);
  const [allExtractions, setAllExtractions] = useState<string[]>([]);

  const toApiErrorMessage = (err: unknown, fallback: string) => {
    const apiError = (err as { response?: { data?: { error?: ({ message?: string; details?: ApiErrorDetails | string } & ApiErrorDetails) | string } } })
      ?.response?.data?.error;
    if (typeof apiError === 'string') return apiError;
    if (typeof apiError === 'object' && apiError?.message) {
      const parts = [apiError.message];
      if (apiError.phase || apiError.hints || typeof apiError.details === 'string') {
        parts.push(...formatApiErrorDetails(apiError));
      } else if (typeof apiError.details === 'object' && apiError.details) {
        parts.push(...formatApiErrorDetails(apiError.details));
      }
      return parts.join('\n');
    }
    return (err as Error)?.message || fallback;
  };

  const fetchJob = async () => {
    try {
      const response = await axios.get(`/api/jobs/${id}`);
      const data = response.data;
      setJob(data);
      if (data.asciiDocContent && !previewContent) setPreviewContent(data.asciiDocContent);
      
      // Auto-run transformation if pending
      if (data.status === 'pending' && !processing) {
        startTransformation(data);
      }

      // Fetch extraction data if path exists
      if (data.localExtractionPath) {
        fetchExtraction(data.localExtractionPath);
      }

      // Fetch all extractions to "see" the folder
      const extList = await axios.get('/api/extractions');
      setAllExtractions(extList.data);

      // Resolve repo precedence: project repo > user default repo
      let resolvedRepo = '';
      if (data?.projectId) {
        try {
          const projectRes = await axios.get(`/api/projects/${data.projectId}`);
          resolvedRepo = projectRes.data?.gitRepo || '';
        } catch {}
      }
      if (!resolvedRepo) {
        try {
          const settingsRes = await axios.get('/api/user/settings');
          resolvedRepo = settingsRes.data?.defaultRepo || '';
        } catch {}
      }
      if (resolvedRepo) {
        setGithubConfig((prev) => ({ ...prev, repo: resolvedRepo }));
      }
    } catch (error) {
      console.error('Error fetching job:', error);
    } finally {
      if (loading) setLoading(false);
    }
  };

  const fetchExtraction = async (fullPath: string) => {
    try {
      setLoadingExtraction(true);
      // Handle potential absolute paths from before or relative paths
      let relativePath = fullPath;
      if (fullPath.includes('data/')) {
        relativePath = fullPath.split('data/').pop() || fullPath;
      }
      
      const response = await axios.get(`/api/extractions-content`, {
        params: { path: relativePath }
      });
      setExtractionData(response.data);
    } catch (e) {
      console.error('Failed to fetch extraction:', e);
    } finally {
      setLoadingExtraction(false);
    }
  };

  useEffect(() => {
    if (!id) return;
    fetchJob();
    
    // Poll for status updates while processing or pending
    const interval = setInterval(() => {
      if (job?.status === 'processing' || job?.status === 'pending') {
        fetchJob();
      }
    }, 3000);
    
    return () => clearInterval(interval);
  }, [id, job?.status]);

  useEffect(() => {
    setRenderPreviewUrl('');
    setRenderError(null);
  }, [renderMode, id]);

  const startTransformation = async (currentJob: any) => {
    setProcessing(true);
    try {
      // Update local status to processing
      await axios.patch(`/api/jobs/${currentJob.id}`, { status: 'processing' });

      // Get token from localStorage
      const accessToken = localStorage.getItem('google_token');
      
      const response = await axios.post('/api/transform', {
        jobId: currentJob.id,
        docId: currentJob.googleDocId,
        accessToken,
        manualContent: currentJob.manualContent || null,
        metadata: currentJob.metadata
      });

      const updatedJob = await axios.patch(`/api/jobs/${currentJob.id}`, {
        asciiDocContent: response.data.adoc,
        googleDocTitle: response.data.title,
        status: 'completed'
      });
      
      setJob(updatedJob.data);
      setPreviewContent(response.data.adoc);
      setGithubConfig(prev => ({ ...prev, path: `${response.data.title?.toLowerCase().replace(/\s+/g, '-') || 'doc'}.adoc` }));

    } catch (error: any) {
      console.error(error);
      const errorMessage = toApiErrorMessage(error, 'Transformation failed.');
      await axios.patch(`/api/jobs/${currentJob.id}`, { status: 'failed', error: errorMessage });
      fetchJob(); // Refresh state
    } finally {
      setProcessing(false);
    }
  };

  const handleDownload = () => {
    if (!previewContent) return;
    const blob = new Blob([previewContent], { type: 'text/plain' });
    const url = window.URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `${job?.googleDocTitle || 'document'}.adoc`;
    document.body.appendChild(a);
    a.click();
    window.URL.revokeObjectURL(url);
    document.body.removeChild(a);
  };

  const handleSyncToGitHub = async () => {
    if (!job || !previewContent) return;
    setSyncing(true);
    try {
      const settingsRes = await axios.get('/api/user/settings');
      const githubToken = settingsRes.data?.githubToken || '';
      if (!githubToken) {
        alert('Please configure your GitHub token in Settings first.');
        setSyncing(false);
        return;
      }

      const response = await axios.post('/api/sync', {
        jobId: job.id,
        githubToken,
        repo: githubConfig.repo,
        branch: githubConfig.branch,
        path: githubConfig.path,
        content: previewContent,
        message: githubConfig.message
      });

      if (response.data.success) {
        await axios.patch(`/api/jobs/${job.id}`, {
          githubPrUrl: response.data.url
        });
        fetchJob(); // Refresh state
        alert('Successfully synced to GitHub!');
      }
    } catch (error: any) {
      alert(`Sync failed: ${toApiErrorMessage(error, 'Sync failed.')}`);
    } finally {
      setSyncing(false);
    }
  };

  const runDapsRender = async () => {
    if (!job?.id) return;
    setRendering(true);
    setRenderError(null);
    setRenderPreviewUrl('');
    try {
      await axios.patch(`/api/jobs/${job.id}`, { asciiDocContent: previewContent });
      const response = await axios.post('/api/render', {
        jobId: job.id,
        format: renderMode,
      });
      const requestPath = response.data?.requestPath;
      if (!requestPath) {
        throw new Error('Render output path missing.');
      }
      // Validate the rendered file is accessible before showing the iframe.
      await axios.head(requestPath);
      setRenderPreviewUrl(requestPath);
    } catch (err: unknown) {
      const message = toApiErrorMessage(err, 'Render failed.');
      setRenderError(message);
    } finally {
      setRendering(false);
    }
  };

  if (loading) return <div className="p-20 text-center"><Loader2 className="animate-spin mx-auto text-suse-pine" /></div>;
  if (!job) return <div className="p-20 text-center">Pipeline not found.</div>;

  return (
    <div className="h-full flex flex-col space-y-4 max-h-screen">
      {/* Precision Header */}
      <div className="flex justify-between items-center bg-suse-jungle/10 border border-white/5 p-4 rounded-2xl backdrop-blur-xl shrink-0">
        <div className="flex items-center gap-4">
          <div className="flex flex-col">
            <div className="flex items-center gap-2 mb-0.5">
              <h1 className="text-xl font-black text-white tracking-tight uppercase tracking-widest">{job.googleDocTitle || 'Initializing...'}</h1>
              <div className={clsx(
                "px-2 py-0.5 rounded-full text-[9px] font-black uppercase tracking-tighter shadow-sm",
                job.status === 'completed' ? "bg-suse-pine/20 text-suse-pine border border-suse-pine/30" : "bg-suse-water/20 text-suse-water border border-suse-water/30 animate-pulse"
              )}>
                {job.status}
              </div>
            </div>
            <div className="flex items-center gap-2 font-mono text-[9px] text-gray-500 uppercase tracking-widest">
              <Terminal size={10} className="text-suse-pine" />
              DocId: {job.googleDocId?.slice(0, 12) || 'N/A'}...
              <span className="mx-1 opacity-20">|</span>
              Pipeline: {job.id?.slice(0, 8) || 'N/A'}
            </div>
          </div>
        </div>

        <div className="flex items-center gap-2">
          <div className="h-8 w-px bg-white/5 mx-2" />
          
          <button 
            onClick={() => {
              if (!extractionData) return;
              const blob = new Blob([JSON.stringify(extractionData, null, 2)], { type: 'application/json' });
              const url = window.URL.createObjectURL(blob);
              const a = document.createElement('a');
              a.href = url;
              a.download = `${job?.googleDocTitle || 'extraction'}-metadata.json`;
              document.body.appendChild(a);
              a.click();
              window.URL.revokeObjectURL(url);
              document.body.removeChild(a);
            }}
            disabled={!extractionData}
            className="flex items-center gap-2 px-3 py-2 rounded-xl text-gray-300 hover:text-suse-pine hover:bg-suse-pine/10 border border-transparent hover:border-suse-pine/20 transition-all font-bold text-xs uppercase tracking-wider"
            title="Download Metadata JSON"
          >
            <FileCode size={16} /> JSON
          </button>

          <button 
            onClick={handleDownload}
            disabled={!previewContent}
            className="flex items-center gap-2 px-3 py-2 rounded-xl text-gray-300 hover:text-suse-water hover:bg-suse-water/10 border border-transparent hover:border-suse-water/20 transition-all font-bold text-xs uppercase tracking-wider"
            title="Export ASCII"
          >
            <Download size={16} /> ASCII
          </button>
          
          <button 
            onClick={() => startTransformation(job)}
            disabled={processing}
            className="flex items-center gap-2 px-3 py-2 rounded-xl text-gray-300 hover:text-suse-pine hover:bg-suse-pine/10 border border-transparent hover:border-suse-pine/20 transition-all font-bold text-xs uppercase tracking-wider"
            title="Re-run Transformation"
          >
            <RefreshCw size={16} className={clsx(processing && "animate-spin")} /> Re-run
          </button>

          <div className="h-8 w-px bg-white/5 mx-2" />

          <button 
            onClick={() => setShowTools(!showTools)}
            className={clsx(
              "flex items-center gap-2 px-4 py-2 rounded-xl transition-all border font-bold text-xs uppercase tracking-wider",
              showTools ? "bg-suse-pine text-suse-dark border-suse-pine shadow-[0_0_15px_rgba(48,186,120,0.4)]" : "text-gray-300 hover:text-white hover:bg-white/5 border-white/20"
            )}
            title="Pipeline Controls"
          >
            <Settings2 size={16} /> Controls
          </button>
        </div>
      </div>

      {/* Futuristic Workspace */}
      <div className="flex-1 min-h-0 relative">
        <div className="absolute inset-0 flex gap-4">
          {/* Left: Source ASCII Editor */}
          <div className="flex-1 flex flex-col bg-[#0b1612] border border-suse-pine/20 rounded-3xl overflow-hidden group/editor transition-all focus-within:border-suse-pine/50 shadow-2xl">
            <div className="flex items-center justify-between px-6 py-4 border-b border-white/5 bg-suse-pine/5">
              <div className="flex items-center gap-3">
                <div className="w-8 h-8 rounded-lg bg-suse-pine/10 flex items-center justify-center border border-suse-pine/20">
                  <FileCode size={16} className="text-suse-pine" />
                </div>
                <div className="flex flex-col">
                  <span className="text-[10px] font-black uppercase tracking-[0.2em] text-suse-pine">Source Buffer</span>
                  <span className="text-[9px] font-mono text-gray-500">FORMAT: ADOC / UTF-8</span>
                </div>
              </div>
              <div className="flex items-center gap-4">
                {job.localExtractionPath && (
                  <div className="flex items-center gap-2 px-3 py-1 bg-suse-pine/10 border border-suse-pine/20 rounded-full">
                    <div className="w-1.5 h-1.5 rounded-full bg-suse-pine animate-pulse" />
                    <span className="text-[9px] font-mono text-suse-pine uppercase font-black tracking-widest">{job.localExtractionPath.split('/').pop()}</span>
                  </div>
                )}
                <div className="text-[9px] font-mono text-gray-600 bg-white/5 px-2 py-1 rounded">V1.0.4</div>
              </div>
            </div>
            <div className="flex-1 relative bg-gradient-to-b from-[#0b1612] to-[#0d1a15]">
              <textarea 
                value={previewContent}
                onChange={(e) => setPreviewContent(e.target.value)}
                className="absolute inset-0 p-10 font-mono text-sm resize-none focus:outline-none text-suse-pine bg-transparent custom-scrollbar leading-relaxed selection:bg-suse-pine/30"
                placeholder="AsciiDoc buffer empty..."
                spellCheck={false}
              />
            </div>
          </div>

          {/* Right: Rendered Output */}
          <div className="flex-1 flex flex-col bg-suse-dark border border-white/5 rounded-3xl overflow-hidden shadow-2xl relative">
            <div className="flex items-center justify-between px-6 py-3 border-b border-white/5 bg-white/[0.02]">
              <div className="flex items-center gap-2">
                <Layout size={14} className="text-suse-water" />
                <span className="text-[10px] font-black uppercase tracking-[0.2em] text-gray-400">Live Render: SUSE Standard</span>
              </div>
              <div className="flex items-center gap-2">
                <button
                  type="button"
                  onClick={() => setRenderMode('html')}
                  className={clsx(
                    'px-3 py-1 rounded-lg text-[10px] font-black uppercase tracking-[0.15em] border transition-all',
                    renderMode === 'html' ? 'bg-suse-pine text-suse-dark border-suse-pine' : 'text-gray-300 border-white/20 hover:bg-white/5'
                  )}
                >
                  HTML
                </button>
                <button
                  type="button"
                  onClick={() => setRenderMode('pdf')}
                  className={clsx(
                    'px-3 py-1 rounded-lg text-[10px] font-black uppercase tracking-[0.15em] border transition-all',
                    renderMode === 'pdf' ? 'bg-suse-pine text-suse-dark border-suse-pine' : 'text-gray-300 border-white/20 hover:bg-white/5'
                  )}
                >
                  PDF
                </button>
                <button
                  type="button"
                  onClick={(e) => {
                    e.preventDefault();
                    e.stopPropagation();
                    runDapsRender();
                  }}
                  disabled={rendering || !job?.outputFolderPath}
                  className="ml-2 px-3 py-1 rounded-lg text-[10px] font-black uppercase tracking-[0.15em] border border-suse-pine/30 text-suse-pine hover:bg-suse-pine/10 transition-all disabled:opacity-50 disabled:pointer-events-none flex items-center gap-1"
                  title="Run DAPS render for selected format"
                >
                  <RefreshCw size={12} className={clsx(rendering && 'animate-spin')} />
                  {rendering ? 'Rendering' : 'Re-run'}
                </button>
                <button
                  type="button"
                  onClick={() => setIsRenderFullscreen(true)}
                  disabled={!renderPreviewUrl}
                  className="px-3 py-1 rounded-lg text-[10px] font-black uppercase tracking-[0.15em] border border-white/20 text-gray-300 hover:bg-white/5 transition-all disabled:opacity-50 disabled:pointer-events-none flex items-center gap-1"
                  title="Expand render to full screen"
                >
                  <Maximize2 size={12} />
                  Expand
                </button>
              </div>
            </div>
            <div className="flex-1 p-6 overflow-auto custom-scrollbar bg-suse-dark">
              <div className="animate-in fade-in slide-in-from-bottom-2 duration-500 max-w-5xl mx-auto bg-[#0b1612] shadow-2xl ring-1 ring-white/10 p-6 min-h-full rounded-2xl">
                {renderError ? (
                  <div className="h-full flex flex-col items-center justify-center text-center py-20 text-red-300">
                    <Maximize2 size={48} className="mb-4 opacity-70" />
                    <p className="font-mono text-xs uppercase tracking-widest">{renderError}</p>
                  </div>
                ) : renderPreviewUrl ? (
                  <iframe
                    title="DAPS Render Preview"
                    src={renderPreviewUrl}
                    className="w-full min-h-[72vh] border border-white/10 rounded-xl bg-[#0b1612]"
                  />
                ) : (
                  <div className="h-full flex flex-col items-center justify-center text-center opacity-40 py-20 text-gray-300">
                    <Maximize2 size={48} className="mb-4" />
                    <p className="font-mono text-xs uppercase tracking-widest">Manual DAPS rendering is idle. Select format and press Re-run.</p>
                  </div>
                )}
              </div>
            </div>
          </div>
        </div>

        {/* Global Controls Overlays (Slide Panel) */}
        <AnimatePresence>
          {showTools && (
            <>
              <motion.div 
                initial={{ opacity: 0 }}
                animate={{ opacity: 1 }}
                exit={{ opacity: 0 }}
                onClick={() => setShowTools(false)}
                className="absolute inset-0 bg-suse-dark/40 backdrop-blur-sm z-40 rounded-3xl"
              />
              <motion.div 
                initial={{ x: '100%', opacity: 0 }}
                animate={{ x: 0, opacity: 1 }}
                exit={{ x: '100%', opacity: 0 }}
                transition={{ type: 'spring', damping: 25, stiffness: 200 }}
                className="absolute top-4 right-4 bottom-4 w-96 bg-suse-jungle border border-suse-pine/30 shadow-[0_0_50px_rgba(0,0,0,0.5)] z-50 rounded-3xl p-8 overflow-y-auto custom-scrollbar flex flex-col gap-8 ring-1 ring-white/10"
              >
                <div className="flex justify-between items-center border-b border-white/5 pb-4">
                  <h2 className="text-sm font-black text-white uppercase tracking-widest flex items-center gap-2">
                    <Settings2 size={16} className="text-suse-pine" />
                    Pipeline Controls
                  </h2>
                </div>

                {/* GitHub Sync */}
                <section className="space-y-4">
                  <h3 className="text-[10px] font-black text-suse-pine uppercase tracking-[0.2em] flex items-center gap-2">
                    <GitBranch size={12} /> Sync Repository
                  </h3>
                  <div className="space-y-3">
                    <div className="p-4 bg-suse-dark/50 border border-white/5 rounded-2xl space-y-3">
                      <div className="space-y-1">
                        <label className="text-[9px] text-gray-500 uppercase font-bold tracking-widest ml-1">Repository Target</label>
                        <input 
                          type="text" 
                          value={githubConfig.repo}
                          onChange={(e) => setGithubConfig({...githubConfig, repo: e.target.value})}
                          className="w-full bg-suse-dark/80 border border-white/5 rounded-xl p-2.5 text-xs text-white focus:border-suse-pine outline-none transition-all"
                          placeholder="owner/repo"
                        />
                      </div>
                      <div className="space-y-1">
                        <label className="text-[9px] text-gray-500 uppercase font-bold tracking-widest ml-1">Path Mapping</label>
                        <input 
                          type="text" 
                          value={githubConfig.path}
                          onChange={(e) => setGithubConfig({...githubConfig, path: e.target.value})}
                          className="w-full bg-suse-dark/80 border border-white/5 rounded-xl p-2.5 text-xs text-white focus:border-suse-pine outline-none transition-all"
                        />
                      </div>
                      <button 
                        onClick={handleSyncToGitHub}
                        disabled={syncing || !job.asciiDocContent}
                        className="w-full mt-2 bg-suse-pine text-suse-dark font-black py-2.5 rounded-xl hover:bg-suse-neon transition-all flex items-center justify-center gap-2 text-[10px] uppercase tracking-wider"
                      >
                        {syncing ? <Loader2 size={14} className="animate-spin" /> : <Github size={14} />}
                        Execute GitHub Commit
                      </button>
                    </div>
                  </div>
                </section>

                {/* Extraction Metadata */}
                <section className="space-y-4">
                  <h3 className="text-[10px] font-black text-suse-pine uppercase tracking-[0.2em] flex items-center gap-2">
                    <FileCode size={12} /> Extraction Registry
                  </h3>
                  <div className="space-y-3">
                    <div className="p-4 bg-suse-dark/50 border border-white/5 rounded-2xl space-y-3">
                      <div className="space-y-1">
                        <label className="text-[9px] text-gray-500 uppercase font-bold tracking-widest ml-1">Server Repository</label>
                        <div className="text-[10px] font-mono text-gray-400 break-all bg-white/5 p-2 rounded-lg">
                          /data/ (Absolute Context)
                        </div>
                      </div>
                      
                      {job.localExtractionPath ? (
                        <div className="space-y-2">
                          <div className="space-y-1">
                            <label className="text-[9px] text-gray-500 uppercase font-bold tracking-widest ml-1">Assigned Path</label>
                            <div className="text-[10px] font-mono text-suse-pine bg-suse-pine/5 p-2 rounded-lg break-all">
                              {job.localExtractionPath}
                            </div>
                          </div>
                          
                          <button 
                            onClick={() => {
                              const blob = new Blob([JSON.stringify(extractionData, null, 2)], { type: 'application/json' });
                              const url = URL.createObjectURL(blob);
                              window.open(url, '_blank');
                            }}
                            disabled={!extractionData}
                            className="w-full flex items-center justify-center gap-2 py-2 bg-white/5 hover:bg-white/10 border border-white/10 rounded-xl text-[10px] font-bold uppercase tracking-widest transition-all"
                          >
                            <ExternalLink size={12} />
                            Open Raw Extraction
                          </button>
                        </div>
                      ) : (
                        <p className="text-[10px] text-gray-600 italic">No local extraction path linked to this job.</p>
                      )}
                    </div>
                  </div>
                </section>

                  {/* Data Explorer */}
                <section className="space-y-4">
                  <h3 className="text-[10px] font-black text-gray-400 uppercase tracking-[0.2em] flex items-center gap-2">
                    <Layout size={12} /> Server Data Explorer
                  </h3>
                  <div className="space-y-2">
                    <div className="bg-[#0b1612] border border-suse-pine/20 rounded-2xl overflow-hidden shadow-xl">
                      <div className="px-4 py-3 bg-suse-pine/5 border-b border-suse-pine/20 flex items-center justify-between">
                        <div className="flex items-center gap-2">
                          <div className="w-2 h-2 rounded-full bg-suse-pine shadow-[0_0_8px_rgba(48,186,120,0.5)]" />
                          <span className="text-[9px] font-black uppercase text-suse-pine tracking-widest">Root: /data/</span>
                        </div>
                        <span className="text-[9px] font-mono text-gray-600">{allExtractions.length} Objects</span>
                      </div>
                      <div className="p-2 max-h-64 overflow-y-auto custom-scrollbar space-y-1">
                        {allExtractions.length > 0 ? (
                          allExtractions.map((file, idx) => {
                            const isCurrent = job.localExtractionPath?.includes(file);
                            const parts = file.split('/');
                            const filename = parts.pop();
                            const pathStr = parts.join('/');
                            
                            return (
                              <button
                                key={idx}
                                onClick={async () => {
                                  fetchExtraction(file);
                                  try {
                                    await axios.patch(`/api/jobs/${job.id}`, {
                                      localExtractionPath: file
                                    });
                                    setJob({ ...job, localExtractionPath: file });
                                    alert(`Linked: ${filename}`);
                                  } catch (e) {
                                    alert("Link update failed.");
                                  }
                                }}
                                className={clsx(
                                  "w-full flex flex-col gap-0.5 px-3 py-2.5 rounded-xl text-left transition-all group border",
                                  isCurrent 
                                    ? "bg-suse-pine/10 text-suse-pine border-suse-pine/30" 
                                    : "text-gray-500 hover:bg-white/5 hover:text-gray-300 border-transparent"
                                )}
                              >
                                <div className="flex items-center gap-2">
                                  <File size={12} className={clsx("shrink-0", isCurrent ? "text-suse-pine" : "opacity-40")} />
                                  <span className="text-[10px] font-mono truncate font-bold">{filename}</span>
                                  {isCurrent && <div className="ml-auto w-1 h-1 rounded-full bg-suse-pine shadow-[0_0_4px_#30ba78]" />}
                                </div>
                                {pathStr && (
                                  <div className="flex items-center gap-1 ml-5">
                                    <span className="text-[8px] font-mono opacity-40">IN:</span>
                                    <span className="text-[8px] font-mono opacity-60 uppercase tracking-tighter">{pathStr}/</span>
                                  </div>
                                )}
                              </button>
                            );
                          })
                        ) : (
                          <div className="p-8 text-center text-gray-600">
                            <Layout size={24} className="mx-auto mb-2 opacity-10" />
                            <p className="text-[9px] uppercase tracking-widest font-black">No JSON assets found</p>
                            <p className="text-[8px] italic mt-1 opacity-60">Try starting a new extraction first</p>
                          </div>
                        )}
                      </div>
                    </div>
                  </div>
                </section>

                {/* AI & Automation */}
                <section className="space-y-4">
                  <h3 className="text-[10px] font-black text-suse-water uppercase tracking-[0.2em] flex items-center gap-2">
                    <Zap size={12} /> AI Enhancements
                  </h3>
                  <div className="space-y-2">
                    <div className="p-3 bg-suse-water/5 border border-suse-water/20 rounded-xl relative overflow-hidden group">
                      <div className="absolute top-0 right-0 p-2 opacity-10 group-hover:opacity-100 transition-opacity">
                        <Wand2 size={12} className="text-suse-water" />
                      </div>
                      <p className="text-[10px] text-suse-water font-bold uppercase mb-1">DAPS Normalization Active</p>
                      <p className="text-[11px] text-gray-400 leading-relaxed italic">Smart replacement of generic variables with company-wide attributes.</p>
                    </div>
                  </div>
                </section>

                {/* Telemetry Logs */}
                <section className="flex-1 flex flex-col min-h-0 space-y-4">
                  <h3 className="text-[10px] font-black text-gray-400 uppercase tracking-[0.2em] flex items-center gap-2">
                    <Terminal size={12} /> Telemetry Logs
                  </h3>
                  <div className="flex-1 bg-suse-dark border border-white/5 rounded-2xl p-4 font-mono text-[9px] overflow-y-auto custom-scrollbar space-y-1.5 shadow-inner">
                    <div className="flex gap-2 text-suse-pine">
                      <span className="opacity-30">[14:22]</span> [BOOT] Doc pipeline init
                    </div>
                    <div className="flex gap-2 text-gray-500">
                      <span className="opacity-30">[14:23]</span> [INFO] Parsing XML nodes
                    </div>
                    <div className="flex gap-2 text-suse-water">
                      <span className="opacity-30">[14:24]</span> [AI] Contextual mapping: ON
                    </div>
                    {job.status === 'completed' && (
                      <div className="flex gap-2 text-suse-pine animate-pulse">
                        <span className="opacity-30">[14:25]</span> [OK] Translation finished
                      </div>
                    )}
                  </div>
                </section>

                <button 
                  onClick={() => setShowTools(false)}
                  className="w-full border border-white/10 hover:bg-white/5 text-gray-400 py-3 rounded-2xl text-[10px] font-black uppercase tracking-widest transition-all"
                >
                  Close Pipeline Controls
                </button>
              </motion.div>
            </>
          )}
        </AnimatePresence>
      </div>

      <AnimatePresence>
        {isRenderFullscreen && Boolean(renderPreviewUrl) && (
          <>
            <motion.div
              initial={{ opacity: 0 }}
              animate={{ opacity: 1 }}
              exit={{ opacity: 0 }}
              onClick={() => setIsRenderFullscreen(false)}
              className="fixed inset-0 bg-black/70 backdrop-blur-sm z-[70]"
            />
            <motion.div
              initial={{ opacity: 0, scale: 0.98 }}
              animate={{ opacity: 1, scale: 1 }}
              exit={{ opacity: 0, scale: 0.98 }}
              transition={{ duration: 0.2 }}
              className="fixed inset-4 z-[80] bg-suse-dark border border-white/10 rounded-2xl shadow-2xl overflow-hidden"
            >
              <div className="h-12 px-4 border-b border-white/10 flex items-center justify-between">
                <div className="text-[10px] font-black uppercase tracking-[0.2em] text-gray-300">
                  Full Screen Render - {renderMode.toUpperCase()}
                </div>
                <button
                  type="button"
                  onClick={() => setIsRenderFullscreen(false)}
                  className="px-3 py-1 rounded-lg text-[10px] font-black uppercase tracking-[0.15em] border border-white/20 text-gray-300 hover:bg-white/5 transition-all"
                >
                  Close
                </button>
              </div>
              <iframe
                title="DAPS Render Fullscreen Preview"
                src={renderPreviewUrl}
                className="w-full h-[calc(100%-3rem)] bg-[#0b1612]"
              />
            </motion.div>
          </>
        )}
      </AnimatePresence>
    </div>
  );
}
