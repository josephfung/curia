// Settings → Behaviour → Capabilities (#2358 section 4): the same switches as the Setup page's
// last optional extra, with Email triage switchable. The start of a plain-language view of
// what Curia can do; the detailed tools, agents and MCP lists stay where they are.
import { useEffect, useState, type JSX } from 'react';
import { SettingsLayout } from '../SettingsPage';
import { fetchPrincipal } from '../setup/setup-api.js';
import { principalLabel } from '../setup/setup-steps.js';
import { CapabilitiesSection } from './CapabilitiesSection.js';

export function CapabilitiesPage(): JSX.Element {
  const [principal, setPrincipal] = useState('your principal');
  useEffect(() => {
    let cancelled = false;
    fetchPrincipal()
      .then((p) => { if (!cancelled) setPrincipal(principalLabel(p.displayName)); })
      .catch((err: unknown) => {
        // Only the wording depends on it: "your principal" reads fine.
        console.error('[CapabilitiesPage] could not read the principal’s name:', err);
      });
    return () => { cancelled = true; };
  }, []);
  return (
    <SettingsLayout activeSection="capabilities">
      <div className="settings-page-header">
        <h2 className="settings-page-title">Capabilities</h2>
        <p className="settings-page-sub">
          What Curia can do. Each switch turns a whole capability on or off, with the parts it needs.
          Changes apply after a restart.
        </p>
      </div>
      <CapabilitiesSection principal={principal} place="settings" />
    </SettingsLayout>
  );
}

export default CapabilitiesPage;
