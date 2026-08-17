import { useState } from 'react';
import { useAuth } from '../lib/auth';

export default function LoginPage() {
  const { signIn } = useAuth();
  const [email, setEmail] = useState('omar.khaled@worood.co');
  const [password, setPassword] = useState('Worood@2026');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function submit(event: React.FormEvent) {
    event.preventDefault();
    setBusy(true);
    setError(null);
    try {
      await signIn(email, password);
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="login-wrap">
      <div className="login-art">
        <div className="brand" style={{ padding: 0 }}>
          <div className="brand-mark" style={{ width: 42, height: 42, fontSize: 18 }}>
            W
          </div>
          <div>
            <div className="brand-name" style={{ fontSize: 17 }}>WOROOD</div>
            <div className="brand-sub">Employee Hub</div>
          </div>
        </div>

        <h1 style={{ color: '#fff', fontSize: 32, lineHeight: 1.25, marginTop: 24 }}>
          One place for everything
          <br />
          your workday needs.
        </h1>
        <p style={{ color: '#e3c9d3', maxWidth: 420 }}>
          Book meeting rooms, see what's free right now, and manage your reservations — all from a
          single intranet portal built to grow module by module.
        </p>

        <div style={{ marginTop: 20, display: 'flex', gap: 26, color: '#e3c9d3', fontSize: 13 }}>
          <div>
            <div style={{ fontSize: 22, fontWeight: 700, color: '#fff' }}>8</div>
            meeting rooms
          </div>
          <div>
            <div style={{ fontSize: 22, fontWeight: 700, color: '#fff' }}>3</div>
            office sites
          </div>
          <div>
            <div style={{ fontSize: 22, fontWeight: 700, color: '#fff' }}>0</div>
            double bookings
          </div>
        </div>
      </div>

      <div className="login-form-side">
        <form className="login-card stack" onSubmit={submit} style={{ gap: 16 }}>
          <div>
            <h1>Sign in</h1>
            <p className="page-sub">Use your Worood work e-mail address.</p>
          </div>

          {error && <div className="alert alert-bad">{error}</div>}

          <label className="field">
            Work e-mail
            <input
              type="email"
              value={email}
              onChange={(e) => setEmail(e.target.value)}
              autoComplete="username"
              required
            />
          </label>

          <label className="field">
            Password
            <input
              type="password"
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              autoComplete="current-password"
              required
            />
          </label>

          <button className="btn btn-primary" type="submit" disabled={busy}>
            {busy ? <span className="spinner" /> : null}
            {busy ? 'Signing in…' : 'Sign in'}
          </button>

          <div className="alert alert-info" style={{ fontSize: 12.5 }}>
            <strong>Demo accounts</strong>
            <div style={{ marginTop: 4 }}>
              omar.khaled@worood.co — employee
              <br />
              facilities@worood.co — facilities coordinator
              <br />
              admin@worood.co — administrator
              <br />
              Password for all: <code>Worood@2026</code>
            </div>
          </div>
        </form>
      </div>
    </div>
  );
}
