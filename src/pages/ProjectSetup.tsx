import React, { useState, useEffect, useRef } from 'react';
import { useParams, useNavigate } from 'react-router-dom';
import axios from 'axios';
import { ChevronDown, Folder, FolderTree, File, Loader2, Save } from 'lucide-react';

const SUSE_PRODUCTS = [
  'SUSE Linux Enterprise Server',
  'SUSE Linux Enterprise Server for SAP applications',
  'SUSE Linux Enterprise High Performance Computing',
  'SUSE Linux Micro',
  'SUSE Linux Enterprise Live Patching',
  'SUSE Linux Enterprise Real Time',
  'SUSE Linux Enterprise for High Availability',
  'SUSE Linux Enterprise Base Container Images',
  'SUSE Multi-Linux Manager Manager',
  'SUSE Rancher Prime',
  'SUSE Storage',
  'SUSE Security',
  'SUSE Observability',
  'SUSE Virtualization',
  'SUSE Edge',
  'SUSE Telco',
  'SUSE AI',
  'Rancher Kubernetes Engine',
  'Rancher Kubernetes Engine 2',
  'K3s',
];

const PROFILE_CONFIG: Record<string, { namingPattern: string }> = {
  generic: { namingPattern: 'docType_suse_partnerProduct' },
  wso2: { namingPattern: 'docType_suse_partnerProduct' },
  clearml: { namingPattern: 'docType_suse_partnerProduct' },
  hitachi: { namingPattern: 'docType_suse_partnerProduct' },
};

