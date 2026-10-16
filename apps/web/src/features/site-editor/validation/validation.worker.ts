import { HOTLINK_HOSTS, validateSite } from '@bf/site-schema';

// The editor's validation, off the main thread (BF-037): typing never waits for the validators.

export interface ValidationRequest {
  readonly id: number;
  readonly spec: unknown;
  readonly assetHosts: readonly string[];
}

self.onmessage = (event: MessageEvent<ValidationRequest>) => {
  const { id, spec, assetHosts } = event.data;
  // As publishing checks (the API's mode): an error here blocks publishing.
  const issues = validateSite(spec, {
    assetHosts: [...assetHosts],
    hotlinkHosts: [...HOTLINK_HOSTS],
    mode: 'published',
  });
  self.postMessage({ id, issues });
};
