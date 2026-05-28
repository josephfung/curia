import { useState, type FormEvent } from 'react';
import { useNavigate } from '@tanstack/react-router';
import { CuriaWordmark } from '../components/Icons';
import { apiFetch } from '../api';

export default function LoginPage() {
  const navigate = useNavigate();
  const [secret, setSecret] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);

  async function handleSubmit(e: FormEvent) {
    e.preventDefault();
    setLoading(true);
    setError(null);
    try {
      const res = await apiFetch('/auth', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ secret }),
      });
      if (!res.ok) {
        const data = (await res.json()) as unknown as { error?: string };
        setError(data.error ?? 'Authentication failed.');
        return;
      }
      await navigate({ to: '/' });
    } catch {
      setError('Network error. Is the server running?');
    } finally {
      setLoading(false);
    }
  }

  return (
    <div className="login-root">
      <div className="login-card">
        <div className="login-wordmark" aria-label="Curia">
          <CuriaWordmark />
        </div>
        <form onSubmit={handleSubmit} className="login-form">
          <input
            type="password"
            aria-label="Access key"
            placeholder="Access key"
            value={secret}
            onChange={(e) => setSecret(e.target.value)}
            autoComplete="current-password"
            autoFocus
            required
          />
          {error && <p className="login-error">{error}</p>}
          <button type="submit" className="btn btn-primary" disabled={loading}>
            {loading ? 'Signing in…' : 'Sign in'}
          </button>
        </form>
      </div>
    </div>
  );
}
