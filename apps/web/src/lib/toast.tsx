'use client';

import * as React from 'react';

type Toast = typeof import('@bf/ui/components/sonner').toast;

const loadSonner = () => import('@bf/ui/components/sonner');
type ToasterComponent = Awaited<ReturnType<typeof loadSonner>>['Toaster'];

// The host registers itself here; `getToast` asks it to mount and waits until the toaster is subscribed.
let requestMount: (() => Promise<void>) | undefined;

/**
 * Toast viewport that renders only once something is toasted: sonner is ~11 kB gzip that the shell's first load
 * does not need (it counts against the 200 kB budget in e2e/performance.spec.ts). The module is loaded explicitly
 * and rendered once loaded — not through React.lazy/Suspense, whose retry could stay pending behind a page's
 * long-running transitions (seen on /search, BF-023), leaving every toast unshown.
 */
export function ToastHost(props: React.ComponentProps<ToasterComponent>) {
  const [Toaster, setToaster] = React.useState<ToasterComponent | null>(null);
  const resolveMounted = React.useRef<() => void>(undefined);

  React.useEffect(() => {
    let pending: Promise<void> | undefined;
    requestMount = () => {
      pending ??= new Promise<void>((resolve) => {
        resolveMounted.current = resolve;
        loadSonner().then(
          (m) => setToaster(() => m.Toaster),
          (error: unknown) => {
            // The chunk failed (offline, deploy in progress): let the next toast try again.
            pending = undefined;
            console.error('Toast viewport could not load', error);
          },
        );
      });
      return pending;
    };
    return () => {
      requestMount = undefined;
    };
  }, []);

  if (!Toaster) return null;
  return (
    <>
      <Toaster {...props} />
      {/* Effects run in tree order, so this fires after the Toaster has subscribed to new toasts. */}
      <OnMount callback={resolveMounted.current} />
    </>
  );
}

function OnMount({ callback }: { readonly callback: (() => void) | undefined }) {
  React.useEffect(() => callback?.(), [callback]);
  return null;
}

/**
 * Returns sonner's `toast` once the viewport is mounted (sonner drops toasts created before its Toaster subscribes).
 * Usage: `(await getToast()).success(t('saved'))`.
 */
export async function getToast(): Promise<Toast> {
  const [{ toast }] = await Promise.all([loadSonner(), requestMount?.()]);
  return toast;
}
