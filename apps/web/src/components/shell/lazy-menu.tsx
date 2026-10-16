'use client';

import { Button } from '@bf/ui/components/button';
import * as React from 'react';

type ButtonProps = React.ComponentProps<typeof Button>;

export interface LazyMenuProps {
  /** Loads the real menu (Radix DropdownMenu/Popover); it must render its own trigger and accept `defaultOpen`. */
  readonly load: () => Promise<React.ComponentType<{ defaultOpen: boolean }>>;
  /** Props for the placeholder trigger; must look exactly like the real trigger. */
  readonly trigger: ButtonProps;
  readonly children?: React.ReactNode;
}

/**
 * Top-bar menus stay a plain button until the person shows intent (hover, focus, click, keyboard): only then is the
 * menu code downloaded. Keeps Radix's popper out of the initial bundle (BF-007 budget: < 200 kB gzip).
 */
export function LazyMenu({ load, trigger, children }: LazyMenuProps) {
  const [Menu, setMenu] = React.useState<React.ComponentType<{ defaultOpen: boolean }> | null>(null);
  const [open, setOpen] = React.useState(false);
  const loading = React.useRef<Promise<void> | null>(null);

  const ensureLoaded = React.useCallback(() => {
    loading.current ??= load().then((component) => setMenu(() => component));
    return loading.current;
  }, [load]);

  if (Menu) return <Menu defaultOpen={open} />;

  const openMenu = () => {
    setOpen(true);
    void ensureLoaded();
  };
  return (
    <Button
      {...trigger}
      aria-haspopup="menu"
      aria-expanded={false}
      onPointerEnter={() => void ensureLoaded()}
      onFocus={() => void ensureLoaded()}
      onClick={openMenu}
      onKeyDown={(event) => {
        if (event.key === 'ArrowDown') {
          event.preventDefault();
          openMenu();
        }
      }}
    >
      {children}
    </Button>
  );
}