export default function ProjectSetup() {
  const { id } = useParams();
  const navigate = useNavigate();
  const productMenuRef = useRef<HTMLDivElement | null>(null);
  const [loading, setLoading] = useState(true);
  const [submitting, setSubmitting] = useState(false);
  const [isProductMenuOpen, setIsProductMenuOpen] = useState(false);
  const [job, setJob] = useState<any>(null);

  const [formData, setFormData] = useState({
    suseProduct: 'suse-ai',
    partnerName: 'clearml',
    partnerProduct: 'clearml',
    documentType: 'reference',
    profileId: '',
    subfolder: 'extractions',
    customFilename: '',
  });

  useEffect(() => {
    const fetchData = async () => {
      try {
        const jobRes = await axios.get(`/api/jobs/${id}`);
        setJob(jobRes.data);

        const existingSetup = jobRes.data.projectSetup || {};
        const localExtractionPath = jobRes.data.localExtractionPath || '';
        const pathParts = localExtractionPath.split(/[\\/]/).filter(Boolean);
        const inferredSubfolder = pathParts.length > 1 ? pathParts.slice(0, -1).join('/') : 'extractions';
        const inferredFile = pathParts.length ? pathParts[pathParts.length - 1] : '';
        const inferredFilename = inferredFile.endsWith('.json') ? inferredFile.slice(0, -5) : inferredFile;
        const normalizedDocumentType =
          existingSetup.documentType === 'getting-started' || existingSetup.documentType === 'gs'
            ? 'getting-started'
            : 'reference';

        setFormData((prev) => ({
          partnerName: existingSetup.partnerName || prev.partnerName,
          suseProduct: existingSetup.suseProduct || prev.suseProduct,
          partnerProduct: existingSetup.partnerProduct || prev.partnerProduct,
          documentType: normalizedDocumentType || prev.documentType,
          profileId: existingSetup.profileId || prev.profileId,
          subfolder: existingSetup.subfolder || inferredSubfolder || prev.subfolder,
          customFilename: existingSetup.customFilename || inferredFilename || prev.customFilename,
        }));
      } catch (err) {
        console.error("Failed to fetch data:", err);
      } finally {
        setLoading(false);
      }
    };
    if (id) fetchData();
  }, [id]);

  useEffect(() => {
    const handleClickOutside = (event: MouseEvent) => {
      if (productMenuRef.current && !productMenuRef.current.contains(event.target as Node)) {
        setIsProductMenuOpen(false);
      }
    };

    const handleEscape = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        setIsProductMenuOpen(false);
      }
    };

    document.addEventListener('mousedown', handleClickOutside);
    document.addEventListener('keydown', handleEscape);

    return () => {
      document.removeEventListener('mousedown', handleClickOutside);
      document.removeEventListener('keydown', handleEscape);
    };
  }, []);

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setSubmitting(true);
    try {
      const autoResolvedProfile = resolveProfileFromPartner(formData.partnerName).profileId;
      await axios.post(`/api/setup-project/${id}`, {
        ...formData,
        profileId: formData.profileId || autoResolvedProfile,
        localExtractionPath: job?.localExtractionPath
      });
      navigate(`/job/${id}`);
    } catch (error: any) {
      alert(`Setup failed: ${error.message}`);
    } finally {
      setSubmitting(false);
    }
  };

  const getSafeName = (name: string, fallback: string) => 
    (name || fallback).toLowerCase().trim().replace(/[^a-z0-9\-]+/g, '-').replace(/^-+|-+$/g, '');

  const buildBaseNameFromPattern = (
    namingPattern: string,
    docPrefix: string,
    suseSlug: string,
    partnerProductSlug: string,
  ) => {
    if (namingPattern === 'docType_suse_partnerProduct') {
      return `${docPrefix}_${suseSlug}_${partnerProductSlug}`;
    }
    return `${docPrefix}_${suseSlug}_${partnerProductSlug}`;
  };

  const resolveProfileFromPartner = (partnerName: string) => {
    const normalized = (partnerName || '').toLowerCase().trim();
    if (!normalized) return { profileId: 'generic', fallbackUsed: true };
    if (normalized.includes('wso2') || normalized.includes('openchoreo')) {
      return { profileId: 'wso2', fallbackUsed: false };
    }
    if (normalized.includes('clearml')) {
      return { profileId: 'clearml', fallbackUsed: false };
    }
    if (normalized.includes('hitachi')) {
      return { profileId: 'hitachi', fallbackUsed: false };
    }
    return { profileId: 'generic', fallbackUsed: true };
  };

  const safePartner = getSafeName(formData.partnerName, "clearml");
  const safeSuse = getSafeName(formData.suseProduct, "suse-ai");
  const safePartnerProduct = getSafeName(formData.partnerProduct, "clearml");
  const docTypePrefix = formData.documentType === 'getting-started' ? 'gs' : 'rc';
  const resolvedProfile = formData.profileId || resolveProfileFromPartner(formData.partnerName).profileId;
  const fallbackUsed = formData.profileId ? false : resolveProfileFromPartner(formData.partnerName).fallbackUsed;
  const profileMeta = PROFILE_CONFIG[resolvedProfile] || PROFILE_CONFIG.generic;
  const docTokenMode = formData.documentType === 'getting-started' ? 'title/subtitle' : 'doctitle/docsubtitle';
  const baseName = buildBaseNameFromPattern(
    profileMeta.namingPattern,
    docTypePrefix,
    safeSuse,
    safePartnerProduct,
  );
  const extractionFile = formData.customFilename
    ? `${formData.customFilename.replace(/\.json$/i, '')}.json`
    : (job?.localExtractionPath?.split(/[\\/]/).pop() || 'source.json');

  if (loading) return <div className="p-20 text-center"><Loader2 className="animate-spin mx-auto text-suse-pine" /></div>;
  if (!job) return <div className="p-20 text-center text-red-500">Job not found.</div>;

  return (
    <div className="max-w-6xl mx-auto space-y-8 animate-in fade-in zoom-in-95 duration-300">
      <div className="space-y-1">
        <h1 className="text-3xl font-black text-white uppercase tracking-widest">Project Configuration</h1>
        <p className="font-mono text-xs text-gray-500 uppercase tracking-[0.2em]">Define metadata to generate the local workspace structure</p>
      </div>

      <form onSubmit={handleSubmit} className="space-y-8">
        <div className="grid grid-cols-1 lg:grid-cols-2 gap-8">
          {/* Settings Form Info */}
          <div className="bg-[#0b1612]/80 backdrop-blur-xl border border-suse-pine/20 rounded-2xl p-8 shadow-2xl">
            <div className="space-y-6">
              <div className="space-y-2">
                <label className="text-[10px] font-black text-suse-pine uppercase tracking-[0.2em] ml-1">SUSE Product</label>
                <div className="relative" ref={productMenuRef}>
                  <button
                    type="button"
                    onClick={() => setIsProductMenuOpen((prev) => !prev)}
                    className="w-full bg-suse-dark/80 border border-white/10 rounded-xl px-4 pr-11 py-3 text-left text-white font-bold focus:outline-none focus:border-suse-pine transition-all cursor-pointer"
                    aria-haspopup="listbox"
                    aria-expanded={isProductMenuOpen}
                  >
                    {formData.suseProduct}
                  </button>
                  <ChevronDown
                    size={16}
                    className={`pointer-events-none absolute right-4 top-1/2 -translate-y-1/2 text-suse-pine transition-transform ${isProductMenuOpen ? 'rotate-180' : ''}`}
                  />

                  {isProductMenuOpen && (
                    <div className="absolute z-40 mt-2 w-full overflow-hidden rounded-xl border border-suse-pine/30 bg-[#0b1612] shadow-2xl">
                      <ul className="max-h-64 overflow-auto py-1" role="listbox">
                        {formData.suseProduct && !SUSE_PRODUCTS.includes(formData.suseProduct) && (
                          <li>
                            <button
                              type="button"
                              onClick={() => {
                                setFormData({ ...formData, suseProduct: formData.suseProduct });
                                setIsProductMenuOpen(false);
                              }}
                              className="w-full px-4 py-2.5 text-left text-sm font-bold text-white bg-suse-pine/20"
                            >
                              {formData.suseProduct}
                            </button>
                          </li>
                        )}

                        {SUSE_PRODUCTS.map((product) => {
                          const isSelected = formData.suseProduct === product;
                          return (
                            <li key={product}>
                              <button
                                type="button"
                                onClick={() => {
                                  setFormData({ ...formData, suseProduct: product });
                                  setIsProductMenuOpen(false);
                                }}
                                className={`w-full px-4 py-2.5 text-left text-sm font-bold transition-colors ${
                                  isSelected
                                    ? 'bg-suse-pine/20 text-suse-pine'
                                    : 'text-gray-200 hover:bg-suse-jungle/70 hover:text-white'
                                }`}
                              >
                                {product}
                              </button>
                            </li>
                          );
                        })}
                      </ul>
                    </div>
                  )}
                </div>
              </div>

              <div className="space-y-2">
                <label className="text-[10px] font-black text-suse-pine uppercase tracking-[0.2em] ml-1">Partner Name</label>
                <input
                  type="text"
                  required
                  value={formData.partnerName}
                  onChange={(e) => setFormData({...formData, partnerName: e.target.value})}
                  className="w-full bg-suse-dark/80 border border-white/10 rounded-xl px-4 py-3 text-white font-bold focus:outline-none focus:border-suse-pine transition-all placeholder:text-gray-600 outline-none"
                  placeholder="clearml"
                />
              </div>

              <div className="space-y-2">
                <label className="text-[10px] font-black text-suse-pine uppercase tracking-[0.2em] ml-1">Partner Product</label>
                <input
                  type="text"
                  required
                  value={formData.partnerProduct}
                  onChange={(e) => setFormData({...formData, partnerProduct: e.target.value})}
                  className="w-full bg-suse-dark/80 border border-white/10 rounded-xl px-4 py-3 text-white font-bold focus:outline-none focus:border-suse-pine transition-all placeholder:text-gray-600 outline-none"
                  placeholder="clearml"
                />
              </div>

              <div className="space-y-2">
                <label className="text-[10px] font-black text-suse-pine uppercase tracking-[0.2em] ml-1">Document Type</label>
                <select
                  value={formData.documentType}
                  onChange={(e) => setFormData({ ...formData, documentType: e.target.value })}
                  className="w-full bg-suse-dark/80 border border-white/10 rounded-xl px-4 py-3 text-white font-bold focus:outline-none focus:border-suse-pine transition-all"
                >
                  <option value="reference">Reference Configuration</option>
                  <option value="getting-started">Getting Started</option>
                </select>
              </div>

              <div className="space-y-2">
                <label className="text-[10px] font-black text-suse-pine uppercase tracking-[0.2em] ml-1">Profile Override (optional)</label>
                <select
                  value={formData.profileId}
                  onChange={(e) => setFormData({ ...formData, profileId: e.target.value })}
                  className="w-full bg-suse-dark/80 border border-white/10 rounded-xl px-4 py-3 text-white font-bold focus:outline-none focus:border-suse-pine transition-all"
                >
                  <option value="">Auto resolve by partner</option>
                  <option value="wso2">WSO2</option>
                  <option value="clearml">ClearML</option>
                  <option value="hitachi">Hitachi</option>
                  <option value="generic">Generic</option>
                </select>
                <p className="text-[9px] text-gray-500 italic px-1">
                  Resolved profile: <span className="text-suse-pine font-bold">{resolvedProfile}</span>
                  {fallbackUsed ? ' (generic fallback)' : ' (partner-specific)'}
                </p>
                <p className="text-[9px] text-gray-500 italic px-1">
                  Canonical scaffold mode: <span className="text-suse-pine font-bold">enabled</span> (source: common/templates + common/adoc)
                </p>
                <p className="text-[9px] text-gray-500 italic px-1">
                  Doc tokens: <span className="text-suse-pine font-bold">{docTokenMode}</span> | Naming: <span className="text-suse-pine font-bold">{profileMeta.namingPattern}</span>
                </p>
                {fallbackUsed && (
                  <p className="text-[9px] text-amber-300 italic px-1">
                    No dedicated partner profile detected. Generation will use the generic fallback template.
                  </p>
                )}
              </div>

              <div className="space-y-2">
                <label className="text-[10px] font-black text-suse-pine uppercase tracking-[0.2em] ml-1">Storage Subfolder</label>
                <input
                  type="text"
                  required
                  value={formData.subfolder}
                  onChange={(e) => setFormData({...formData, subfolder: e.target.value})}
                  className="w-full bg-suse-dark/80 border border-white/10 rounded-xl px-4 py-3 text-white font-bold focus:outline-none focus:border-suse-pine transition-all placeholder:text-gray-600 outline-none"
                  placeholder="extractions"
                />
              </div>

              <div className="space-y-2">
                <label className="text-[10px] font-black text-suse-pine uppercase tracking-[0.2em] ml-1">Custom JSON Filename</label>
                <input
                  type="text"
                  value={formData.customFilename}
                  onChange={(e) => setFormData({...formData, customFilename: e.target.value})}
                  className="w-full bg-suse-dark/80 border border-white/10 rounded-xl px-4 py-3 text-white font-bold focus:outline-none focus:border-suse-pine transition-all placeholder:text-gray-600 outline-none"
                  placeholder="rc-input"
                />
                <p className="text-[9px] text-gray-500 italic px-1">Local extraction will be saved at `data/{formData.subfolder}/{extractionFile}`</p>
              </div>
            </div>
          </div>

          {/* Live Hierarchy Preview */}
          <div className="bg-suse-jungle/20 border border-white/5 rounded-2xl p-8 flex flex-col space-y-6">
            <div className="flex items-center gap-3 border-b border-white/10 pb-4">
              <div className="p-2 bg-suse-pine/10 rounded-xl border border-suse-pine/20">
                <FolderTree size={20} className="text-suse-pine" />
              </div>
              <div className="flex flex-col">
                <span className="text-[10px] font-black text-white uppercase tracking-[0.2em]">Workspace Projection</span>
                <span className="text-[9px] font-mono text-gray-500">Real-time local artifact structuring</span>
              </div>
            </div>

            <div className="flex-1 overflow-auto bg-suse-dark/30 rounded-xl border border-white/5 p-6 font-mono text-xs">
              <div className="space-y-4">
                <div className="flex items-center gap-2 text-suse-pine font-bold">
                  <Folder size={16} fill="currentColor" className="text-suse-pine opacity-80" />
                  / (project root)
                </div>
                
                <div className="pl-6 space-y-4 relative">
                  <div className="absolute left-2.5 top-[-10px] bottom-0 w-px bg-white/10" />
                  <div className="flex items-center gap-2 text-gray-300 relative group">
                    <div className="absolute left-[-22px] w-4 h-px bg-white/10" />
                    <Folder size={16} className="text-gray-400 group-hover:text-white transition-colors" />
                    <span className="bg-white/5 px-2 py-0.5 rounded text-suse-pine uppercase font-bold tracking-widest">references</span>
                  </div>

                  <div className="pl-6 space-y-3 relative">
                    <div className="absolute left-2.5 top-[-10px] bottom-0 w-px bg-white/10" />
                  <div className="flex items-center gap-2 text-gray-300 relative group">
                    <div className="absolute left-[-22px] w-4 h-px bg-white/10" />
                    <Folder size={16} className="text-gray-400 group-hover:text-white transition-colors" />
                    <span className="bg-white/5 px-2 py-0.5 rounded text-white font-bold">{safePartner || 'partner'}</span>
                  </div>

                    {/* Files inside partner folder */}
                    <div className="pl-6 space-y-2 relative">
                      <div className="absolute left-2.5 top-[-10px] bottom-0 w-px bg-white/10" />
                      
                      <div className="flex items-center gap-2 text-gray-400 relative">
                        <div className="absolute left-[-22px] w-4 h-px bg-white/10" />
                        <File size={14} className="text-suse-water" />
                        <span className="text-gray-300">{`DC-${baseName}`}</span>
                        <span className="ml-auto text-[9px] text-gray-600 bg-black/50 px-2 rounded-full border border-white/5">Target</span>
                      </div>

                      <div className="flex items-center gap-2 text-gray-400 relative">
                        <div className="absolute left-[-22px] w-4 h-px bg-white/10" />
                        <File size={14} className="text-orange-400" />
                        <span className="text-gray-300">manifest.json</span>
                        <span className="ml-auto text-[9px] text-gray-600 bg-black/50 px-2 rounded-full border border-white/5">Metadata</span>
                      </div>

                      <div className="flex items-center gap-2 text-gray-400 relative">
                        <div className="absolute left-[-22px] w-4 h-px bg-white/10" />
                        <Folder size={14} className="text-gray-400" />
                        <span className="text-gray-300">adoc/</span>
                      </div>

                      <div className="pl-6 space-y-1.5 relative">
                        <div className="absolute left-2.5 top-[-8px] bottom-0 w-px bg-white/10" />
                        <div className="flex items-center gap-2 text-gray-400 relative">
                          <div className="absolute left-[-22px] w-4 h-px bg-white/10" />
                          <File size={14} className="text-suse-water" />
                          <span className="text-gray-300">{`${baseName}.adoc`}</span>
                        </div>
                        <div className="flex items-center gap-2 text-gray-400 relative">
                          <div className="absolute left-[-22px] w-4 h-px bg-white/10" />
                          <File size={14} className="text-suse-water" />
                          <span className="text-gray-300">{`${baseName}-docinfo.xml`}</span>
                        </div>
                        <div className="flex items-center gap-2 text-gray-400 relative">
                          <div className="absolute left-[-22px] w-4 h-px bg-white/10" />
                          <File size={14} className="text-suse-water" />
                          <span className="text-gray-300">{`${baseName}-vars.adoc`}</span>
                        </div>
                      </div>

                      <div className="flex items-center gap-2 text-gray-400 relative">
                        <div className="absolute left-[-22px] w-4 h-px bg-white/10" />
                        <Folder size={14} className="text-gray-400" />
                        <span className="text-gray-300">media/src/png</span>
                      </div>
                      <div className="flex items-center gap-2 text-gray-400 relative">
                        <div className="absolute left-[-22px] w-4 h-px bg-white/10" />
                        <Folder size={14} className="text-gray-400" />
                        <span className="text-gray-300">media/src/svg</span>
                      </div>

                      <div className="flex items-center gap-2 text-gray-500 relative mt-4 opacity-50">
                        <div className="absolute left-[-22px] w-4 h-px bg-white/10" />
                        <File size={14} className="text-gray-500" />
                        <span>{formData.subfolder}/{extractionFile}</span>
                        <span className="ml-auto text-[9px]">Input Ref</span>
                      </div>
                    </div>
                  </div>
                </div>
              </div>
            </div>
          </div>
        </div>

        <div className="pt-2">
          <button
            type="submit"
            disabled={submitting || !formData.partnerName || !formData.suseProduct || !formData.partnerProduct}
            className="w-full flex justify-center items-center gap-2 bg-suse-pine text-suse-dark py-4 rounded-xl font-black uppercase tracking-[0.2em] text-[13px] hover:bg-suse-neon hover:shadow-[0_0_20px_rgba(48,186,120,0.4)] transition-all disabled:opacity-50 disabled:pointer-events-none"
          >
            {submitting ? <Loader2 size={18} className="animate-spin" /> : <Save size={18} />}
            Convert to ASCII
          </button>
        </div>
      </form>
    </div>
  );
}
