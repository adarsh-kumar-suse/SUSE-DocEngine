import React from 'react';
import axios from 'axios';
import { useNavigate } from 'react-router-dom';
import { AlertTriangle, CheckCircle2, Loader2, RotateCcw, Save, ShieldAlert } from 'lucide-react';
import { clsx } from 'clsx';
import { getActiveProjectId } from '../lib/projects';

type DocType = 'gs' | 'rc';

type RefsetupInput = {
  doctype: DocType;
  suseProducts: string[];
  partnerKey: string;
  partnerProduct: string;
  distinctiveText: string;
};

type StructurePreview = {
  documentbase: string;
  dcFileName: string;
  rootPath: string;
  partnerFolder: string;
  presetPartnerKey: string;
  tree: string[];
};

type StructureValidation = {
  ok: boolean;
  preview: StructurePreview;
  missingRequirements: string[];
  collisions: string[];
};

type ProductOption = {
  code: string;
  label: string;
};

type PartnerPresetOption = {
  partnerKey: string;
  label: string;
  doctype: DocType | null;
  comingSoon: boolean;
  sourceUrl?: string;
  sourceFileName?: string;
};

const RESET_CONFIRMATION = 'RESET PIPELINE DATA';

const SUSE_PRODUCT_OPTIONS: ProductOption[] = [
  { code: 'sles', label: 'SUSE Linux Enterprise Server' },
  { code: 'slessap', label: 'SUSE Linux Enterprise Server for SAP applications' },
  { code: 'slehpc', label: 'SUSE Linux Enterprise HPC' },
  { code: 'slmicro', label: 'SUSE Linux Micro' },
  { code: 'slelp', label: 'SUSE Linux Enterprise Live Patching' },
  { code: 'slert', label: 'SUSE Linux Enterprise Real Time' },
  { code: 'sleha', label: 'SUSE Linux Enterprise for High Availability' },
  { code: 'slebci', label: 'SUSE Linux Enterprise Base Container Images' },
  { code: 'smlm', label: 'SUSE Multi-Linux Manager' },
  { code: 'rancher', label: 'SUSE Rancher Prime' },
  { code: 'sto', label: 'SUSE Storage' },
  { code: 'sec', label: 'SUSE Security' },
  { code: 'obs', label: 'SUSE Observability' },
  { code: 'virt', label: 'SUSE Virtualization' },
  { code: 'edge', label: 'SUSE Edge' },
  { code: 'telco', label: 'SUSE Telco' },
  { code: 'ai', label: 'SUSE AI' },
  { code: 'rke', label: 'Rancher Kubernetes Engine' },
  { code: 'rke2', label: 'Rancher Kubernetes Engine 2' },
  { code: 'k3s', label: 'K3s' },
];

const toApiErrorMessage = (err: unknown, fallback: string) => {
  const maybe = err as {
    response?: { data?: { error?: { message?: string } | string } };
    message?: string;
  };
  if (typeof maybe?.response?.data?.error === 'string') return maybe.response.data.error;
  if (typeof maybe?.response?.data?.error === 'object' && maybe.response.data.error?.message) {
    return maybe.response.data.error.message;
  }
  return maybe?.message || fallback;
};

