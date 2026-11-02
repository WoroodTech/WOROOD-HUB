/**
 * Saying something about a notice without writing a comment.
 *
 * Comments are the wrong size for most of what people want to say. Somebody
 * who has read the holiday notice has nothing to add to it; somebody pleased
 * about an award wants to say so without being the one person who left a
 * message. Both currently say nothing, and the board looks unread.
 *
 * The chosen reactions sit on the bar; the rest are behind one button. A
 * notice then shows how it landed at a glance rather than carrying nine
 * mostly-empty counters, and the full set is still one click away.
 *
 * Pressing the one you already chose takes it back, so the same control both
 * sets and clears. Nobody has to find an undo.
 *
 * Stored by name, never by glyph: the picture can change without the stored
 * data quietly coming to mean something else.
 */
import { useEffect, useRef, useState } from 'react';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { api } from '../lib/api';
import { Icon } from './Icon';
import type { AnnouncementReactions, ReactionKind } from '../contract';

const CHOICES: { kind: ReactionKind; glyph: string; label: string }[] = [
  { kind: 'seen', glyph: '👀', label: 'Seen it' },
  { kind: 'like', glyph: '👍', label: 'Good' },
  { kind: 'love', glyph: '❤️', label: 'Love this' },
  { kind: 'celebrate', glyph: '🎉', label: 'Congratulations' },
  { kind: 'clap', glyph: '👏', label: 'Well done' },
  { kind: 'thanks', glyph: '🙏', label: 'Thank you' },
  { kind: 'funny', glyph: '😄', label: 'Made me laugh' },
  { kind: 'sad', glyph: '😢', label: 'Sorry to hear it' },
  { kind: 'curious', glyph: '🤔', label: 'Thinking about it' },
];

export function NoticeReactions({ announcementId, reactions }: {
  announcementId: string;
  reactions: AnnouncementReactions;
}) {
  const qc = useQueryClient();
  const [picking, setPicking] = useState(false);
  const box = useRef<HTMLDivElement>(null);

  const react = useMutation({
    mutationFn: (kind: ReactionKind) =>
      api<AnnouncementReactions>(`/news/${announcementId}/reactions`, {
        method: 'POST', body: { kind },
      }),
    onSuccess: () => { void qc.invalidateQueries({ queryKey: ['news'] }); },
  });

  /* Closes on a click elsewhere and on Escape -- the two things anybody tries
     first when a popover is in the way. */
  useEffect(() => {
    if (!picking) return;
    const away = (e: MouseEvent) => {
      if (!box.current?.contains(e.target as Node)) setPicking(false);
    };
    const key = (e: KeyboardEvent) => { if (e.key === 'Escape') setPicking(false); };
    document.addEventListener('mousedown', away);
    window.addEventListener('keydown', key);
    return () => {
      document.removeEventListener('mousedown', away);
      window.removeEventListener('keydown', key);
    };
  }, [picking]);

  /* On the bar: whatever somebody chose, plus your own even at a count of one
     -- taking yours back should not need the picker reopened. */
  const shown = CHOICES.filter(
    (c) => (reactions.counts[c.kind] ?? 0) > 0 || reactions.mine === c.kind);

  const choose = (kind: ReactionKind) => { react.mutate(kind); setPicking(false); };

  return (
    <div className="reactions" ref={box}>
      {shown.map((c) => {
        const n = reactions.counts[c.kind] ?? 0;
        const mine = reactions.mine === c.kind;
        return (
          <button
            key={c.kind}
            type="button"
            className={`reaction ${mine ? 'is-mine' : ''}`}
            aria-pressed={mine}
            /* The label carries the meaning; the glyph alone would be a
               guess for anybody using a screen reader. */
            aria-label={mine ? `${c.label} — remove yours` : c.label}
            title={c.label}
            disabled={react.isPending}
            onClick={() => choose(c.kind)}
          >
            <span aria-hidden="true">{c.glyph}</span>
            {n > 0 ? <span className="reaction__n">{n}</span> : null}
          </button>
        );
      })}

      <div className="reactions__more">
        <button type="button" className="reaction reaction--add"
                aria-label="React to this" aria-expanded={picking}
                title="React to this"
                disabled={react.isPending}
                onClick={() => setPicking((v) => !v)}>
          <Icon name="plus" size={14} />
        </button>

        {picking ? (
          <div className="picker" role="menu">
            {CHOICES.map((c) => (
              <button
                key={c.kind} type="button" role="menuitem"
                className={`picker__opt ${reactions.mine === c.kind ? 'is-mine' : ''}`}
                title={c.label} aria-label={c.label}
                onClick={() => choose(c.kind)}
              >
                <span aria-hidden="true">{c.glyph}</span>
              </button>
            ))}
          </div>
        ) : null}
      </div>

      {shown.length === 0 ? (
        <span className="reactions__hint">Be the first to say something.</span>
      ) : null}
    </div>
  );
}