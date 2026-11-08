/**
 * Asking for an account.
 *
 * Open to anyone who can reach the portal. Approval is the gate, not this
 * form, so nothing here tries to work out whether somebody belongs — it
 * collects what a reviewer needs and says plainly that a person will decide.
 *
 * The reply is the same whatever happened on the server: an address that
 * already has an account and a brand new one get the same words. That is
 * deliberate, and it is why this screen never says "that e-mail is taken".
 */
import { useState } from 'react';
import { Link } from 'react-router-dom';
import { useQuery } from '@tanstack/react-query';
import type { SignupDepartment, SignupReply } from '../contract';
import { api } from '../lib/api';
import { Icon } from '../components/Icon';
import { WoroodLogo } from '../components/WoroodLogo';

/**
 * What makes a password acceptable here.
 *
 * Two rules, not six. A long list of requirements pushes people towards the
 * one password they already use everywhere, which is worse than a short one
 * chosen for this. The strength bar past that point is encouragement, not a
 * gate — nothing below is refused for being merely adequate.
 */
function passwordChecks(password: string) {
  return [
    { label: 'At least 8 characters', met: password.length >= 8 },
    {
      label: 'A number or a symbol',
      met: /[a-zA-Z]/.test(password)
        && /[0-9!@#$%^&*(),.?":{}|<>_\-]/.test(password),
    },
  ];
}

/** How much more than the minimum this is, for the bar. */
function strengthOf(password: string): { score: 0 | 1 | 2 | 3; word: string } {
  if (password.length < 8) return { score: 0, word: 'Too short' };
  let points = 0;
  if (password.length >= 12) points++;
  if (password.length >= 16) points++;
  if (/[0-9]/.test(password) && /[^a-zA-Z0-9]/.test(password)) points++;
  /* Length does most of the work, which is why it counts twice and the
     character classes count once. */
  const score = Math.min(3, points + 1) as 1 | 2 | 3;
  return { score, word: ['', 'Fine', 'Good', 'Strong'][score] };
}

function StrengthBar({ password }: { password: string }) {
  const { score, word } = strengthOf(password);
  return (
    <div className="pwbar" aria-hidden="true">
      <div className="pwbar__track">
        {[1, 2, 3].map((i) => (
          <span key={i}
                className={`pwbar__seg${i <= score ? ` is-on is-${score}` : ''}`} />
        ))}
      </div>
      <span className={`pwbar__word is-${score}`}>{word}</span>
    </div>
  );
}

function PasswordMeter({ checks }: { checks: { label: string; met: boolean }[] }) {
  const done = checks.filter((c) => c.met).length;
  return (
    <div className="pwmeter">
      <ul className="pwmeter__list">
        {checks.map((c) => (
          <li key={c.label} className={`pwmeter__rule${c.met ? ' is-met' : ''}`}>
            <span className="pwmeter__tick" aria-hidden="true">
              <Icon name={c.met ? 'check' : 'dot'} size={13} />
            </span>
            {c.label}
          </li>
        ))}
      </ul>
      {/* Announced once, when everything is satisfied, rather than on every
          keystroke — a screen reader reading a half-typed password back is
          noise at best. */}
      <span className="visually-hidden" role="status">
        {done === checks.length ? 'Password meets the requirements' : ''}
      </span>
    </div>
  );
}

export function Signup() {
  const [email, setEmail] = useState('');
  const [fullName, setFullName] = useState('');
  const [password, setPassword] = useState('');
  const [departmentId, setDepartmentId] = useState('');
  const [showPassword, setShowPassword] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [sent, setSent] = useState<string | null>(null);

  const departments = useQuery({
    queryKey: ['signup-departments'],
    queryFn: () => api<SignupDepartment[]>('/admin/signup/departments'),
    /* The list changes about once a year. */
    staleTime: 60 * 60 * 1000,
  });

  /* The same rules the server applies, checked here so somebody learns them
     while typing rather than after a round trip. The server still decides. */
  const checks = passwordChecks(password);
  const valid = checks.every((c) => c.met);
  const ready = email.trim() && fullName.trim().length >= 2
    && valid && departmentId && !busy;

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!ready) return;
    setBusy(true); setError(null);
    try {
      const reply = await api<SignupReply>('/admin/signup', {
        method: 'POST',
        body: {
          email: email.trim(), password, fullName: fullName.trim(), departmentId,
        },
      });
      setSent(reply.message);
    } catch (err: any) {
      setError(err?.message ?? 'The request could not be sent. Try again.');
    } finally {
      setBusy(false);
    }
  };

  /*
   * What happened, on the page.
   *
   * Not a browser alert: one of those is a grey box with an OK button that
   * covers the screen, cannot be styled, and is gone the moment it is
   * dismissed — so somebody who closes it too fast has nothing left to read.
   */
  if (sent) {
    return (
      <div className="login">
        <div className="login__panel">
          <div className="login__brand">
            <WoroodLogo width={190} className="login__logo" />
          </div>

          <div className="signupdone" role="status">
            <span className="signupdone__mark" aria-hidden="true">
              <Icon name="check" size={22} />
            </span>
            <h1 className="signupdone__title">Request sent</h1>
            <p className="signupdone__body">{sent}</p>
            <p className="signupdone__body signupdone__body--quiet">
              We will e-mail <strong>{email.trim()}</strong> when it has been
              looked at, whether or not it is approved.
            </p>
            <Link className="btn btn--primary btn--block" to="/login">
              Back to sign in
            </Link>
          </div>
        </div>
      </div>
    );
  }

  return (
    <div className="login">
      <div className="login__panel">
        <div className="login__brand">
          <WoroodLogo width={190} className="login__logo" />
          <p className="login__tag">
            <span className="login__word">Hub</span>
            Ask for an account. Somebody will approve it before you can sign in.
          </p>
        </div>

        <form className="login__form" onSubmit={submit}>
          <label className="field">
            <span className="field__label">Your name</span>
            <input className="input" type="text" name="name" autoComplete="name"
                   required autoFocus value={fullName}
                   onChange={(e) => setFullName(e.target.value)}
                   placeholder="as your colleagues know you" />
          </label>

          <label className="field">
            <span className="field__label">Work e-mail</span>
            <input className="input" type="email" name="email"
                   autoComplete="username" required value={email}
                   onChange={(e) => setEmail(e.target.value)}
                   placeholder="you@worood.co" />
          </label>

          <label className="field">
            <span className="field__label">Department</span>
            <select className="input" required value={departmentId}
                    disabled={departments.isLoading}
                    onChange={(e) => setDepartmentId(e.target.value)}>
              <option value="" disabled>
                {departments.isLoading ? 'Loading…' : 'Choose your department'}
              </option>
              {(departments.data ?? []).map((d) => (
                <option key={d.id} value={d.id}>{d.name}</option>
              ))}
            </select>
          </label>

          <label className="field">
            <span className="field__label">Password</span>
            <div className="password-field">
              <input className="input"
                     type={showPassword ? 'text' : 'password'}
                     name="password" autoComplete="new-password" required
                     value={password}
                     onChange={(e) => setPassword(e.target.value)}
                     placeholder="at least 8 characters" />
              <button type="button" className="password-field__toggle"
                      onClick={() => setShowPassword((v) => !v)}
                      aria-label={showPassword ? 'Hide password' : 'Show password'}>
                <Icon name="eye" size={18} />
              </button>
            </div>

            {/* The bar sits above the rules: it moves on every keystroke, and
                the rules below it only change twice. */}
            {valid ? <StrengthBar password={password} /> : null}
            {/* The rules as a list that fills in while they type, rather
                than one line of text that changes. Somebody can see what is
                left to do instead of discovering it one message at a time. */}
            {password ? <PasswordMeter checks={checks} /> : null}
          </label>

          {error ? (
            <p className="login__error" role="alert">
              <Icon name="warning" size={16} /> {error}
            </p>
          ) : null}

          <button className="btn btn--primary btn--block" type="submit"
                  disabled={!ready}>
            {busy ? 'Sending…' : 'Ask for an account'}
          </button>

          <p className="login__alt">
            Already have one? <Link to="/login">Sign in</Link>
          </p>
        </form>
      </div>
    </div>
  );
}