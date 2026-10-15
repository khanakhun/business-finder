import {
  DeleteObjectCommand,
  GetObjectCommand,
  NoSuchKey,
  PutObjectCommand,
  S3Client,
} from '@aws-sdk/client-s3';
import type { ApiEnv } from '@bf/config';
import type { ObjectStorage } from './object-storage.ts';

type S3Env = Pick<
  ApiEnv,
  | 'S3_ENDPOINT'
  | 'S3_REGION'
  | 'S3_ACCESS_KEY_ID'
  | 'S3_SECRET_ACCESS_KEY'
  | 'S3_FORCE_PATH_STYLE'
  | 'S3_BUCKET_ASSETS'
>;

/** The assets bucket on any S3-compatible store (RustFS locally). */
export class S3ObjectStorage implements ObjectStorage {
  private readonly client: S3Client;
  private readonly bucket: string;

  constructor(env: S3Env) {
    this.bucket = env.S3_BUCKET_ASSETS;
    this.client = new S3Client({
      endpoint: env.S3_ENDPOINT,
      region: env.S3_REGION,
      forcePathStyle: env.S3_FORCE_PATH_STYLE,
      credentials: { accessKeyId: env.S3_ACCESS_KEY_ID, secretAccessKey: env.S3_SECRET_ACCESS_KEY },
      maxAttempts: 3,
    });
  }

  async put(key: string, body: Buffer, contentType: string): Promise<void> {
    await this.client.send(
      new PutObjectCommand({ Bucket: this.bucket, Key: key, Body: body, ContentType: contentType }),
      { abortSignal: AbortSignal.timeout(15_000) },
    );
  }

  async get(key: string): Promise<{ readonly body: Buffer; readonly contentType: string } | undefined> {
    try {
      const object = await this.client.send(new GetObjectCommand({ Bucket: this.bucket, Key: key }), {
        abortSignal: AbortSignal.timeout(15_000),
      });
      if (!object.Body) return undefined;
      return {
        body: Buffer.from(await object.Body.transformToByteArray()),
        contentType: object.ContentType ?? 'application/octet-stream',
      };
    } catch (error) {
      if (error instanceof NoSuchKey) return undefined;
      throw error;
    }
  }

  async delete(key: string): Promise<void> {
    await this.client.send(new DeleteObjectCommand({ Bucket: this.bucket, Key: key }), {
      abortSignal: AbortSignal.timeout(15_000),
    });
  }

  /** Nest lifecycle hook: close the HTTP agent's sockets on shutdown. */
  onApplicationShutdown(): void {
    this.client.destroy();
  }
}
