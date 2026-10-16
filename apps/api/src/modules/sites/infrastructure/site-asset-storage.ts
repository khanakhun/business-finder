import { DeleteObjectCommand, PutObjectCommand, S3Client } from '@aws-sdk/client-s3';
import { getSignedUrl } from '@aws-sdk/s3-request-presigner';
import type { ApiEnv } from '@bf/config';
import type { PublicFiles, UploadSigner } from '../application/ports.ts';

type S3Env = Pick<
  ApiEnv,
  | 'S3_ENDPOINT'
  | 'S3_REGION'
  | 'S3_ACCESS_KEY_ID'
  | 'S3_SECRET_ACCESS_KEY'
  | 'S3_FORCE_PATH_STYLE'
  | 'S3_BUCKET_ASSETS'
  | 'S3_BUCKET_SITES'
  | 'SITES_ASSETS_BASE_URL'
>;

const s3Client = (env: S3Env) =>
  new S3Client({
    endpoint: env.S3_ENDPOINT,
    region: env.S3_REGION,
    forcePathStyle: env.S3_FORCE_PATH_STYLE,
    credentials: { accessKeyId: env.S3_ACCESS_KEY_ID, secretAccessKey: env.S3_SECRET_ACCESS_KEY },
    maxAttempts: 3,
  });

/**
 * Presigned PUTs to the private assets bucket. `Content-Type` and `Content-Length` are signed: the store refuses an
 * upload of another type or size than the one declared (the bytes are still sniffed at finalize).
 */
export class S3UploadSigner implements UploadSigner {
  private readonly client: S3Client;

  constructor(private readonly env: S3Env) {
    this.client = s3Client(env);
  }

  async presignPut(key: string, contentType: string, bytes: number, expiresInSeconds: number) {
    const command = new PutObjectCommand({
      Bucket: this.env.S3_BUCKET_ASSETS,
      Key: key,
      ContentType: contentType,
      ContentLength: bytes,
    });
    const url = await getSignedUrl(this.client, command, {
      expiresIn: expiresInSeconds,
      signableHeaders: new Set(['content-type', 'content-length']),
    });
    return { url, headers: { 'Content-Type': contentType } };
  }

  /** Nest lifecycle hook: close the HTTP agent's sockets on shutdown. */
  onApplicationShutdown(): void {
    this.client.destroy();
  }
}

/** The public sites bucket behind the CDN: variants are immutable (their key names the asset and the width). */
export class S3PublicFiles implements PublicFiles {
  private readonly client: S3Client;
  private readonly base: string;

  constructor(private readonly env: S3Env) {
    this.client = s3Client(env);
    this.base = env.SITES_ASSETS_BASE_URL.replace(/\/+$/, '');
  }

  async put(key: string, body: Buffer, contentType: string): Promise<void> {
    await this.client.send(
      new PutObjectCommand({
        Bucket: this.env.S3_BUCKET_SITES,
        Key: key,
        Body: body,
        ContentType: contentType,
        CacheControl: 'public, max-age=31536000, immutable',
      }),
      { abortSignal: AbortSignal.timeout(15_000) },
    );
  }

  async delete(key: string): Promise<void> {
    await this.client.send(new DeleteObjectCommand({ Bucket: this.env.S3_BUCKET_SITES, Key: key }), {
      abortSignal: AbortSignal.timeout(15_000),
    });
  }

  url(key: string): string {
    return `${this.base}/${key}`;
  }

  onApplicationShutdown(): void {
    this.client.destroy();
  }
}

/** Test and OpenAPI doubles: a signer that signs nothing and a public bucket in memory. */
export class FakeUploadSigner implements UploadSigner {
  async presignPut(key: string, contentType: string) {
    return { url: `https://uploads.test/${key}`, headers: { 'Content-Type': contentType } };
  }
}

export class InMemoryPublicFiles implements PublicFiles {
  readonly files = new Map<string, { body: Buffer; contentType: string }>();

  constructor(private readonly base = 'https://assets.sites.test') {}

  async put(key: string, body: Buffer, contentType: string): Promise<void> {
    this.files.set(key, { body: Buffer.from(body), contentType });
  }

  async delete(key: string): Promise<void> {
    this.files.delete(key);
  }

  url(key: string): string {
    return `${this.base}/${key}`;
  }
}
