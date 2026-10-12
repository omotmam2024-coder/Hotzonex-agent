import { useState, type FormEvent } from 'react';
import { Navigate, useLocation } from 'react-router';
import { useAuth } from '../auth/AuthContext';
import { Field } from '../components/Field';
import { Loading } from '../components/States';

export function LoginPage() {
  const { client, session, loading } = useAuth();
  const location = useLocation();
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  if (loading) return <Loading label="Checking your session…" />;
  if (session) {
    const from = (location.state as { from?: string } | null)?.from;
    return <Navigate to={from && from !== '/login' ? from : '/products'} replace />;
  }

  const validEmail = /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email.trim());

  async function onSubmit(e: FormEvent) {
    e.preventDefault();
    setNotice(null);
    if (!validEmail) return setError('Enter a valid email address.');
    if (!password) return setError('Enter your password, or use a sign-in link.');
    setBusy(true);
    setError(null);
    const { error } = await client.signInWithPassword(email.trim(), password);
    setBusy(false);
    if (error) setError(error);
  }

  async function onMagicLink() {
    setNotice(null);
    if (!validEmail) return setError('Enter a valid email address.');
    setBusy(true);
    setError(null);
    const { error } = await client.sendMagicLink(email.trim(), `${window.location.origin}/products`);
    setBusy(false);
    if (error) setError(error);
    else setNotice('Check your email for a sign-in link.');
  }

  return (
    <main className="page page--narrow">
      <h1>Sign in</h1>
      <p className="muted">Business owner dashboard</p>
      <form className="card form" onSubmit={onSubmit} noValidate>
        <Field label="Email">
          <input type="email" autoComplete="email" value={email} onChange={(e) => setEmail(e.target.value)} required />
        </Field>
        <Field label="Password">
          <input type="password" autoComplete="current-password" value={password} onChange={(e) => setPassword(e.target.value)} />
        </Field>
        {error && (
          <p className="error" role="alert">
            {error}
          </p>
        )}
        {notice && <p role="status">{notice}</p>}
        <div className="form__actions">
          <button type="submit" className="btn btn--primary" disabled={busy}>
            {busy ? 'Signing in…' : 'Sign in'}
          </button>
          <button type="button" className="btn" onClick={() => void onMagicLink()} disabled={busy}>
            Email me a sign-in link
          </button>
        </div>
      </form>
      <p className="muted small">Accounts are created by your service provider. There is no public sign-up.</p>
    </main>
  );
}
