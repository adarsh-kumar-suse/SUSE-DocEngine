import React from 'react';
import axios from 'axios';
import { Link, useParams } from 'react-router-dom';
import { CheckCircle2, FileCode, FolderTree, Loader2, Play, RefreshCw, Save, Upload } from 'lucide-react';
import { clsx } from 'clsx';

type WorkspaceItem = {
  path: string;
  type: 'file' | 'dir';
  size?: number;
};

type WorkspaceTreeResponse = {
  jobId: string;
  rootPath: string;
  documentbase: string | null;
  dcFileName: string | null;
  items: WorkspaceItem[];
};

type JobRecord = {
  id: string;
  googleDocTitle?: string;
  status?: string;
  pipelineWorkspace?: {
    rootPath?: string;
    documentbase?: string;
    dcFileName?: string;
  };
};

type TreeNode = {
  name: string;
  path: string;
  type: 'file' | 'dir';
  children: TreeNode[];
};

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

const toApiErrorMessage = (err: unknown, fallback: string) => {
  const maybe = err as {
    response?: { data?: { error?: ({ message?: string; details?: ApiErrorDetails | string } & ApiErrorDetails) | string } };
    message?: string;
  };
  const apiError = maybe?.response?.data?.error;
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
  return maybe?.message || fallback;
};

const isAdocLikeFile = (value: string) => {
  const normalized = value.toLowerCase();
  return normalized.endsWith('.adoc') || normalized.endsWith('.xml') || normalized.endsWith('.md') || normalized.endsWith('.txt') || normalized.endsWith('.json') || /^dc-/.test(normalized.split('/').pop() || '');
};

const buildTree = (items: WorkspaceItem[]) => {
  const root: TreeNode = { name: '', path: '', type: 'dir', children: [] };
  const index = new Map<string, TreeNode>([['', root]]);

  const ensureDir = (dirPath: string) => {
    const normalized = dirPath.replace(/\\/g, '/').replace(/^\/+/, '');
    if (!normalized) return root;
    if (index.has(normalized)) return index.get(normalized)!;
    const parentPath = normalized.includes('/') ? normalized.slice(0, normalized.lastIndexOf('/')) : '';
    const parent = ensureDir(parentPath);
    const node: TreeNode = {
      name: normalized.split('/').pop() || normalized,
      path: normalized,
      type: 'dir',
      children: [],
    };
    parent.children.push(node);
    index.set(normalized, node);
    return node;
  };

  const sorted = items.slice().sort((a, b) => a.path.localeCompare(b.path));
  sorted.forEach((item) => {
    const normalized = item.path.replace(/\\/g, '/').replace(/^\/+/, '');
    if (!normalized) return;
    if (item.type === 'dir') {
      ensureDir(normalized);
      return;
    }
    const parentPath = normalized.includes('/') ? normalized.slice(0, normalized.lastIndexOf('/')) : '';
    const parent = ensureDir(parentPath);
    const node: TreeNode = {
      name: normalized.split('/').pop() || normalized,
      path: normalized,
      type: 'file',
      children: [],
    };
    parent.children.push(node);
    index.set(normalized, node);
  });

  const sortNode = (node: TreeNode) => {
    node.children.sort((a, b) => {
      if (a.type !== b.type) return a.type === 'dir' ? -1 : 1;
      return a.name.localeCompare(b.name);
    });
    node.children.forEach(sortNode);
  };
  sortNode(root);
  return root.children;
};

