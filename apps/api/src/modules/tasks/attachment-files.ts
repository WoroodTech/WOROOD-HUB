/**
 * What a file actually is, and the smaller version of it that gets kept.
 *
 * No S3 and no database here. Deciding whether bytes are a JPEG and turning a
 * phone photo into something a ticket can afford to store are jobs that should
 * be testable with nothing but a buffer.
 */
import sharp from 'sharp';

export type FileKind = 'jpeg' | 'png' | 'webp' | 'pdf';

/** Types the browser may *claim*. Checked before a URL is issued, so a person
 *  picking a .zip is told immediately rather than after uploading it. */
export const ACCEPTED_TYPES = ['image/jpeg', 'image/png', 'image/webp', 'application/pdf'];

export const MAX_UPLOAD_BYTES = 10 * 1024 * 1024;

/**
 * Read the type from the file's first bytes.
 *
 * The extension and the browser's Content-Type are both things the uploader
 * controls; a renamed executable arrives as `photo.jpg`, image/jpeg. The first
 * few bytes are what the file is. SVG is absent deliberately: it is an image
 * format that can carry script.
 */
export function sniff(b: Buffer): FileKind | null {
  if (b.length < 12) return null;
  if (b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff) return 'jpeg';
  if (b.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) return 'png';
  if (b.toString('ascii', 0, 4) === 'RIFF' && b.toString('ascii', 8, 12) === 'WEBP') return 'webp';
  if (b.toString('ascii', 0, 5) === '%PDF-') return 'pdf';
  return null;
}

/* ------------------------------------------------------------ compression -- */

/**
 * Two at a time, at most.
 *
 * Decoding a 12-megapixel photo is a few hundred megabytes for a moment, and
 * this runs on the same instance as PostgreSQL and Redis. A department
 * uploading twenty photos at once should queue for a second or two, not push
 * the database into swap.
 */
let running = 0;
const waiting: Array<() => void> = [];
async function slot<T>(fn: () => Promise<T>): Promise<T> {
  if (running >= 2) await new Promise<void>((r) => waiting.push(r));
  running++;
  try { return await fn(); }
  finally { running--; waiting.shift()?.(); }
}

export interface CompressedImage {
  main: Buffer; thumb: Buffer;
  width: number; height: number;
}

/**
 * The version that is kept.
 *
 * WebP at quality 82, longest side 2000px. A phone photo goes from three or
 * four megabytes to around three hundred kilobytes and still reads as the
 * photo; 2000px is past what any ticket screen shows. The original is not
 * kept — that is the point of compressing for storage.
 *
 * `rotate()` with no angle applies the camera's orientation flag and then the
 * output carries no metadata at all, because sharp writes none unless asked.
 * That drops the GPS position phones embed in every photo, which is not
 * something a ticket about a damaged delivery should be publishing to
 * everybody who can open it.
 *
 * The thumbnail is made in the same pass, because the image is already decoded
 * and a board card should load thirty kilobytes, not three hundred.
 */
export function compressImage(input: Buffer): Promise<CompressedImage> {
  return slot(async () => {
    /* A ceiling on pixels, not bytes. A small PNG can declare enormous
       dimensions and expand to gigabytes when decoded -- the classic
       decompression bomb -- and the byte limit says nothing about that. */
    const base = sharp(input, { limitInputPixels: 50_000_000, failOn: 'error' }).rotate();

    const main = await base.clone()
      .resize({ width: 2000, height: 2000, fit: 'inside', withoutEnlargement: true })
      .webp({ quality: 82 })
      .toBuffer({ resolveWithObject: true });

    const thumb = await base.clone()
      .resize({ width: 480, height: 480, fit: 'inside', withoutEnlargement: true })
      .webp({ quality: 70 })
      .toBuffer();

    return { main: main.data, thumb, width: main.info.width, height: main.info.height };
  });
}