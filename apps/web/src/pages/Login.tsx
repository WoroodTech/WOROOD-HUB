import { useState } from 'react';
import { Navigate } from 'react-router-dom';
import { useAuth } from '../lib/auth';
import { Icon, WoroodLogo } from '../components/Icon';



export function Login() {
  const { signIn, status } = useAuth();
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [showPassword, setShowPassword] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  /**
   * Always home, never back to where the last session was interrupted.
   *
   * `RequireAuth` records the path it bounced you from, which is right for an
   * expired session resumed by the same person. It is wrong here: the person
   * signing in is often not the person who was signed in, and returning them to
   * a sales dashboard the previous employee had open is at best confusing and at
   * worst a screen they hold no permission for. Home is the one route every
   * account has, and it is composed from what *they* are granted.
   */
  if (status === 'authenticated') {
    return <Navigate to="/" replace />;
  }

  const submit = async (event: React.FormEvent) => {
    event.preventDefault();
    setBusy(true); setError(null);
    try {
      await signIn(email.trim(), password);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Sign-in failed');
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="login">
      <div className="login__panel">
        <div className="login__brand">
          <WoroodLogo width={190} className="login__logo" />
          <p className="login__tag">
            <span className="login__word">Hub</span>
            The internal portal for scarves, modal and everything after the sale.
          </p>
        </div>

        <form className="login__form" onSubmit={submit}>
          <label className="field">
            <span className="field__label">Work e-mail</span>
            <input
              className="input" type="email" name="email" autoComplete="username" required
              value={email} onChange={(e) => setEmail(e.target.value)}
              placeholder="you@worood.co" autoFocus
            />
          </label>

          <label className="field">
            <span className="field__label">Password</span>
            <div className="password-field">
              <input
              className="input"
              type={showPassword ? 'text' : 'password'}
              name="password"
              autoComplete="current-password"
              required
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              placeholder="your password"
              />
              <button
                type="button"
                className="password-field__toggle"
                onClick={() => setShowPassword((prev) => !prev)}
                aria-label={showPassword ? 'Hide password' : 'Show password'}
              >
                <Icon
                  name={showPassword ? 'eye-off' : 'eye'}
                  size={18}
                />
              </button>
            </div>
          </label>

          {error ? <p className="login__error" role="alert"><Icon name="warning" size={16} /> {error}</p> : null}

          <button className="btn btn--primary btn--block" type="submit" disabled={busy || !email || !password}>
            {busy ? 'Signing in…' : !email ? 'Enter email' : !password ? 'Enter password' : 'Sign in'}
          </button>
        </form>
      </div>
    </div>
  );
}
