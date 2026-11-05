// CardFields.tsx — the credit-card form fields, shared by the capture page (full, renewal) and
// the Secrets Edit drawer (edit-public) (#1358). Controlled; validation lives in card-form-utils.
// The number and CVV are held only in the parent's React state — never written to web storage.
import {
  detectBrandForDisplay,
  type CardFormMode,
  type CardFormState,
} from '../pages/card-form-utils';

const MONTHS = [
  'January', 'February', 'March', 'April', 'May', 'June',
  'July', 'August', 'September', 'October', 'November', 'December',
];

export interface CardFieldsProps {
  mode: CardFormMode;
  state: CardFormState;
  onChange: (patch: Partial<CardFormState>) => void;
  errors: Partial<Record<keyof CardFormState, string>>;
  /** Overrides the brand detected from the number (a renewal knows the brand already). */
  brandHint?: string;
}

function FieldError({ id, message }: { id: string; message?: string }) {
  return message ? <p id={id} className="login-error" role="alert">{message}</p> : null;
}

export function CardFields({ mode, state, onChange, errors, brandHint }: CardFieldsProps) {
  const thisYear = new Date().getUTCFullYear();
  const years = Array.from({ length: 16 }, (_, i) => String(thisYear + i));
  const brand = brandHint ?? detectBrandForDisplay(state.number);

  return (
    <>
      {mode === 'edit-public' && (
        <div className="form-field">
          <label htmlFor="card-label">Label</label>
          <input id="card-label" type="text" autoComplete="off" maxLength={100} value={state.label}
            onChange={e => onChange({ label: e.target.value })} />
          <FieldError id="card-label-err" message={errors.label} />
        </div>
      )}
      {mode === 'full' && (
        <div className="form-field">
          <label htmlFor="card-number">Card number</label>
          <input id="card-number" type="text" inputMode="numeric" autoComplete="cc-number" maxLength={23}
            value={state.number} onChange={e => onChange({ number: e.target.value })} />
          {brand && <p className="secrets-field-label">{brand}</p>}
          <FieldError id="card-number-err" message={errors.number} />
        </div>
      )}
      <div className="form-field">
        <label htmlFor="card-exp-month">Expiry month</label>
        <select id="card-exp-month" autoComplete="cc-exp-month" value={state.expiryMonth}
          onChange={e => onChange({ expiryMonth: e.target.value })}>
          <option value="">Month</option>
          {MONTHS.map((name, i) => {
            const mm = String(i + 1).padStart(2, '0');
            return <option key={mm} value={mm}>{`${mm} – ${name}`}</option>;
          })}
        </select>
        <FieldError id="card-exp-month-err" message={errors.expiryMonth} />
      </div>
      <div className="form-field">
        <label htmlFor="card-exp-year">Expiry year</label>
        <select id="card-exp-year" autoComplete="cc-exp-year" value={state.expiryYear}
          onChange={e => onChange({ expiryYear: e.target.value })}>
          <option value="">Year</option>
          {years.map(y => <option key={y} value={y}>{y}</option>)}
        </select>
        <FieldError id="card-exp-year-err" message={errors.expiryYear} />
      </div>
      {(mode === 'full' || mode === 'renewal') && (
        <div className="form-field">
          <label htmlFor="card-cvv">Security code (CVV)</label>
          <input id="card-cvv" type="password" inputMode="numeric" autoComplete="cc-csc" maxLength={4}
            value={state.cvv} onChange={e => onChange({ cvv: e.target.value })} />
          <FieldError id="card-cvv-err" message={errors.cvv} />
        </div>
      )}
      {(mode === 'full' || mode === 'edit-public') && (
        <>
          <div className="form-field">
            <label htmlFor="card-name">Name on card</label>
            <input id="card-name" type="text" autoComplete="cc-name" maxLength={100}
              value={state.cardholderName} onChange={e => onChange({ cardholderName: e.target.value })} />
            <FieldError id="card-name-err" message={errors.cardholderName} />
          </div>
          <div className="form-field">
            <label htmlFor="card-zip">Billing postal code (optional)</label>
            <input id="card-zip" type="text" autoComplete="postal-code" maxLength={12}
              value={state.billingZip} onChange={e => onChange({ billingZip: e.target.value })} />
            <FieldError id="card-zip-err" message={errors.billingZip} />
          </div>
        </>
      )}
    </>
  );
}
