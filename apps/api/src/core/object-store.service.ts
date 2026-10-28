/**
 * The bucket, and nothing else.
 *
 * Uploads used to live entirely inside the tasks module: the S3 client, the
 * presigning, the magic-byte check and the rows, all in one service. That was
 * fine while tickets were the only thing anybody attached a file to. It stopped
 * being fine the moment the module could be switched off for a deployment --
 * anything else that needed to store a picture would have had its uploads
 * disappear along with a feature it has nothing to do with.
 *
 * So the parts that are about S3 are here, in core, and the parts that are
 * about a particular feature stay with that feature. This service knows how to
 * hand out an upload URL, read an object back, and delete one. It does not know
 * what a ticket is, or an announcement, and it owns no table: each module keeps
 * its own rows, with its own columns and its own permission rules, and calls
 * this for the bucket work.
 *
 * The split is deliberate rather than tidy-minded. Sharing the rows would mean
 * one table answering to two sets of access rules, which is how a picture meant
 * for one audience ends up readable by another.
 */
import { Injectable, Logger, ServiceUnavailableException } from '@nestjs/common';
import {
  DeleteObjectCommand, GetObjectCommand, HeadObjectCommand, PutObjectCommand, S3Client,
} from '@aws-sdk/client-s3';
import { getSignedUrl } from '@aws-sdk/s3-request-presigner';
import { config } from '../common/config';

@Injectable()
export class ObjectStoreService {
  private readonly log = new Logger('ObjectStore');
  private client: S3Client | null = null;

  /** Built on first use, not at boot: the credentials come from the instance
   *  role, and a slow metadata service should delay the first upload rather
   *  than every start. */
  private get s3(): S3Client {
    if (!this.client) this.client = new S3Client({ region: config.attachments.region });
    return this.client;
  }

  get bucket(): string {
    if (!config.attachments.bucket) {
      throw new ServiceUnavailableException(
        'File storage is not set up on this server (S3_ATTACHMENTS_BUCKET is empty).');
    }
    return config.attachments.bucket;
  }

  /** Whether uploading is possible at all, so a caller can say so plainly
   *  rather than offering a button that fails. */
  get configured(): boolean {
    return !!config.attachments.bucket;
  }

  /**
   * A URL the browser can PUT one object to.
   *
   * The bytes go straight from the person to S3; they never pass through this
   * API, which is what keeps a large upload from occupying a request worker for
   * its whole duration.
   *
   * The declared content type is pinned into the signature, so the object that
   * arrives is the type that was asked for -- but it is still only a claim at
   * this point, which is why callers verify the bytes afterwards.
   */
  async presignUpload(key: string, contentType: string, expiresIn = 300): Promise<string> {
    return getSignedUrl(this.s3,
      new PutObjectCommand({ Bucket: this.bucket, Key: key, ContentType: contentType }),
      { expiresIn });
  }

  /**
   * A short-lived URL for reading one object.
   *
   * `disposition` is passed through whole rather than built from a file name
   * here, because callers that serve downloads need the RFC 5987 form
   * (filename*=UTF-8''...) for an Arabic name to arrive as it was written, and
   * squeezing that through a "filename" argument would quietly mangle it.
   */
  async presignDownload(
    key: string, expiresIn = 300, disposition?: string,
  ): Promise<string> {
    return getSignedUrl(this.s3,
      new GetObjectCommand({
        Bucket: this.bucket, Key: key,
        ...(disposition ? { ResponseContentDisposition: disposition } : {}),
      }),
      { expiresIn });
  }

  /** Size and type as S3 sees them, or null when nothing was uploaded. */
  async head(key: string): Promise<{ size: number; contentType: string | null } | null> {
    try {
      const h = await this.s3.send(new HeadObjectCommand({ Bucket: this.bucket, Key: key }));
      return { size: h.ContentLength ?? 0, contentType: h.ContentType ?? null };
    } catch {
      return null;
    }
  }

  /** The object's bytes, for checking what actually arrived. */
  async read(key: string): Promise<Buffer> {
    const obj = await this.s3.send(new GetObjectCommand({ Bucket: this.bucket, Key: key }));
    return Buffer.from(await obj.Body!.transformToByteArray());
  }

  async put(key: string, body: Buffer, contentType: string): Promise<void> {
    await this.s3.send(new PutObjectCommand({
      Bucket: this.bucket, Key: key, Body: body, ContentType: contentType,
    }));
  }

  /**
   * Remove an object, swallowing the failure.
   *
   * Deletes here are always tidying up after something the database has already
   * decided: an upload that was abandoned, a row that has gone. Letting a
   * failed delete break that caller would turn a stray object into a failed
   * request, so it is logged and left -- the object costs storage, and the
   * alternative costs the user their action.
   */
  async remove(key: string): Promise<void> {
    await this.s3.send(new DeleteObjectCommand({ Bucket: this.bucket, Key: key }))
      .catch((e) => this.log.warn(`could not delete ${key}: ${e?.message ?? e}`));
  }
}