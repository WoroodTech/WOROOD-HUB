import { useState } from 'react';
import { Navigate } from 'react-router-dom';
import { useAuth } from '../lib/auth';
import { Icon, WoroodMark } from '../components/Icon';

const DEMO_PASSWORD = 'Worood@2026';

/** This is a demonstration build, so the seeded accounts are on the screen --
 *  each one exists to show a different slice of the permission model. */
const ACCOUNTS = [
  { email: 'omar.khaled@worood.co', who: 'Omar Khaled', role: 'Employee', sees: 'Meeting rooms only — no sales access at all' },
  { email: 'hala.mansour@worood.co', who: 'Hala Mansour', role: 'Sales viewer', sees: 'One dashboard, no orders' },
  { email: 'yara.saleh@worood.co', who: 'Yara Saleh', role: 'Sales manager', sees: 'Four dashboards, orders with customer data' },
  { email: 'karim.fouad@worood.co', who: 'Karim Fouad', role: 'Sales admin', sees: 'All five dashboards, plus the composer' },
  { email: 'nour.hassan@worood.co', who: 'Nour Hassan', role: 'Ops engineer', sees: 'Data & Sync only' },
  { email: 'admin@worood.co', who: 'Sherif Wagdy', role: 'Administrator', sees: 'Everything' },
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
          <span className="login__mark"><WoroodMark size={34} /></span>
          <div>
            <p className="login__word">WOROOD <span>Hub</span></p>
            <p className="login__tag">The internal portal for scarves, modal and everything after the sale.</p>
          </div>
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
