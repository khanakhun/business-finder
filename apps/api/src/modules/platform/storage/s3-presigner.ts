import { GetObjectCommand, PutObjectCommand, S3Client } from '@aws-sdk/client-s3';
import { getSignedUrl } from '@aws-sdk/s3-request-presigner';
import type { ApiEnv } from '@bf/config';

// Presigned URLs for internal services (BF-059: intel reads a dataset and writes model artifacts without holding
// storage credentials). Short-lived; the PUT's Content-Type is signed, so only the declared type is accepted.

type S3Env = Pick<
  ApiEnv,
  'S3_ENDPOINT' | 'S3_REGION' | 'S3_ACCESS_KEY_ID' | 'S3_SECRET_ACCESS_KEY' | 'S3_FORCE_PATH_STYLE'
>;

export interface ObjectPresigner {
  presignGet(bucket: string, key: string, expiresInSeconds: number): Promise<string>;
  presignPut(bucket: string, key: string, contentType: string, expiresInSeconds: number): Promise<string>;
}
export const OBJECT_PRESIGNER = Symbol('ObjectPresigner');

export class S3Presigner implements ObjectPresigner {
  private readonly client: S3Client;

  constructor(env: S3Env) {
    this.client = new S3Client({
      endpoint: env.S3_ENDPOINT,
      region: env.S3_REGION,
      forcePathStyle: env.S3_FORCE_PATH_STYLE,
      credentials: { accessKeyId: env.S3_ACCESS_KEY_ID, secretAccessKey: env.S3_SECRET_ACCESS_KEY },
    });
  }

  presignGet(bucket: string, key: string, expiresInSeconds: number): Promise<string> {
    return getSignedUrl(this.client, new GetObjectCommand({ Bucket: bucket, Key: key }), {
      expiresIn: expiresInSeconds,
    });
  }

  presignPut(bucket: string, key: string, contentType: string, expiresInSeconds: number): Promise<string> {
    return getSignedUrl(
      this.client,
      new PutObjectCommand({ Bucket: bucket, Key: key, ContentType: contentType }),
      { expiresIn: expiresInSeconds, signableHeaders: new Set(['content-type']) },
    );
  }
}
