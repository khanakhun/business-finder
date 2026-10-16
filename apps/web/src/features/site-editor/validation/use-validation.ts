'use client';

import { HOTLINK_HOSTS, type Issue, validateSite } from '@bf/site-schema';
import * as React from 'react';
import type { ValidationRequest } from './validation.worker.ts';

/**
 * The validators' issues for `spec` (the site as the canvas shows it), computed in a Web Worker a moment after the
 * last change; in the same thread where workers are unavailable (tests).
 */
export function useValidation(spec: unknown, assetHosts: readonly string[], delay = 400): readonly Issue[] {
  const [issues, setIssues] = React.useState<readonly Issue[]>([]);
  const worker = React.useRef<Worker | null>(null);
  const sent = React.useRef(0);
  const latest = React.useRef({ spec, assetHosts });
  latest.current = { spec, assetHosts };
  React.useEffect(() => {
    if (typeof Worker === 'undefined') return;
    const instance = new Worker(new URL('./validation.worker.ts', import.meta.url), { type: 'module' });
    // A worker that fails to load or crashes: validation goes on in this thread (never a silent "no issues").
    instance.onerror = (event) => {
      event.preventDefault();
      console.error('site editor: validation worker failed; validating on the main thread', event.message);
      instance.terminate();
      worker.current = null;
      sent.current += 1;
      setIssues(
        validateSite(latest.current.spec, {
          assetHosts: [...latest.current.assetHosts],
          hotlinkHosts: [...HOTLINK_HOSTS],
          mode: 'published',
        }),
      );
    };
    instance.onmessage = (event: MessageEvent<{ id: number; issues: Issue[] }>) => {
      // Only the latest request's answer counts.
      if (event.data.id === sent.current) setIssues(event.data.issues);
    };
    worker.current = instance;
    return () => {
      instance.terminate();
      worker.current = null;
    };
  }, []);
  React.useEffect(() => {
    const timer = setTimeout(() => {
      sent.current += 1;
      const request: ValidationRequest = { id: sent.current, spec, assetHosts };
      if (worker.current) worker.current.postMessage(request);
      else
        setIssues(
          validateSite(spec, {
            assetHosts: [...assetHosts],
            hotlinkHosts: [...HOTLINK_HOSTS],
            mode: 'published',
          }),
        );
    }, delay);
    return () => clearTimeout(timer);
  }, [spec, assetHosts, delay]);
  return issues;
}
