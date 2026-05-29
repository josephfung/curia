import { useState, useEffect, type JSX, type CSSProperties } from 'react';
import { useNavigate, useSearch } from '@tanstack/react-router';
import { apiFetch } from '../api.js';
import {
  DEFAULT_WIZARD_STATE,
  TONE_OPTIONS,
  toggleToneSelection,
  verbosityBand,
  directnessBand,
  tonePreviewText,
  verbosityReviewDesc,
  directnessReviewDesc,
  postureReviewDesc,
  validateStep1,
  buildIdentityPayload,
  type WizardState,
  type LocalIdentity,
} from './wizard-utils.js';

const TOTAL_STEPS = 4;

// ── Identity API types ────────────────────────────────────────────────────────

interface IdentityResponse {
  identity: LocalIdentity;
  configured: boolean;
}

// ── Safe error extraction ─────────────────────────────────────────────────────

async function extractError(res: Response): Promise<string> {
  const ct = res.headers.get('content-type') ?? '';
  if (ct.includes('application/json')) {
    try {
      const d = await res.json() as { error?: string };
      if (d.error) return d.error;
    } catch (_) { /* fall through */ }
  }
  return `HTTP ${res.status}`;
}

// ── WizardPage ────────────────────────────────────────────────────────────────

export default function WizardPage() {
  const navigate = useNavigate();
  // Read step from URL search params. strict:false avoids circular import with router.tsx.
  const search = useSearch({ strict: false }) as { step?: number };
  const currentStep = Math.max(1, Math.min(TOTAL_STEPS, search.step ?? 1));

  const [state, setState] = useState<WizardState>(DEFAULT_WIZARD_STATE);
  const [existingIdentity, setExistingIdentity] = useState<LocalIdentity | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [step1Error, setStep1Error] = useState('');
  const [submitError, setSubmitError] = useState('');
  const [submitting, setSubmitting] = useState(false);

  // Pre-populate form from current identity on mount.
  useEffect(() => {
    async function load() {
      try {
        const res = await apiFetch('/api/identity');
        if (!res.ok) throw new Error(await extractError(res));
        const data = await res.json() as IdentityResponse;
        const id = data.identity;
        setExistingIdentity(id);
        setState({
          name: id.assistant.name || DEFAULT_WIZARD_STATE.name,
          title: id.assistant.title || DEFAULT_WIZARD_STATE.title,
          signature: id.assistant.emailSignature || '',
          toneBaseline:
            id.tone.baseline.length > 0
              ? id.tone.baseline
              : DEFAULT_WIZARD_STATE.toneBaseline,
          verbosity: id.tone.verbosity ?? DEFAULT_WIZARD_STATE.verbosity,
          directness: id.tone.directness ?? DEFAULT_WIZARD_STATE.directness,
          posture: id.decisionStyle.externalActions || DEFAULT_WIZARD_STATE.posture,
          preferences: '', // always blank on entry — append mode
        });
      } catch (err) {
        setLoadError(err instanceof Error ? err.message : 'Failed to load identity');
      }
    }
    void load();
  }, []);

  function goTo(step: number) {
    // Non-critical navigation: if a router guard blocks this, the user stays on the
    // current step. Swallowing the error is intentional — there's no UI to surface it.
    navigate({ to: '/setup', search: { step } }).catch(() => {});
  }

  function handleContinue() {
    if (currentStep === 1) {
      if (!validateStep1(state.name)) {
        setStep1Error('Assistant name is required.');
        return;
      }
      setStep1Error('');
    }
    if (currentStep < TOTAL_STEPS) goTo(currentStep + 1);
  }

  function handleBack() {
    if (currentStep > 1) goTo(currentStep - 1);
  }

  async function handleSubmit() {
    if (!existingIdentity) return;
    setSubmitting(true);
    setSubmitError('');
    try {
      const { identity, note } = buildIdentityPayload(state, existingIdentity);
      const putRes = await apiFetch('/api/identity', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ identity, note }),
      });
      if (!putRes.ok) throw new Error(await extractError(putRes));
      const reloadRes = await apiFetch('/api/identity/reload', { method: 'POST' });
      if (!reloadRes.ok) throw new Error(await extractError(reloadRes));
      // await inside the try block so navigation failures are caught and surface
      // the submitError + re-enable buttons, rather than leaving a stuck spinner.
      await navigate({ to: '/' });
    } catch (err) {
      setSubmitError(err instanceof Error ? err.message : 'Save failed');
      setSubmitting(false);
    }
  }

  // ── Progress dots ───────────────────────────────────────────────────────────

  const progressDots = Array.from({ length: TOTAL_STEPS }, (_, i) => (
    <div
      key={i}
      className={`wizard-dot${i < currentStep ? ' done' : ''}`}
    />
  ));

  // ── Header ──────────────────────────────────────────────────────────────────

  // Icons.Wordmark does not exist in this codebase; use the inline SVG wordmark.
  const header = (
    <div className="wizard-topbar">
      <svg
        xmlns="http://www.w3.org/2000/svg"
        viewBox="0 0 3024 690"
        fill="currentColor"
        aria-label="Curia"
        role="img"
        style={{ height: '1.125rem', width: 'auto', color: 'var(--app-fg)' } as CSSProperties}
      >
        <path d="M353.581 10.0006C163.722 10.0004 9.81112 163.911 9.81112 353.77C9.81106 498.564 99.4541 622.21 226.165 672.864L239.837 659.126L309.763 589.2C309.784 589.204 309.807 589.197 309.828 589.2L353.581 545.383L397.398 589.2L461.074 652.876L480.997 672.864C607.707 622.211 697.351 498.564 697.351 353.77C697.351 163.912 543.44 10.0007 353.581 10.0006ZM353.581 114.173C485.907 114.173 593.178 221.445 593.178 353.77C593.178 431.275 556.255 499.947 499.162 543.69L427.218 471.746L454.042 444.921L453.782 444.661C475.604 420.619 489.005 388.796 489.005 353.77C489.005 278.977 428.374 218.346 353.581 218.346C278.788 218.346 218.156 278.977 218.156 353.77C218.156 390.521 232.805 423.842 256.57 448.242L256.505 448.307L279.944 471.746L208 543.625C150.925 499.881 113.984 431.261 113.984 353.77C113.984 221.445 221.255 114.173 353.581 114.173ZM353.581 322.519C370.841 322.519 384.833 336.511 384.833 353.77C384.833 362.451 381.237 370.244 375.522 375.907L375.652 376.037L353.581 398.109L331.509 376.037L331.639 375.907C325.925 370.244 322.329 362.451 322.329 353.77C322.329 336.51 336.321 322.519 353.581 322.519Z" fillRule="nonzero" />
        <path d="M973.772 355.789C973.772 488.115 1081.04 595.386 1213.37 595.386C1291.91 595.386 1361.35 557.422 1405.05 499.026L1330.11 424.087C1306.6 464.19 1263.21 491.214 1213.37 491.213C1138.58 491.213 1077.95 430.582 1077.95 355.789C1077.95 280.996 1138.58 220.364 1213.37 220.365C1262.78 220.365 1305.8 246.93 1329.46 286.449L1404.33 211.575C1360.59 153.731 1291.48 116.192 1213.37 116.192C1081.04 116.192 973.772 223.463 973.772 355.789Z" fillRule="nonzero" />
        <path d="M1670.51 594.763C1627.62 594.763 1591.42 586.709 1561.89 570.602C1532.37 554.494 1509.92 531.731 1494.54 502.312C1479.15 472.893 1471.46 438.191 1471.46 398.207L1471.46 128.932L1573.39 128.932L1573.39 401.936C1573.39 421.617 1577.17 438.839 1584.74 453.6C1592.3 468.361 1603.28 479.73 1617.68 487.706C1632.07 495.682 1649.68 499.67 1670.51 499.67C1691.33 499.67 1708.91 495.708 1723.26 487.784C1737.6 479.859 1748.48 468.594 1755.89 453.988C1763.29 439.383 1767 422.032 1767 401.936L1767 128.932L1868.93 128.932L1868.93 398.207C1868.93 438.191 1861.34 472.893 1846.16 502.312C1830.99 531.731 1808.66 554.494 1779.19 570.602C1749.72 586.709 1713.49 594.763 1670.51 594.763Z" fillRule="nonzero" />
        <path d="M1951.74 582.644L1951.74 125.514L2053.67 125.514L2053.67 582.644L1951.74 582.644ZM2226.92 582.644L2093.76 387.641L2205.79 387.641L2345.16 582.644L2226.92 582.644ZM2026.01 437.207L2026.01 357.031L2138.04 357.031C2153.06 357.031 2166.01 354.027 2176.88 348.019C2187.76 342.011 2196.23 333.542 2202.29 322.614C2208.35 311.686 2211.38 299.022 2211.38 284.623C2211.38 269.914 2208.35 257.095 2202.29 246.167C2196.23 235.238 2187.76 226.744 2176.88 220.684C2166.01 214.624 2153.06 211.594 2138.04 211.594L2026.01 211.594L2026.01 125.514L2130.11 125.514C2167.92 125.514 2200.66 131.185 2228.32 142.528C2255.97 153.871 2277.26 170.755 2292.18 193.182C2307.09 215.608 2314.55 243.655 2314.55 277.321L2314.55 287.265C2314.55 320.931 2306.99 348.822 2291.87 370.937C2276.74 393.053 2255.46 409.627 2228 420.659C2200.55 431.691 2167.92 437.207 2130.11 437.207L2026.01 437.207Z" fillRule="nonzero" />
        <path d="M2396.28 582.644L2396.28 128.932L2500.45 128.932L2500.45 582.644L2396.28 582.644Z" fillRule="nonzero" />
        <path d="M2548.08 582.644L2698.02 128.932L2862.72 128.932L3017.64 582.644L2912.44 582.644L2786.74 199.475L2818.9 212.527L2739.04 212.527L2772.13 199.475L2650.01 582.644L2548.08 582.644ZM2661.5 469.993L2692.73 385.465L2870.8 385.465L2902.03 469.993L2661.5 469.993Z" fillRule="nonzero" />
      </svg>
      <div className="wizard-progress">{progressDots}</div>
      <span className="wizard-step-label">Step {currentStep} of {TOTAL_STEPS}</span>
    </div>
  );

  // ── Loading / error states ───────────────────────────────────────────────────

  if (loadError) {
    return (
      <div className="wizard-page">
        {header}
        <div className="wizard-body">
          <div className="wizard-content">
            <p style={{ color: 'var(--app-destructive)' }}>{loadError}</p>
          </div>
        </div>
      </div>
    );
  }

  if (!existingIdentity) {
    return (
      <div className="wizard-page">
        {header}
        <div className="wizard-body">
          <div className="wizard-content" style={{ color: 'var(--app-fg-muted)' }}>
            Loading…
          </div>
        </div>
      </div>
    );
  }

  // ── Step 1: Identity ─────────────────────────────────────────────────────────

  const step1 = (
    <div className="wizard-content">
      <div className="wizard-heading">What should your assistant be called?</div>
      <div className="wizard-subheading">
        Give your assistant a name and role. You can change these at any time.
      </div>
      <div className="wizard-field">
        <label htmlFor="w-name">Assistant name *</label>
        <input
          id="w-name"
          type="text"
          value={state.name}
          placeholder="Alex Curia"
          onChange={e => {
            setState(s => ({ ...s, name: e.target.value }));
            if (step1Error) setStep1Error('');
          }}
        />
        {step1Error && <div className="wizard-step1-error">{step1Error}</div>}
      </div>
      <div className="wizard-field">
        <label htmlFor="w-title">Title</label>
        <input
          id="w-title"
          type="text"
          value={state.title}
          placeholder="Executive Assistant to the CEO"
          onChange={e => setState(s => ({ ...s, title: e.target.value }))}
        />
      </div>
      <div className="wizard-field">
        <label htmlFor="w-signature">Email signature <span style={{ fontWeight: 400 }}>(Optional)</span></label>
        <textarea
          id="w-signature"
          value={state.signature}
          placeholder="Best regards, Alex"
          onChange={e => setState(s => ({ ...s, signature: e.target.value }))}
        />
      </div>
      <div className="wizard-nav">
        <span />
        <button type="button" className="btn-wizard-next" onClick={handleContinue}>
          Next →
        </button>
      </div>
    </div>
  );

  // ── Step 2: Tone ─────────────────────────────────────────────────────────────

  const atToneMax = state.toneBaseline.length >= 3;

  const step2 = (
    <div className="wizard-content">
      <div className="wizard-heading">How should your assistant communicate?</div>
      <div className="wizard-subheading">Pick 1–3 words that describe the tone you want.</div>
      <div className="wizard-label">
        Tone <span style={{ fontWeight: 400, textTransform: 'none', letterSpacing: 0 }}>
          (pick up to 3)
        </span>
      </div>
      <div className="tone-pill-grid">
        {TONE_OPTIONS.map(word => {
          const selected = state.toneBaseline.includes(word);
          const disabled = atToneMax && !selected;
          return (
            <button
              key={word}
              type="button"
              className={`tone-pill${selected ? ' selected' : ''}`}
              disabled={disabled}
              onClick={() =>
                setState(s => ({
                  ...s,
                  toneBaseline: toggleToneSelection(s.toneBaseline, word),
                }))
              }
            >
              {word}
            </button>
          );
        })}
      </div>
      <div className="wizard-preview">{tonePreviewText(state.toneBaseline)}</div>
      <div className="wizard-label">Detail level</div>
      <input
        type="range"
        min={0}
        max={100}
        value={state.verbosity}
        style={{ width: '100%', marginBottom: 6 } as CSSProperties}
        onChange={e => setState(s => ({ ...s, verbosity: Number(e.target.value) }))}
      />
      <div className="slider-labels"><span>Brief</span><span>Thorough</span></div>
      <div className="wizard-sample">{verbosityBand(state.verbosity)}</div>
      <div className="wizard-label">Directness</div>
      <input
        type="range"
        min={0}
        max={100}
        value={state.directness}
        style={{ width: '100%', marginBottom: 6 } as CSSProperties}
        onChange={e => setState(s => ({ ...s, directness: Number(e.target.value) }))}
      />
      <div className="slider-labels"><span>Measured</span><span>Direct</span></div>
      <div className="wizard-sample">{directnessBand(state.directness)}</div>
      <div className="wizard-nav">
        <button type="button" className="btn-wizard-back" onClick={handleBack}>
          ← Back
        </button>
        <button type="button" className="btn-wizard-next" onClick={handleContinue}>
          Next →
        </button>
      </div>
    </div>
  );

  // ── Step 3: Posture & preferences ────────────────────────────────────────────

  const POSTURE_OPTIONS: Array<{
    value: WizardState['posture'];
    title: string;
    desc: string;
  }> = [
    { value: 'conservative', title: 'Conservative', desc: 'Verify before acting; flag ambiguity' },
    { value: 'balanced',     title: 'Balanced',     desc: 'Act when confident, flag when uncertain' },
    { value: 'proactive',    title: 'Proactive',    desc: 'Bias toward action; less checking in' },
  ];

  const step3 = (
    <div className="wizard-content">
      <div className="wizard-heading">How should your assistant decide?</div>
      <div className="wizard-subheading">
        Choose a default posture for external actions. You can adjust this later via Autonomy settings.
      </div>
      <div className="wizard-label">
        Decision posture{' '}
        <span style={{ fontWeight: 400, textTransform: 'none', letterSpacing: 0, color: 'var(--app-fg-muted)' }}>
          (for external actions)
        </span>
      </div>
      <div className="posture-grid">
        {POSTURE_OPTIONS.map(opt => (
          <button
            key={opt.value}
            type="button"
            className={`posture-card${state.posture === opt.value ? ' selected' : ''}`}
            onClick={() => setState(s => ({ ...s, posture: opt.value }))}
          >
            <div className="posture-card-title">{opt.title}</div>
            <div className="posture-card-desc">{opt.desc}</div>
          </button>
        ))}
      </div>
      <div className="wizard-label" style={{ marginTop: 4 }}>
        Anything else? <span style={{ fontWeight: 400, textTransform: 'none', letterSpacing: 0 }}>(Optional)</span>
      </div>
      <div className="wizard-field">
        <textarea
          id="w-preferences"
          value={state.preferences}
          style={{ minHeight: 140 }}
          placeholder="E.g., 'Always include agenda items in meeting requests' or 'Flag emails from investors as high priority'"
          onChange={e => setState(s => ({ ...s, preferences: e.target.value }))}
        />
      </div>
      <div className="wizard-nav">
        <button type="button" className="btn-wizard-back" onClick={handleBack}>
          ← Back
        </button>
        <button type="button" className="btn-wizard-next" onClick={handleContinue}>
          Review →
        </button>
      </div>
    </div>
  );

  // ── Step 4: Review ───────────────────────────────────────────────────────────

  const words = state.toneBaseline;
  const tonePhrase =
    words.length === 1
      ? words[0]!
      : words.length === 2
        ? `${words[0]} and ${words[1]}`
        : `${words[0]}, ${words[1]} and ${words[2]}`;

  const reviewRows: Array<{ label: string; value: string }> = [
    {
      label: 'Assistant',
      value: state.name.trim() + (state.title.trim() ? ` — ${state.title.trim()}` : ''),
    },
    { label: 'Tone',       value: `Your tone is ${tonePhrase}.` },
    { label: 'Detail',     value: verbosityReviewDesc(state.verbosity) },
    { label: 'Directness', value: directnessReviewDesc(state.directness) },
    { label: 'Posture',    value: postureReviewDesc(state.posture) },
  ];
  if (state.preferences.trim()) {
    reviewRows.push({ label: 'Preference', value: `"${state.preferences.trim()}"` });
  }

  const step4 = (
    <div className="wizard-content">
      <div className="wizard-heading">Does everything look right?</div>
      <div className="wizard-subheading">Go back to change anything, or save to get started.</div>
      <div className="review-card">
        {reviewRows.map(row => (
          <div key={row.label} className="review-row">
            <div className="review-row-label">{row.label}</div>
            <div className="review-row-value">{row.value}</div>
          </div>
        ))}
      </div>
      {submitError && <div className="wizard-submit-error">{submitError}</div>}
      <div className="wizard-nav">
        <button type="button" className="btn-wizard-back" onClick={handleBack} disabled={submitting}>
          ← Back
        </button>
        <button
          type="button"
          className="btn-wizard-next"
          onClick={() => void handleSubmit()}
          disabled={submitting}
        >
          {submitting ? 'Saving…' : 'Confirm & save'}
        </button>
      </div>
    </div>
  );

  // ── Render ───────────────────────────────────────────────────────────────────

  const steps: Record<number, JSX.Element> = { 1: step1, 2: step2, 3: step3, 4: step4 };

  return (
    <div className="wizard-page">
      {header}
      <div className="wizard-body">
        {steps[currentStep] ?? step1}
      </div>
    </div>
  );
}