export default function NewJob() {
  const navigate = useNavigate();

  const [doctype, setDoctype] = React.useState<DocType>('rc');
  const [suseProducts, setSuseProducts] = React.useState<string[]>(['rancher']);
  const [partnerKey, setPartnerKey] = React.useState('');
  const [partnerProduct, setPartnerProduct] = React.useState('');
  const [distinctiveText, setDistinctiveText] = React.useState('');
  const [partnerPresets, setPartnerPresets] = React.useState<PartnerPresetOption[]>([]);
  const [partnerPresetLoading, setPartnerPresetLoading] = React.useState(false);

  const [preview, setPreview] = React.useState<StructurePreview | null>(null);
  const [previewLoading, setPreviewLoading] = React.useState(false);
  const [validateLoading, setValidateLoading] = React.useState(false);
  const [saveLoading, setSaveLoading] = React.useState(false);
  const [validation, setValidation] = React.useState<StructureValidation | null>(null);
  const [status, setStatus] = React.useState('');
  const [error, setError] = React.useState('');

  const [resetConfirmation, setResetConfirmation] = React.useState('');
  const [resetLoading, setResetLoading] = React.useState(false);
  const [resetMessage, setResetMessage] = React.useState('');
  const [resetError, setResetError] = React.useState('');

  const structureInput = React.useMemo<RefsetupInput>(
    () => ({
      doctype,
      suseProducts,
      partnerKey: partnerKey.trim().toLowerCase(),
      partnerProduct: partnerProduct.trim(),
      distinctiveText: distinctiveText.trim(),
    }),
    [doctype, suseProducts, partnerKey, partnerProduct, distinctiveText],
  );

  const selectedPartnerPreset = React.useMemo(
    () => partnerPresets.find((entry) => entry.partnerKey === structureInput.partnerKey) || null,
    [partnerPresets, structureInput.partnerKey],
  );
  const doctypeCompatible = !selectedPartnerPreset?.doctype || selectedPartnerPreset.doctype === doctype;
  const partnerSupported = Boolean(selectedPartnerPreset && !selectedPartnerPreset.comingSoon);
  const canPreview =
    structureInput.partnerKey.length > 0 &&
    structureInput.suseProducts.length > 0 &&
    partnerSupported &&
    doctypeCompatible;

  const requestPreview = React.useCallback(
    async (silent = false) => {
      if (!canPreview) {
        setPreview(null);
        return;
      }
      if (!silent) {
        setPreviewLoading(true);
        setError('');
        setStatus('');
      }
      try {
        const response = await axios.post('/api/pipeline/structure/preview', structureInput);
        setPreview(response.data as StructurePreview);
      } catch (err) {
        if (!silent) {
          setError(toApiErrorMessage(err, 'Failed to build structure preview.'));
        }
      } finally {
        if (!silent) setPreviewLoading(false);
      }
    },
    [canPreview, structureInput],
  );

  const runValidation = async () => {
    setValidateLoading(true);
    setError('');
    setStatus('');
    try {
      const response = await axios.post('/api/pipeline/structure/validate', structureInput);
      const payload = response.data as StructureValidation;
      setValidation(payload);
      setPreview(payload.preview || null);
      if (payload.ok) {
        setStatus('Validation passed. Structure can be saved.');
      } else {
        setStatus('Validation completed with issues. Resolve missing requirements/collisions first.');
      }
    } catch (err) {
      setError(toApiErrorMessage(err, 'Failed to validate structure.'));
    } finally {
      setValidateLoading(false);
    }
  };

  const saveStructure = async () => {
    if (!validation?.ok) {
      setStatus('Run Validate first and fix any issues before saving structure.');
      return;
    }
    setSaveLoading(true);
    setError('');
    setStatus('');
    try {
      const response = await axios.post('/api/pipeline/structure/save', {
        ...structureInput,
        projectId: getActiveProjectId() || undefined,
      });
      const jobId = response.data?.job?.id;
      if (!jobId) {
        throw new Error('Pipeline workspace created but job id was missing.');
      }
      navigate(`/pipeline-studio/${jobId}`);
    } catch (err) {
      setError(toApiErrorMessage(err, 'Failed to save structure.'));
    } finally {
      setSaveLoading(false);
    }
  };

  const runFullReset = async () => {
    setResetLoading(true);
    setResetError('');
    setResetMessage('');
    try {
      await axios.post('/api/admin/pipeline-reset-full', {
        confirmation: resetConfirmation,
      });
      setResetMessage('Pipeline data reset completed. Redirecting to login...');
      setTimeout(() => {
        window.location.href = '/login';
      }, 900);
    } catch (err) {
      setResetError(toApiErrorMessage(err, 'Full reset failed.'));
    } finally {
      setResetLoading(false);
    }
  };

  const toggleProduct = (code: string) => {
    setSuseProducts((prev) =>
      prev.includes(code) ? prev.filter((item) => item !== code) : [...prev, code],
    );
    setValidation(null);
  };

  React.useEffect(() => {
    const loadPartnerPresets = async () => {
      setPartnerPresetLoading(true);
      setError('');
      try {
        const response = await axios.get('/api/pipeline/partner-presets');
        const presets = Array.isArray(response.data?.partners) ? (response.data.partners as PartnerPresetOption[]) : [];
        setPartnerPresets(presets);
        setPartnerKey((current) => {
          if (current && presets.some((entry) => entry.partnerKey === current && !entry.comingSoon)) return current;
          const preferredForDocType = presets.find((entry) => !entry.comingSoon && (!entry.doctype || entry.doctype === doctype));
          const fallback = presets.find((entry) => !entry.comingSoon);
          return preferredForDocType?.partnerKey || fallback?.partnerKey || '';
        });
      } catch (err) {
        setError(toApiErrorMessage(err, 'Failed to load partner presets.'));
      } finally {
        setPartnerPresetLoading(false);
      }
    };
    loadPartnerPresets();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  React.useEffect(() => {
    if (!canPreview) {
      setPreview(null);
      return;
    }
    const timer = setTimeout(() => {
      requestPreview(true);
    }, 300);
    return () => clearTimeout(timer);
  }, [canPreview, requestPreview]);

  React.useEffect(() => {
    if (!partnerKey) return;
    const current = partnerPresets.find((entry) => entry.partnerKey === partnerKey);
    if (!current) return;
    if (current.comingSoon || (current.doctype && current.doctype !== doctype)) {
      const replacement = partnerPresets.find((entry) => !entry.comingSoon && (!entry.doctype || entry.doctype === doctype));
      if (replacement) {
        setPartnerKey(replacement.partnerKey);
        setValidation(null);
      }
    }
  }, [doctype, partnerKey, partnerPresets]);

  return (
    <div className="max-w-7xl mx-auto space-y-6">
      <div className="suse-card p-6">
        <div className="flex flex-col gap-2">
          <p className="text-xs uppercase tracking-[0.18em] text-suse-pine font-bold">Pipeline Rebuild</p>
          <h1 className="text-3xl font-bold text-white">Structure Builder</h1>
          <p className="text-sm text-gray-400">
            Step 1 builds a refsetup-style workspace. Step 2 opens Pipeline Studio for upload, editing, and DAPS HTML rendering.
          </p>
        </div>
      </div>

      {error ? <div className="rounded-xl border border-red-500/40 bg-red-500/10 p-3 text-sm text-red-300">{error}</div> : null}
      {status ? <div className="rounded-xl border border-suse-pine/30 bg-suse-pine/10 p-3 text-sm text-suse-pine">{status}</div> : null}

      <div className="grid grid-cols-1 xl:grid-cols-2 gap-6">
        <section className="suse-card p-6 space-y-6">
          <div>
            <p className="text-xs text-gray-500 uppercase tracking-widest mb-2">Document Type</p>
            <div className="grid grid-cols-2 gap-2">
              {(['gs', 'rc'] as DocType[]).map((type) => (
                <button
                  key={type}
                  type="button"
                  onClick={() => {
                    setDoctype(type);
                    setValidation(null);
                  }}
                  className={clsx(
                    'rounded-lg border px-4 py-2 text-sm font-semibold uppercase tracking-wider transition-colors',
                    doctype === type
                      ? 'border-suse-pine bg-suse-pine/15 text-suse-pine'
                      : 'border-white/10 text-gray-300 hover:bg-white/5',
                  )}
                >
                  {type}
                </button>
              ))}
            </div>
            <div className="grid grid-cols-2 gap-2 mt-2">
              <div className="rounded-lg border border-white/10 px-4 py-2 text-xs text-gray-500 uppercase tracking-wider">
                ri (coming next)
              </div>
              <div className="rounded-lg border border-white/10 px-4 py-2 text-xs text-gray-500 uppercase tracking-wider">
                ea (coming next)
              </div>
            </div>
          </div>

          <div>
            <p className="text-xs text-gray-500 uppercase tracking-widest mb-2">Featured SUSE Products</p>
            <div className="max-h-64 overflow-y-auto pr-2 space-y-2">
              {SUSE_PRODUCT_OPTIONS.map((product) => {
                const selected = suseProducts.includes(product.code);
                return (
                  <label
                    key={product.code}
                    className={clsx(
                      'flex items-start gap-3 rounded-lg border px-3 py-2 cursor-pointer transition-colors',
                      selected
                        ? 'border-suse-pine/50 bg-suse-pine/10'
                        : 'border-white/10 hover:bg-white/5',
                    )}
                  >
                    <input
                      type="checkbox"
                      checked={selected}
                      onChange={() => toggleProduct(product.code)}
                      className="mt-1"
                    />
                    <span>
                      <span className="block text-sm font-semibold text-gray-200">{product.code}</span>
                      <span className="block text-xs text-gray-500">{product.label}</span>
                    </span>
                  </label>
                );
              })}
            </div>
          </div>

            <div className="space-y-3">
              <div>
                <label className="block text-xs text-gray-500 uppercase tracking-widest mb-1">Primary Partner</label>
                <select
                  value={partnerKey}
                  onChange={(event) => {
                    setPartnerKey(event.target.value);
                    setValidation(null);
                  }}
                  className="w-full bg-suse-dark/70 border border-white/10 rounded-lg px-3 py-2 text-sm text-white focus:outline-none focus:border-suse-pine/60"
                >
                  {partnerPresets.map((partner) => {
                    const restrictedByDocType = Boolean(partner.doctype && partner.doctype !== doctype);
                    const disabled = partner.comingSoon || restrictedByDocType;
                    const suffix = partner.comingSoon
                      ? ' (coming soon)'
                      : restrictedByDocType
                        ? ` (${partner.doctype?.toUpperCase()} only)`
                        : '';
                    return (
                      <option key={partner.partnerKey} value={partner.partnerKey} disabled={disabled}>
                        {partner.label}
                        {suffix}
                      </option>
                    );
                  })}
                </select>
                {partnerPresetLoading ? (
                  <p className="mt-1 text-[11px] text-gray-500">Loading partner presets...</p>
                ) : null}
                {!doctypeCompatible && selectedPartnerPreset?.doctype ? (
                  <p className="mt-1 text-[11px] text-amber-300">
                    {selectedPartnerPreset.label} supports only {selectedPartnerPreset.doctype.toUpperCase()}.
                  </p>
                ) : null}
              </div>
            <div>
              <label className="block text-xs text-gray-500 uppercase tracking-widest mb-1">Partner Product (Optional)</label>
              <input
                value={partnerProduct}
                onChange={(event) => {
                  setPartnerProduct(event.target.value);
                  setValidation(null);
                }}
                placeholder="openchoreo"
                className="w-full bg-suse-dark/70 border border-white/10 rounded-lg px-3 py-2 text-sm text-white focus:outline-none focus:border-suse-pine/60"
              />
            </div>
            <div>
              <label className="block text-xs text-gray-500 uppercase tracking-widest mb-1">Distinctive Text (Optional)</label>
              <input
                value={distinctiveText}
                onChange={(event) => {
                  setDistinctiveText(event.target.value);
                  setValidation(null);
                }}
                placeholder="dev-platform"
                className="w-full bg-suse-dark/70 border border-white/10 rounded-lg px-3 py-2 text-sm text-white focus:outline-none focus:border-suse-pine/60"
              />
            </div>
          </div>

          <div className="flex flex-wrap gap-2 pt-2">
            <button
              type="button"
              onClick={() => requestPreview(false)}
              disabled={!canPreview || previewLoading}
              className="suse-button-outline inline-flex items-center gap-2 disabled:opacity-50"
            >
              {previewLoading ? <Loader2 size={14} className="animate-spin" /> : <RotateCcw size={14} />}
              Preview
            </button>
            <button
              type="button"
              onClick={runValidation}
              disabled={!canPreview || validateLoading}
              className="suse-button-outline inline-flex items-center gap-2 disabled:opacity-50"
            >
              {validateLoading ? <Loader2 size={14} className="animate-spin" /> : <CheckCircle2 size={14} />}
              Validate
            </button>
            <button
              type="button"
              onClick={saveStructure}
              disabled={!canPreview || saveLoading || !validation?.ok}
              className="suse-button-primary inline-flex items-center gap-2 disabled:opacity-50"
            >
              {saveLoading ? <Loader2 size={14} className="animate-spin" /> : <Save size={14} />}
              Save Structure
            </button>
          </div>
        </section>

        <section className="suse-card p-6 space-y-4">
          <div className="flex items-center justify-between">
            <h2 className="text-lg font-semibold text-white">Refsetup Tree Preview</h2>
            {preview?.presetPartnerKey ? (
              <span className="text-xs uppercase tracking-wider text-suse-pine">Preset: {preview.presetPartnerKey}</span>
            ) : null}
          </div>

          <div className="rounded-xl border border-white/10 bg-suse-dark/70 p-4 min-h-[320px]">
            {!canPreview ? (
              <p className="text-sm text-gray-500">Select at least one SUSE product and a supported partner preset to generate preview.</p>
            ) : !preview ? (
              <p className="text-sm text-gray-500">Generating preview...</p>
            ) : (
              <div className="space-y-3">
                <div className="text-xs text-gray-400 space-y-1">
                  <div>
                    <span className="text-gray-500">Document Base:</span> {preview.documentbase}
                  </div>
                  <div>
                    <span className="text-gray-500">Workspace Root:</span> {preview.rootPath}
                  </div>
                </div>
                <pre className="text-xs leading-6 text-gray-200 font-mono whitespace-pre-wrap">
{preview.tree.join('\n')}
                </pre>
              </div>
            )}
          </div>

          <div className="rounded-xl border border-white/10 bg-white/5 p-4 space-y-3">
            <h3 className="text-sm font-semibold text-white">Validation Result</h3>
            {!validation ? (
              <p className="text-xs text-gray-500">Run Validate to check templates/common prerequisites and path collisions.</p>
            ) : (
              <>
                <p
                  className={clsx(
                    'text-xs font-semibold uppercase tracking-wider',
                    validation.ok ? 'text-suse-pine' : 'text-amber-300',
                  )}
                >
                  {validation.ok ? 'Ready to save' : 'Validation issues found'}
                </p>
                {validation.missingRequirements.length > 0 ? (
                  <div>
                    <p className="text-xs text-red-300 mb-1">Missing requirements:</p>
                    <ul className="text-xs text-red-200 space-y-1 list-disc ml-5">
                      {validation.missingRequirements.map((item) => (
                        <li key={item}>{item}</li>
                      ))}
                    </ul>
                  </div>
                ) : null}
                {validation.collisions.length > 0 ? (
                  <div>
                    <p className="text-xs text-amber-300 mb-1">Path collisions:</p>
                    <ul className="text-xs text-amber-200 space-y-1 list-disc ml-5">
                      {validation.collisions.map((item) => (
                        <li key={item}>{item}</li>
                      ))}
                    </ul>
                  </div>
                ) : null}
              </>
            )}
          </div>
        </section>
      </div>

      <section className="suse-card p-6 space-y-4 border-red-500/20">
        <div className="flex items-start gap-3">
          <ShieldAlert className="text-red-300 mt-0.5" size={18} />
          <div>
            <h2 className="text-lg font-semibold text-white">Full Pipeline Reset (Admin)</h2>
            <p className="text-xs text-gray-400 mt-1">
              This is destructive. It clears jobs/users/sessions/app db and removes document/reference artifacts.
            </p>
          </div>
        </div>

        {resetError ? <div className="rounded-lg border border-red-500/40 bg-red-500/10 p-2 text-xs text-red-300">{resetError}</div> : null}
        {resetMessage ? <div className="rounded-lg border border-suse-pine/30 bg-suse-pine/10 p-2 text-xs text-suse-pine">{resetMessage}</div> : null}

        <div className="grid grid-cols-1 md:grid-cols-[1fr_auto] gap-3 items-end">
          <div>
            <label className="block text-xs text-gray-500 uppercase tracking-widest mb-1">
              Confirmation text ({RESET_CONFIRMATION})
            </label>
            <input
              value={resetConfirmation}
              onChange={(event) => setResetConfirmation(event.target.value)}
              placeholder={RESET_CONFIRMATION}
              className="w-full bg-suse-dark/70 border border-white/10 rounded-lg px-3 py-2 text-sm text-white focus:outline-none focus:border-red-400/60"
            />
          </div>
          <button
            type="button"
            onClick={runFullReset}
            disabled={resetLoading || resetConfirmation.trim() !== RESET_CONFIRMATION}
            className="inline-flex items-center justify-center gap-2 rounded-lg border border-red-400/40 bg-red-500/10 px-4 py-2 text-sm font-semibold text-red-300 hover:bg-red-500/20 disabled:opacity-50"
          >
            {resetLoading ? <Loader2 size={14} className="animate-spin" /> : <AlertTriangle size={14} />}
            Reset Data
          </button>
        </div>
      </section>
    </div>
  );
}
