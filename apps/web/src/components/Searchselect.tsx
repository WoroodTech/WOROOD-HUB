/**
 * A select you can type into.
 *
 * The lists it replaces are long — a hundred and eighty expense accounts,
 * forty-odd bank accounts, every supplier in the books. A native `<select>`
 * over that many options means scrolling past everything to reach one entry,
 * and the one keystroke it does support jumps to names starting with that
 * letter, which is no help when somebody remembers a word in the middle.
 *
 * Deliberately not a free-text field: the value is always one of the options
 * or nothing. Somebody typing an account that does not exist should end up
 * with an empty box, not with text the server has to reject.
 */
import { useEffect, useId, useMemo, useRef, useState } from 'react';
import { Icon } from './Icon';

export interface SearchSelectOption {
  value: string;
  label: string;
  /** Shown under the label — an account code, a supplier's phone. */
  hint?: string;
}

export function SearchSelect({
  value, onChange, options, placeholder = 'Choose…',
  disabled = false, disabledReason, id,
}: {
  value: string;
  onChange: (value: string) => void;
  options: SearchSelectOption[];
  placeholder?: string;
  disabled?: boolean;
  /** Why it is disabled, if there is a reason worth saying. */
  disabledReason?: string;
  id?: string;
}) {
  const fallbackId = useId();
  const inputId = id ?? fallbackId;
  const [open, setOpen] = useState(false);
  const [typed, setTyped] = useState('');
  const [active, setActive] = useState(0);
  /* Which way the list opens. These fields sit low in a long form, and a
     list that always drops downward ends up off the bottom of the window —
     so the options are there but nobody can reach them without scrolling the
     field itself out of view. */
  const [up, setUp] = useState(true);
  const box = useRef<HTMLDivElement>(null);
  const list = useRef<HTMLUListElement>(null);

  const chosen = options.find((o) => o.value === value) ?? null;

  const matches = useMemo(() => {
    const q = typed.trim().toLowerCase();
    if (!q) return options;
    /* Every word has to appear somewhere, in any order — "bank cib" finds
       "CIB — Main current account". Matching the whole phrase in sequence
       would miss it, and that is how people actually remember a name. */
    const words = q.split(/\s+/);
    return options.filter((o) => {
      const hay = `${o.label} ${o.hint ?? ''}`.toLowerCase();
      return words.every((w) => hay.includes(w));
    });
  }, [options, typed]);

  /*
   * Decide the direction as it opens, and again if the window changes.
   *
   * Measured rather than assumed: a field halfway down a short form has room
   * below it, and flipping that one upward would be just as wrong.
   */
  useEffect(() => {
    if (!open) return;
    const place = () => {
      const r = box.current?.getBoundingClientRect();
      if (!r) return;
      const below = window.innerHeight - r.bottom;
      /*
       * Upward wherever it fits.
       *
       * These sit near the bottom of long forms, and opening downward there
       * puts the options under the fold — the list is open and nobody can
       * see it without scrolling the field itself out of view.
       *
       * Still measured: a field near the top of the window has nowhere to go
       * upward, and forcing it there would be the same fault mirrored.
       */
      const needed = 268;
      const roomAbove = r.top >= needed;
      const roomBelow = below >= needed;
      setUp(roomAbove || (!roomBelow && r.top > below));
    };
    place();
    window.addEventListener('resize', place);
    window.addEventListener('scroll', place, true);
    return () => {
      window.removeEventListener('resize', place);
      window.removeEventListener('scroll', place, true);
    };
  }, [open]);

  /* Close when the click lands anywhere else. */
  useEffect(() => {
    if (!open) return;
    const away = (e: MouseEvent) => {
      if (box.current && !box.current.contains(e.target as Node)) setOpen(false);
    };
    document.addEventListener('mousedown', away);
    return () => document.removeEventListener('mousedown', away);
  }, [open]);

  /* Keep the highlighted row on screen while arrowing through a long list. */
  useEffect(() => {
    if (!open || !list.current) return;
    const el = list.current.children[active] as HTMLElement | undefined;
    el?.scrollIntoView({ block: 'nearest' });
  }, [active, open]);

  const pick = (option: SearchSelectOption) => {
    onChange(option.value);
    setTyped('');
    setOpen(false);
  };

  const keys = (e: React.KeyboardEvent) => {
    if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
      e.preventDefault();
      if (!open) { setOpen(true); return; }
      setActive((i) => {
        const next = e.key === 'ArrowDown' ? i + 1 : i - 1;
        return Math.max(0, Math.min(matches.length - 1, next));
      });
    } else if (e.key === 'Enter') {
      if (open && matches[active]) { e.preventDefault(); pick(matches[active]); }
    } else if (e.key === 'Escape') {
      /* Back to what it was, rather than clearing: Escape in a form should
         not quietly lose a choice somebody already made. */
      setTyped('');
      setOpen(false);
    }
  };

  if (disabled) {
    return (
      <div className="ssel ssel--off" title={disabledReason}>
        <span className="ssel__off">{chosen?.label ?? disabledReason ?? '—'}</span>
      </div>
    );
  }

  return (
    <div className="ssel" ref={box}>
      <div className="ssel__box">
        <input
          id={inputId}
          className="input ssel__input"
          type="text"
          role="combobox"
          aria-expanded={open}
          aria-autocomplete="list"
          autoComplete="off"
          /* The chosen label when closed, what they are typing when open —
             so the field always reads as the current answer. */
          value={open ? typed : (chosen?.label ?? '')}
          placeholder={chosen ? chosen.label : placeholder}
          onFocus={() => { setOpen(true); setActive(0); }}
          onChange={(e) => { setTyped(e.target.value); setOpen(true); setActive(0); }}
          onKeyDown={keys}
        />
        {chosen && !open ? (
          <button type="button" className="ssel__clear" aria-label="Clear"
                  onClick={() => onChange('')}>
            <Icon name="minus" size={14} />
          </button>
        ) : (
          <span className="ssel__caret" aria-hidden="true">
            <Icon name="down" size={15} />
          </span>
        )}
      </div>

      {open ? (
        <ul className={`ssel__list${up ? ' ssel__list--up' : ''}`}
            ref={list} role="listbox">
          {matches.length === 0 ? (
            <li className="ssel__empty">Nothing matches “{typed.trim()}”</li>
          ) : matches.map((o, i) => (
            <li key={o.value} role="option" aria-selected={o.value === value}
                className={`ssel__opt${i === active ? ' is-active' : ''}`
                  + (o.value === value ? ' is-chosen' : '')}
                /* mousedown, not click: the input blurs first on click and
                   the list is gone before the handler runs. */
                onMouseDown={(e) => { e.preventDefault(); pick(o); }}
                onMouseEnter={() => setActive(i)}>
              <span className="ssel__label">{o.label}</span>
              {o.hint ? <span className="ssel__hint">{o.hint}</span> : null}
            </li>
          ))}
        </ul>
      ) : null}
    </div>
  );
}