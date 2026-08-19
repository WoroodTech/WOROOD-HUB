import { useState } from 'react';
import { Navigate } from 'react-router-dom';
import { useAuth } from '../lib/auth';
import { Icon, WoroodLogo } from '../components/Icon';

const DEMO_PASSWORD = 'Worood@2026';

/**
 * This is a demonstration build, so the seeded accounts are on the screen.
 *
 * They are listed in the order that makes the permission model legible rather
 * than alphabetically or by seniority: start with the account that sees the
 * least and work up, so clicking down the list widens the portal a step at a
 * time. Each one exists to show a slice the others do not.
 */
const ACCOUNTS = [
  { email: 'omnia.osama@worood.co', who: 'Omnia Osama', role: 'Customer Care',
    sees: 'Orders with customer identity. No dashboard from her role — one was granted to her personally.' },
  { email: 'nadia@worood.co', who: 'Nadia', role: 'Marketing Director',
    sees: 'Marketing dashboards only. No orders at all: a campaign is not a reason to read an address.' },
  { email: 'Yousry@worood.co', who: 'Mohamed Yousry', role: 'Financial Manager',
    sees: 'Finance reconciliation and the daily figures, with orders and customers.' },
  { email: 'heba.fayed@worood.co', who: 'Heba Fayed', role: 'Operations Manager',
    sees: 'Room administration, anyone’s reservation, order flow and Data & Sync — but not the composer.' },
  { email: 'Kandil@worood.co', who: 'Mohamed Kandil', role: 'Chief Executive Officer',
    sees: 'All five dashboards, orders and customers. No administration console.' },
  { email: 'Admin@worood.co', who: 'Khalid Hesham', role: 'System Administrator',
    sees: 'Everything, including People and Roles.' },
];

export function Login() {
  const { signIn, status } = useAuth();
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState(DEMO_PASSWORD);
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

  const pick = (address: string) => { setEmail(address); setPassword(DEMO_PASSWORD); setError(null); };

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
            <input
              className="input" type="password" name="password" autoComplete="current-password" required
              value={password} onChange={(e) => setPassword(e.target.value)}
            />
          </label>

          {error ? <p className="login__error" role="alert"><Icon name="warning" size={16} /> {error}</p> : null}

          <button className="btn btn--primary btn--block" type="submit" disabled={busy || !email}>
            {busy ? 'Signing in…' : 'Sign in'}
          </button>
        </form>
      </div>

      <div className="login__demo">
        <h1 className="login__demoTitle">Demonstration accounts</h1>
        <p className="login__demoHint">
          Every account below uses the password <code>{DEMO_PASSWORD}</code>. Pick one to fill the form —
          the portal is built entirely from what the API grants each of them, so the screens genuinely differ.
        </p>
        <ul className="accounts">
          {ACCOUNTS.map((a) => (
            <li key={a.email}>
              <button type="button" className="account" onClick={() => pick(a.email)}>
                <span className="account__top">
                  <strong>{a.who}</strong>
                  <span className="account__role">{a.role}</span>
                </span>
                <span className="account__email">{a.email}</span>
                <span className="account__sees">{a.sees}</span>
              </button>
            </li>
          ))}
        </ul>
      </div>
    </div>
  );
}