export default function PipelineStudio() {
  const { jobId } = useParams();

  const [job, setJob] = React.useState<JobRecord | null>(null);
  const [tree, setTree] = React.useState<WorkspaceTreeResponse | null>(null);
  const [treeNodes, setTreeNodes] = React.useState<TreeNode[]>([]);

  const [treeLoading, setTreeLoading] = React.useState(true);
  const [fileLoading, setFileLoading] = React.useState(false);
  const [saveLoading, setSaveLoading] = React.useState(false);
  const [uploadLoading, setUploadLoading] = React.useState(false);
  const [applyLoading, setApplyLoading] = React.useState(false);
  const [renderLoading, setRenderLoading] = React.useState(false);

  const [selectedFilePath, setSelectedFilePath] = React.useState('');
  const [selectedDcFile, setSelectedDcFile] = React.useState('');
  const [fileContent, setFileContent] = React.useState('');
  const [savedContent, setSavedContent] = React.useState('');
  const [uploadFile, setUploadFile] = React.useState<File | null>(null);
  const [reviewExtraction, setReviewExtraction] = React.useState<any>(null);
  const [reviewJson, setReviewJson] = React.useState('');
  const [reviewParseError, setReviewParseError] = React.useState('');
  const [showExtractedView, setShowExtractedView] = React.useState(true);

  const [renderPreviewUrl, setRenderPreviewUrl] = React.useState('');
  const [renderError, setRenderError] = React.useState('');

  const [error, setError] = React.useState('');
  const [status, setStatus] = React.useState('');

  const gutterRef = React.useRef<HTMLPreElement | null>(null);

  const loadJob = React.useCallback(async () => {
    if (!jobId) return;
    const response = await axios.get(`/api/jobs/${jobId}`);
    setJob(response.data as JobRecord);
  }, [jobId]);

  const loadWorkspaceTree = React.useCallback(async () => {
    if (!jobId) return null;
    const response = await axios.get(`/api/pipeline/${jobId}/workspace-tree`);
    const payload = response.data as WorkspaceTreeResponse;
    setTree(payload);
    setTreeNodes(buildTree(payload.items || []));

    const dcCandidates = (payload.items || [])
      .filter((item) => item.type === 'file' && /^DC-/.test(item.path.split('/').pop() || ''))
      .map((item) => item.path.split('/').pop() || '')
      .filter(Boolean)
      .sort((a, b) => a.localeCompare(b));

    if (dcCandidates.length > 0) {
      setSelectedDcFile((current) => {
        if (current && dcCandidates.includes(current)) return current;
        if (payload.dcFileName && dcCandidates.includes(payload.dcFileName)) return payload.dcFileName;
        return dcCandidates[0];
      });
    } else {
      setSelectedDcFile('');
    }

    return payload;
  }, [jobId]);

  const loadFileContent = React.useCallback(
    async (targetPath: string) => {
      if (!jobId || !targetPath) return;
      setFileLoading(true);
      setError('');
      try {
        const response = await axios.get(`/api/pipeline/${jobId}/workspace-file`, {
          params: { path: targetPath },
        });
        const content = String(response.data?.content || '');
        setSelectedFilePath(String(response.data?.path || targetPath));
        setFileContent(content);
        setSavedContent(content);
      } catch (err) {
        setError(toApiErrorMessage(err, 'Failed to load workspace file.'));
      } finally {
        setFileLoading(false);
      }
    },
    [jobId],
  );

  const refreshWorkspace = async () => {
    setTreeLoading(true);
    setError('');
    try {
      const payload = await loadWorkspaceTree();
      if (!payload) return;

      const editableFiles = (payload.items || [])
        .filter((item) => item.type === 'file' && isAdocLikeFile(item.path))
        .map((item) => item.path)
        .sort((a, b) => a.localeCompare(b));

      if (!selectedFilePath || !editableFiles.includes(selectedFilePath)) {
        const preferred = editableFiles.find((path) => path.toLowerCase().endsWith('.adoc')) || editableFiles[0] || '';
        if (preferred) {
          await loadFileContent(preferred);
        } else {
          setSelectedFilePath('');
          setFileContent('');
          setSavedContent('');
        }
      }
    } finally {
      setTreeLoading(false);
    }
  };

  React.useEffect(() => {
    const bootstrap = async () => {
      if (!jobId) return;
      setTreeLoading(true);
      setError('');
      setStatus('');
      try {
        await Promise.all([loadJob(), refreshWorkspace()]);
      } catch (err) {
        setError(toApiErrorMessage(err, 'Failed to initialize pipeline studio.'));
      } finally {
        setTreeLoading(false);
      }
    };
    bootstrap();
  }, [jobId, loadJob]);

  const unsavedChanges = selectedFilePath.length > 0 && fileContent !== savedContent;

  const lineNumbers = React.useMemo(() => {
    const total = Math.max(1, fileContent.split(/\r?\n/).length);
    return Array.from({ length: total }, (_, index) => String(index + 1)).join('\n');
  }, [fileContent]);

  const editableFiles = React.useMemo(
    () =>
      (tree?.items || [])
        .filter((item) => item.type === 'file' && isAdocLikeFile(item.path))
        .map((item) => item.path)
        .sort((a, b) => a.localeCompare(b)),
    [tree],
  );

  const saveFileContent = async () => {
    if (!jobId || !selectedFilePath) return;
    setSaveLoading(true);
    setError('');
    setStatus('');
    try {
      const response = await axios.put(`/api/pipeline/${jobId}/workspace-file`, {
        path: selectedFilePath,
        content: fileContent,
      });
      setSavedContent(fileContent);
      const varsRewrite = response.data?.varsRewrite as
        | { rewritten?: boolean; changedKeys?: number; addedKeys?: number; removedKeys?: number }
        | undefined;
      if (selectedFilePath.toLowerCase().endsWith('-vars.adoc') && varsRewrite) {
        const summary = `changed=${varsRewrite.changedKeys || 0}, added=${varsRewrite.addedKeys || 0}, removed=${varsRewrite.removedKeys || 0}`;
        setStatus(
          varsRewrite.rewritten
            ? `Saved ${selectedFilePath} and updated main adoc variable usage (${summary}).`
            : `Saved ${selectedFilePath} (${summary}).`,
        );
      } else {
        setStatus(`Saved ${selectedFilePath}`);
      }
    } catch (err) {
      setError(toApiErrorMessage(err, 'Failed to save file.'));
    } finally {
      setSaveLoading(false);
    }
  };

  const uploadForReview = async () => {
    if (!jobId || !uploadFile) return;
    setUploadLoading(true);
    setError('');
    setStatus('');
    setReviewParseError('');
    try {
      const form = new FormData();
      form.append('file', uploadFile);
      const response = await axios.post(`/api/pipeline/${jobId}/upload-for-review`, form, {
        headers: { 'Content-Type': 'multipart/form-data' },
      });
      const extraction = response.data?.extraction || null;
      setReviewExtraction(extraction);
      setReviewJson(JSON.stringify(extraction, null, 2));
      setShowExtractedView(true);
      setStatus('DOCX uploaded. Review extracted sections/content, then apply to update ADOC files.');
      setUploadFile(null);
    } catch (err) {
      setError(toApiErrorMessage(err, 'Failed to upload DOCX for review.'));
    } finally {
      setUploadLoading(false);
    }
  };

  const applyReviewedExtraction = async () => {
    if (!jobId) return;
    setApplyLoading(true);
    setError('');
    setStatus('');
    setReviewParseError('');
    try {
      const parsed = JSON.parse(reviewJson || '{}');
      if (!parsed || typeof parsed !== 'object') {
        throw new Error('Extraction JSON must be a valid object.');
      }
      const response = await axios.post(`/api/pipeline/${jobId}/apply-reviewed-extraction`, {
        extractionData: parsed,
        sourceFileName: uploadFile?.name || `${tree?.documentbase || 'source'}.docx`,
      });
      setReviewExtraction(parsed);
      setStatus('Reviewed extraction applied. Workspace ADOC files were updated.');
      await refreshWorkspace();

      const asciiDocPath = String(response.data?.asciiDocPath || '');
      const rootPath = String(tree?.rootPath || '');
      if (asciiDocPath && rootPath && asciiDocPath.startsWith(`${rootPath}/`)) {
        const relative = asciiDocPath.slice(rootPath.length + 1);
        if (relative) {
          await loadFileContent(relative);
        }
      }
    } catch (err) {
      const message = toApiErrorMessage(err, 'Failed to apply reviewed extraction.');
      setError(message);
      if (message.toLowerCase().includes('json')) {
        setReviewParseError(message);
      }
    } finally {
      setApplyLoading(false);
    }
  };

  const runDapsHtml = async () => {
    if (!jobId) return;
    setRenderLoading(true);
    setRenderError('');
    setRenderPreviewUrl('');
    setError('');
    setStatus('');
    try {
      const response = await axios.post(`/api/pipeline/${jobId}/render-html`, {
        dcFileName: selectedDcFile || undefined,
      });
      const requestPath = String(response.data?.requestPath || '');
      if (!requestPath) {
        throw new Error('Render output URL not returned by API.');
      }
      // Validate the rendered file is accessible before showing the iframe.
      await axios.head(requestPath);
      setRenderPreviewUrl(requestPath);
      setStatus('DAPS HTML render completed.');
    } catch (err) {
      const message = toApiErrorMessage(err, 'DAPS render failed.');
      setRenderError(message);
      setError(message);
    } finally {
      setRenderLoading(false);
    }
  };

  const renderTreeNodes = (nodes: TreeNode[], depth = 0): React.ReactNode => {
    return nodes.map((node) => {
      const isFile = node.type === 'file';
      const isSelected = selectedFilePath === node.path;
      return (
        <div key={`${node.path}-${node.type}`}>
          <div style={{ paddingLeft: `${depth * 14}px` }}>
            {isFile ? (
              <button
                type="button"
                onClick={() => loadFileContent(node.path)}
                className={clsx(
                  'w-full text-left px-2 py-1 rounded text-xs font-mono transition-colors',
                  isSelected
                    ? 'bg-suse-pine/20 text-suse-pine'
                    : 'text-gray-300 hover:bg-white/5',
                )}
              >
                {node.name}
              </button>
            ) : (
              <div className="px-2 py-1 text-xs font-mono text-gray-500">{node.name}/</div>
            )}
          </div>
          {node.children.length > 0 ? renderTreeNodes(node.children, depth + 1) : null}
        </div>
      );
    });
  };

  return (
    <div className="max-w-[96rem] mx-auto space-y-4">
      <div className="suse-card p-5 flex flex-col lg:flex-row lg:items-center justify-between gap-4">
        <div>
          <p className="text-xs uppercase tracking-[0.16em] text-suse-pine font-semibold">Pipeline Studio</p>
          <h1 className="text-2xl font-bold text-white">{job?.googleDocTitle || tree?.documentbase || jobId}</h1>
          <p className="text-xs text-gray-500 mt-1">Workspace: {tree?.rootPath || job?.pipelineWorkspace?.rootPath || 'not configured'}</p>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <Link to="/pipelines" className="px-3 py-2 rounded-lg border border-white/10 text-xs text-gray-300 hover:bg-white/5">
            Back to Pipelines
          </Link>
          <button
            type="button"
            onClick={refreshWorkspace}
            disabled={treeLoading}
            className="px-3 py-2 rounded-lg border border-suse-pine/30 text-xs text-suse-pine hover:bg-suse-pine/10 inline-flex items-center gap-2 disabled:opacity-50"
          >
            <RefreshCw size={12} className={clsx(treeLoading && 'animate-spin')} />
            Refresh Tree
          </button>
        </div>
      </div>

      {error ? <div className="rounded-xl border border-red-500/40 bg-red-500/10 p-3 text-sm text-red-300">{error}</div> : null}
      {status ? <div className="rounded-xl border border-suse-pine/30 bg-suse-pine/10 p-3 text-sm text-suse-pine">{status}</div> : null}

      <div className="grid grid-cols-1 xl:grid-cols-[1.2fr_1fr] gap-4">
        <section className="suse-card p-4 space-y-4 min-h-[75vh]">
          <div className="flex items-center justify-between gap-3">
            <h2 className="text-sm font-semibold text-white flex items-center gap-2">
              <FolderTree size={14} className="text-suse-pine" />
              Workspace Files
            </h2>
            <span className="text-xs text-gray-500">{editableFiles.length} editable</span>
          </div>

          <div className="rounded-xl border border-white/10 bg-suse-dark/70 p-3 max-h-64 overflow-auto custom-scrollbar">
            {treeLoading ? (
              <div className="py-6 text-center text-gray-500 text-xs">
                <Loader2 className="mx-auto mb-2 animate-spin" size={14} />
                Loading workspace tree...
              </div>
            ) : treeNodes.length === 0 ? (
              <div className="py-6 text-center text-gray-500 text-xs">No workspace files found.</div>
            ) : (
              renderTreeNodes(treeNodes)
            )}
          </div>

          <div className="rounded-xl border border-white/10 bg-suse-dark/70 overflow-hidden flex-1 min-h-[380px] flex flex-col">
            <div className="flex items-center justify-between px-3 py-2 border-b border-white/10">
              <div className="text-xs text-gray-400 flex items-center gap-2">
                <FileCode size={12} className="text-suse-pine" />
                {selectedFilePath || 'Select a file to edit'}
              </div>
              <button
                type="button"
                onClick={saveFileContent}
                disabled={!unsavedChanges || saveLoading || !selectedFilePath}
                className="px-3 py-1 rounded-md border border-suse-pine/30 text-xs text-suse-pine hover:bg-suse-pine/10 inline-flex items-center gap-1 disabled:opacity-50"
              >
                {saveLoading ? <Loader2 size={12} className="animate-spin" /> : <Save size={12} />}
                Save
              </button>
            </div>

            {fileLoading ? (
              <div className="flex-1 flex items-center justify-center text-xs text-gray-500">
                <Loader2 className="animate-spin mr-2" size={14} /> Loading file...
              </div>
            ) : (
              <div className="flex-1 min-h-0 flex font-mono text-xs">
                <pre
                  ref={gutterRef}
                  className="w-14 shrink-0 p-3 text-right text-gray-500 bg-black/20 border-r border-white/10 overflow-hidden select-none"
                >
                  {lineNumbers}
                </pre>
                <textarea
                  value={fileContent}
                  onChange={(event) => setFileContent(event.target.value)}
                  onScroll={(event) => {
                    if (!gutterRef.current) return;
                    gutterRef.current.scrollTop = event.currentTarget.scrollTop;
                  }}
                  spellCheck={false}
                  wrap="off"
                  className="flex-1 bg-transparent text-gray-100 p-3 resize-none outline-none overflow-auto"
                />
              </div>
            )}
          </div>

          <div className="text-xs text-gray-500">
            {unsavedChanges ? 'Unsaved changes detected.' : selectedFilePath ? 'All changes saved.' : 'Select a file to begin editing.'}
          </div>
        </section>

        <section className="suse-card p-4 space-y-4 min-h-[75vh] flex flex-col">
          <div className="rounded-xl border border-white/10 bg-white/5 p-3 space-y-3">
            <h2 className="text-sm font-semibold text-white">Upload DOCX for Review</h2>
            <div className="flex flex-col sm:flex-row gap-2">
              <input
                type="file"
                accept=".docx"
                onChange={(event) => setUploadFile(event.target.files?.[0] || null)}
                className="text-xs text-gray-300 file:mr-3 file:rounded-md file:border-0 file:bg-suse-pine/20 file:px-3 file:py-1 file:text-xs file:text-suse-pine"
              />
              <button
                type="button"
                onClick={uploadForReview}
                disabled={!uploadFile || uploadLoading}
                className="px-3 py-2 rounded-lg border border-suse-pine/30 text-xs text-suse-pine hover:bg-suse-pine/10 inline-flex items-center justify-center gap-2 disabled:opacity-50"
              >
                {uploadLoading ? <Loader2 size={12} className="animate-spin" /> : <Upload size={12} />}
                Upload and Preview
              </button>
            </div>
            <p className="text-[11px] text-gray-500">Upload only extracts content. ADOC files update only after you apply reviewed content.</p>
          </div>

          <div className="rounded-xl border border-white/10 bg-white/5 p-3 space-y-3">
            <div className="flex items-center justify-between gap-2">
              <h2 className="text-sm font-semibold text-white">Extracted Content Review</h2>
              <button
                type="button"
                onClick={() => setShowExtractedView((prev) => !prev)}
                className="px-2 py-1 rounded-md border border-white/20 text-[10px] text-gray-300 hover:bg-white/5"
              >
                {showExtractedView ? 'Hide View' : 'View Extracted'}
              </button>
            </div>

            {!reviewExtraction ? (
              <p className="text-[11px] text-gray-500">No extracted content loaded yet. Upload a DOCX to review sections, text, and media before apply.</p>
            ) : (
              <>
                {showExtractedView ? (
                  <div className="max-h-60 overflow-auto custom-scrollbar rounded-lg border border-white/10 bg-suse-dark/60 p-3 space-y-2">
                    {Array.isArray(reviewExtraction?.sections) && reviewExtraction.sections.length > 0 ? (
                      reviewExtraction.sections.map((section: any, sectionIndex: number) => (
                        <div key={`section-${sectionIndex}`} className="rounded-lg border border-white/10 bg-black/20 p-2 space-y-2">
                          <p className="text-xs text-suse-pine font-semibold">
                            {sectionIndex + 1}. {String(section?.heading || `Section ${sectionIndex + 1}`)}
                          </p>
                          <div className="space-y-1">
                            {(Array.isArray(section?.blocks) ? section.blocks : []).map((block: any, blockIndex: number) => (
                              <div key={`block-${sectionIndex}-${blockIndex}`} className="rounded border border-white/10 px-2 py-1 bg-white/[0.02]">
                                <p className="text-[10px] uppercase tracking-wider text-gray-400">
                                  {String(block?.type || 'block')}
                                </p>
                                {block?.text ? <p className="text-[11px] text-gray-200 whitespace-pre-wrap">{String(block.text)}</p> : null}
                                {block?.caption ? <p className="text-[10px] text-gray-400">caption: {String(block.caption)}</p> : null}
                                {(block?.asset_path || block?.media_target_path) ? (
                                  <p className="text-[10px] text-gray-500 break-all">
                                    asset: {String(block.asset_path || block.media_target_path)}
                                  </p>
                                ) : null}
                              </div>
                            ))}
                          </div>
                        </div>
                      ))
                    ) : (
                      <p className="text-[11px] text-gray-500">No structured sections found in extraction.</p>
                    )}
                  </div>
                ) : null}

                <textarea
                  value={reviewJson}
                  onChange={(event) => {
                    setReviewJson(event.target.value);
                    setReviewParseError('');
                  }}
                  spellCheck={false}
                  className="w-full min-h-[180px] rounded-lg border border-white/10 bg-suse-dark/70 p-3 font-mono text-[11px] text-gray-100 outline-none"
                />
                {reviewParseError ? <p className="text-xs text-red-300">{reviewParseError}</p> : null}
                <button
                  type="button"
                  onClick={applyReviewedExtraction}
                  disabled={!reviewJson.trim() || applyLoading}
                  className="px-3 py-2 rounded-lg border border-suse-pine/30 text-xs text-suse-pine hover:bg-suse-pine/10 inline-flex items-center justify-center gap-2 disabled:opacity-50"
                >
                  {applyLoading ? <Loader2 size={12} className="animate-spin" /> : <Save size={12} />}
                  Apply Reviewed Content
                </button>
              </>
            )}
          </div>

          <div className="rounded-xl border border-white/10 bg-white/5 p-3 space-y-3">
            <h2 className="text-sm font-semibold text-white">DAPS HTML Render</h2>
            <div className="grid grid-cols-1 sm:grid-cols-[1fr_auto] gap-2">
              <select
                value={selectedDcFile}
                onChange={(event) => setSelectedDcFile(event.target.value)}
                className="bg-suse-dark/70 border border-white/10 rounded-lg px-3 py-2 text-xs text-gray-200"
              >
                {(tree?.items || [])
                  .filter((item) => item.type === 'file' && /^DC-/.test(item.path.split('/').pop() || ''))
                  .map((item) => item.path.split('/').pop() || '')
                  .filter(Boolean)
                  .sort((a, b) => a.localeCompare(b))
                  .map((dcName) => (
                    <option key={dcName} value={dcName}>
                      {dcName}
                    </option>
                  ))}
              </select>
              <button
                type="button"
                onClick={runDapsHtml}
                disabled={renderLoading || !selectedDcFile}
                className="px-3 py-2 rounded-lg border border-suse-pine/30 text-xs text-suse-pine hover:bg-suse-pine/10 inline-flex items-center justify-center gap-2 disabled:opacity-50"
              >
                {renderLoading ? <Loader2 size={12} className="animate-spin" /> : <Play size={12} />}
                Run DAPS HTML
              </button>
            </div>
            {renderError ? <p className="text-xs text-red-300">{renderError}</p> : null}
          </div>

          <div className="rounded-xl border border-white/10 bg-suse-dark/70 p-2 flex-1 min-h-[420px]">
            {renderPreviewUrl ? (
              <iframe
                title="Pipeline Render Preview"
                src={renderPreviewUrl}
                className="w-full h-full min-h-[400px] rounded-md border border-white/10 bg-[#09130f]"
              />
            ) : (
              <div className="h-full min-h-[400px] flex items-center justify-center text-xs text-gray-500 px-4 text-center">
                {renderError || 'Run DAPS HTML to view live render output here.'}
              </div>
            )}
          </div>

          <div className="text-xs text-gray-500 flex items-center gap-2">
            <CheckCircle2 size={12} className="text-suse-pine" />
            Build runs inside your selected partner workspace directory.
          </div>
        </section>
      </div>
    </div>
  );
}
