/** Port: the assets bucket (S3-compatible). Keys are chosen by the caller and always org-prefixed. */
export interface ObjectStorage {
  put(key: string, body: Buffer, contentType: string): Promise<void>;
  get(key: string): Promise<{ readonly body: Buffer; readonly contentType: string } | undefined>;
  delete(key: string): Promise<void>;
}
export const OBJECT_STORAGE = Symbol('ObjectStorage');
/** The artifacts bucket (crawl screenshots and page markdown written by services/intel, BF-026): read-only here. */
export const ARTIFACT_STORAGE = Symbol('ArtifactStorage');

/** In-memory adapter for tests (and the OpenAPI build, which connects to nothing). */
export class InMemoryObjectStorage implements ObjectStorage {
  readonly objects = new Map<string, { readonly body: Buffer; readonly contentType: string }>();

  async put(key: string, body: Buffer, contentType: string): Promise<void> {
    this.objects.set(key, { body: Buffer.from(body), contentType });
  }

  async get(key: string) {
    return this.objects.get(key);
  }

  async delete(key: string): Promise<void> {
    this.objects.delete(key);
  }
}
