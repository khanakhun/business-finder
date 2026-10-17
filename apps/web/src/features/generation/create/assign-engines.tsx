'use client';

import { Button } from '@bf/ui/components/button';
import { Input } from '@bf/ui/components/input';
import { Label } from '@bf/ui/components/label';
import { Popover, PopoverContent, PopoverTrigger } from '@bf/ui/components/popover';
import { WandSparklesIcon } from 'lucide-react';
import { useTranslations } from 'next-intl';
import * as React from 'react';
import { assignEngines, type PickableEngine, parsePattern } from '../engines.ts';

// "Assign engines…" (BF-046): a pattern such as "2 claude-code + 2 codex + rest blocks" distributes the items over
// engines by position; the preview shows the result before it is applied.

export function AssignEngines({
  count,
  onApply,
}: {
  readonly count: number;
  readonly onApply: (engines: PickableEngine[]) => void;
}) {
  const t = useTranslations('generation.assign');
  const engines = useTranslations('generation.engines.name');
  const [open, setOpen] = React.useState(false);
  const [text, setText] = React.useState('');
  const pattern = text.trim() ? parsePattern(text) : null;
  const preview = pattern ? assignEngines(count, pattern) : null;
  const summary = preview
    ? [...new Set(preview)]
        .map((engine) => `${preview.filter((e) => e === engine).length} × ${engines(engine)}`)
        .join(' · ')
    : null;
  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <Button type="button" size="sm" variant="outline">
          <WandSparklesIcon aria-hidden />
          {t('open')}
        </Button>
      </PopoverTrigger>
      <PopoverContent className="w-80 space-y-2">
        <form
          className="space-y-2"
          onSubmit={(event) => {
            event.preventDefault();
            if (!preview) return;
            onApply(preview);
            setOpen(false);
          }}
        >
          <Label htmlFor="assign-pattern">{t('label')}</Label>
          <Input
            id="assign-pattern"
            value={text}
            placeholder={t('placeholder')}
            onChange={(event) => setText(event.target.value)}
            aria-invalid={text.trim() !== '' && !pattern}
            aria-describedby="assign-pattern-help"
            autoComplete="off"
          />
          <p id="assign-pattern-help" className="text-xs text-muted-foreground" aria-live="polite">
            {text.trim() === '' ? t('help') : (summary ?? t('invalid'))}
          </p>
          <div className="flex justify-end">
            <Button type="submit" size="sm" disabled={!preview}>
              {t('apply')}
            </Button>
          </div>
        </form>
      </PopoverContent>
    </Popover>
  );
}
