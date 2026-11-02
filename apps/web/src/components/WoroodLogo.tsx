/**
 * The WOROOD mark and wordmark.
 *
 * The brand artwork, as supplied: three PNGs — the brown one for light
 * backgrounds, the cream one for dark, and an orange one for where the accent
 * is wanted. They were cropped from the full lockups to their own content, so
 * nothing carries transparent padding that would offset it in a layout, and
 * the mark and the wordmark are separate files because the sidebar shows one
 * and the login screen shows both.
 *
 * **Both themes are in the markup, and CSS chooses.** The alternative — asking
 * the theme in JavaScript and rendering one — means the wrong logo is painted
 * for a frame on every load, which on the login screen is the first thing
 * anybody sees. Two `<img>` elements cost one extra request that the browser
 * caches and never repeats.
 *
 * This replaces a traced SVG that took `currentColor`. A PNG cannot, so a
 * caller can no longer recolour the mark with CSS; the orange variant exists
 * for the one place that needed to.
 */

export interface MarkProps {
  size?: number;
  className?: string;
  /** Set when the mark sits beside the wordmark and would be read twice. */
  title?: string;
  /** Use the orange artwork rather than the light/dark pair. */
  accent?: boolean;
}

/** Hidden from the theme that is not showing, and from screen readers twice. */
function Pair({ kind, alt, className, style, accent }: {
  kind: 'mark' | 'wordmark' | 'lockup';
  alt: string;
  className?: string;
  style?: React.CSSProperties;
  accent?: boolean;
}) {
  if (accent) {
    return (
      <img src={`/brand/worood-orange-${kind}.png`} alt={alt}
           className={className} style={style} />
    );
  }
  return (
    <>
      {/* The brown artwork, for light backgrounds. */}
      <img src={`/brand/worood-dark-${kind}.png`} alt={alt}
           className={`brandimg brandimg--onlight ${className ?? ''}`} style={style} />
      {/* The cream one, for dark. Empty alt: the first carries the text, and
          two would be read out twice. */}
      <img src={`/brand/worood-light-${kind}.png`} alt=""
           aria-hidden="true"
           className={`brandimg brandimg--ondark ${className ?? ''}`} style={style} />
    </>
  );
}

/**
 * The bloom, on its own.
 *
 * `size` is the height, not a square: the mark is wider than it is tall
 * (549×381), and forcing it square would either stretch it or leave it
 * floating in a box. The width follows from the artwork.
 */
export function WoroodMark({ size = 28, className, title, accent }: MarkProps) {
  return (
    <Pair kind="mark" accent={accent}
          alt={title ?? 'WOROOD'}
          className={className}
          style={{ height: size, width: 'auto' }} />
  );
}

export interface WordmarkProps {
  width?: number;
  className?: string;
  accent?: boolean;
}

/** The word, on its own. */
export function WoroodWordmark({ width = 104, className, accent }: WordmarkProps) {
  return (
    <Pair kind="wordmark" accent={accent}
          alt="WOROOD"
          className={className}
          style={{ width, height: 'auto' }} />
  );
}

/** Mark above word, as the brand artwork has it. */
export function WoroodLogo({ width = 190, className, accent }: WordmarkProps) {
  return (
    <Pair kind="lockup" accent={accent}
          alt="WOROOD"
          className={className}
          style={{ width, height: 'auto' }} />
  );
}