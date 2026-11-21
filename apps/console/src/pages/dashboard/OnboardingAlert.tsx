// The dashboard's onboarding alert (#2360): after "Not right now" on the last Setup step, Start
// onboarding stays here until it has run. Shown only when GET /api/onboarding/status says so
// (Setup finished on the Setup page, onboarding not started); a failed read shows nothing.
import { useCallback, useState, type JSX } from 'react';
import { OnboardingStarted, WorkingPrincipalDialog } from '../setup/FinishSteps.js';
import { principalLabel } from '../setup/setup-steps.js';
import { fetchOnboardingStatus, useStartOnboarding } from '../setup/start-onboarding.js';
import { useAsyncData } from './useAsyncData.js';

export function OnboardingAlert(): JSX.Element | null {
  const { data, retry } = useAsyncData(fetchOnboardingStatus);
  const [dismissed, setDismissed] = useState(false);
  const refresh = useCallback(async () => { retry(); }, [retry]);
  const principal = principalLabel(data?.principalName);
  const { flow, start, cancel } = useStartOnboarding({ principal, onAlreadyStarted: refresh });

  if (dismissed) return null;
  if (flow.kind === 'started') {
    return (
      <div className="dash-alert ok">
        <OnboardingStarted
          flow={flow}
          route={data?.route ?? null}
          setupFor={data?.setupFor ?? null}
          principal={principal}
          continueLabel="Done"
          onContinue={() => setDismissed(true)}
        />
      </div>
    );
  }
  // A start in progress or its outcome stays on screen even once the status no longer asks.
  if (!data?.showDashboardAlert && flow.kind === 'idle') return null;
  if (flow.kind === 'already_started') return null;

  const self = data?.setupFor === 'self';
  return (
    <div className="dash-alert" role="region" aria-label="Onboarding">
      <div className="dash-alert-title">Onboarding hasn’t started.</div>
      <div className="dash-alert-body">Start when {self ? 'you’re' : `${principal} is`} ready.</div>
      {flow.kind === 'failed' && <div className="dash-alert-body" role="alert">{flow.message}</div>}
      <button
        type="button"
        className="btn btn-primary btn-sm"
        disabled={flow.kind === 'working'}
        onClick={() => void start(false)}
      >
        {flow.kind === 'working' ? 'Starting…' : 'Start onboarding'}
      </button>
      {flow.kind === 'confirm' && (
        <WorkingPrincipalDialog
          signals={flow.signals}
          principal={principal}
          onConfirm={() => void start(true)}
          onCancel={cancel}
        />
      )}
    </div>
  );
}
