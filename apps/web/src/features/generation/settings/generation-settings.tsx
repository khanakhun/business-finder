'use client';

import type { EngineId, GenerationWorkspaceSettings } from '@bf/contracts';
import { Button } from '@bf/ui/components/button';
import { Checkbox } from '@bf/ui/components/checkbox';
import { ErrorState } from '@bf/ui/components/error-state';
import { Input } from '@bf/ui/components/input';
import { Label } from '@bf/ui/components/label';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@bf/ui/components/select';
import { Skeleton } from '@bf/ui/components/skeleton';
import { Switch } from '@bf/ui/components/switch';
import { TrashIcon } from 'lucide-react';
import { useTranslations } from 'next-intl';
import * as React from 'react';
import { SettingsSection } from '@/components/settings/section.tsx';
import { toProblemLike, useErrorLabels } from '@/components/states/problem.ts';
import { usePermission } from '@/lib/session.tsx';
import { getToast } from '@/lib/toast.tsx';
import { useGenerationSettings, useSaveGenerationSettings } from '../api.ts';
import { parsePattern } from '../engines.ts';
import { move } from '../reorder.ts';
import { SortableList } from '../sortable-list.tsx';

// Settings → Generation (BF-046 on BF-039): which engines this workspace uses, how many run at once, the failover
// order, budgets, attempts, publishing and language defaults, the create flow's run mode and engine presets.
// Everyone with `sites:read` sees them; `settings:manage` changes them.

const LOCALES = ['fr', 'en'] as const;

export function GenerationSettingsForm() {
  const t = useTranslations('generation.settings');
  const errorLabels = useErrorLabels();
  const view = useGenerationSettings();
  const save = useSaveGenerationSettings();
  const canManage = usePermission('settings:manage');
  const [draft, setDraft] = React.useState<GenerationWorkspaceSettings | null>(null);
  React.useEffect(() => {
    if (view.data && !draft) setDraft(view.data.settings);
  }, [view.data, draft]);

  if (view.isError)
    return (
      <ErrorState
        problem={toProblemLike(view.error, t('loadError'))}
        labels={errorLabels}
        onRetry={() => void view.refetch()}
      />
    );
  if (!view.data || !draft) return <Skeleton className="h-96 w-full max-w-3xl" />;
  const { engines, maxConcurrency } = view.data;
  const set = (patch: Partial<GenerationWorkspaceSettings>) => setDraft({ ...draft, ...patch });
  const allowed = new Set(draft.allowedEngines);
  const dirty = JSON.stringify(draft) !== JSON.stringify(view.data.settings);
  const submit = async () => {
    const toast = await getToast();
    try {
      const saved = await save.mutateAsync(draft);
      setDraft(saved.settings);
      toast.success(t('saved'));
    } catch (error) {
      toast.error(toProblemLike(error, t('saveError')).title ?? t('saveError'));
    }
  };
  const toggleEngine = (engine: EngineId, on: boolean) => {
    const allowedEngines = on
      ? [...draft.allowedEngines, engine]
      : draft.allowedEngines.filter((candidate) => candidate !== engine);
    if (allowedEngines.length === 0) return;
    set({
      allowedEngines,
      failoverChain: on
        ? draft.failoverChain
        : draft.failoverChain.filter((candidate) => candidate !== engine),
      defaultEngine: !on && draft.defaultEngine === engine ? 'auto' : draft.defaultEngine,
    });
  };
  return (
    <form
      className="space-y-6"
      onSubmit={(event) => {
        event.preventDefault();
        void submit();
      }}
    >
      <fieldset disabled={!canManage} className="space-y-6">
        <SettingsSection id="gen-engines" title={t('engines.title')} description={t('engines.description')}>
          <ul className="space-y-3">
            {engines.map((engine) => (
              <EngineRow
                key={engine}
                engine={engine}
                allowed={allowed.has(engine)}
                concurrency={draft.engineConcurrency[engine]}
                budget={draft.engineBudgetsUsd[engine]}
                maxConcurrency={maxConcurrency}
                onAllowed={(on) => toggleEngine(engine, on)}
                onConcurrency={(value) => {
                  const next = { ...draft.engineConcurrency };
                  if (value === undefined) delete next[engine];
                  else next[engine] = value;
                  set({ engineConcurrency: next });
                }}
                onBudget={(value) => {
                  const next = { ...draft.engineBudgetsUsd };
                  if (value === undefined) delete next[engine];
                  else next[engine] = value;
                  set({ engineBudgetsUsd: next });
                }}
              />
            ))}
          </ul>
          <div className="mt-4 flex flex-wrap items-center gap-3">
            <Label htmlFor="gen-default-engine">{t('defaultEngine')}</Label>
            <Select
              value={draft.defaultEngine}
              onValueChange={(value) =>
                set({ defaultEngine: value as GenerationWorkspaceSettings['defaultEngine'] })
              }
            >
              <SelectTrigger id="gen-default-engine" size="sm" className="w-56">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="auto">
                  <EngineName engine="auto" />
                </SelectItem>
                {draft.allowedEngines.map((engine) => (
                  <SelectItem key={engine} value={engine}>
                    <EngineName engine={engine} />
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
        </SettingsSection>

        <SettingsSection
          id="gen-failover"
          title={t('failover.title')}
          description={t('failover.description')}
        >
          <div className="mb-3 flex flex-wrap gap-3">
            {draft.allowedEngines.map((engine) => (
              <Label key={engine} className="flex items-center gap-1.5 font-normal">
                <Checkbox
                  checked={draft.failoverChain.includes(engine)}
                  onCheckedChange={(on) =>
                    set({
                      failoverChain:
                        on === true
                          ? [...draft.failoverChain, engine]
                          : draft.failoverChain.filter((candidate) => candidate !== engine),
                    })
                  }
                />
                <EngineName engine={engine} />
              </Label>
            ))}
          </div>
          {draft.failoverChain.length > 0 ? (
            <SortableList
              items={draft.failoverChain.map((engine) => ({ id: engine, label: engine }))}
              label={t('failover.order')}
              disabled={!canManage}
              onMove={(id, to) =>
                set({
                  failoverChain: move(draft.failoverChain, draft.failoverChain.indexOf(id as EngineId), to),
                })
              }
              renderItem={(item) => <EngineName engine={item.id as EngineId} />}
            />
          ) : (
            <p className="text-sm text-muted-foreground">{t('failover.none')}</p>
          )}
        </SettingsSection>

        <SettingsSection id="gen-defaults" title={t('defaults.title')}>
          <div className="grid gap-4 sm:grid-cols-2">
            <div className="flex items-center justify-between gap-2 sm:col-span-2">
              <Label htmlFor="gen-auto-publish" className="font-normal">
                {t('defaults.autoPublish')}
              </Label>
              <Switch
                id="gen-auto-publish"
                checked={draft.autoPublishPreview}
                onCheckedChange={(on) => set({ autoPublishPreview: on })}
              />
            </div>
            <div className="space-y-1">
              <Label htmlFor="gen-attempts">{t('defaults.attempts')}</Label>
              <Input
                id="gen-attempts"
                type="number"
                min={1}
                max={5}
                value={draft.maxAttemptsPerEngine}
                onChange={(event) =>
                  set({ maxAttemptsPerEngine: Math.max(1, Math.min(5, Number(event.target.value) || 1)) })
                }
                className="w-24"
              />
            </div>
            <fieldset className="space-y-1">
              <legend className="text-sm font-medium">{t('defaults.locales')}</legend>
              <div className="flex gap-3">
                {LOCALES.map((locale) => (
                  <Label key={locale} className="flex items-center gap-1.5 font-normal">
                    <Checkbox
                      checked={draft.locales.includes(locale)}
                      onCheckedChange={(on) => {
                        const locales =
                          on === true
                            ? [...new Set([...draft.locales, locale])]
                            : draft.locales.filter((l) => l !== locale);
                        if (locales.length > 0) set({ locales });
                      }}
                    />
                    {locale.toUpperCase()}
                  </Label>
                ))}
              </div>
            </fieldset>
            <fieldset className="space-y-1 sm:col-span-2">
              <legend className="text-sm font-medium">{t('defaults.runMode')}</legend>
              {(['parallel', 'sequential'] as const).map((mode) => (
                <label key={mode} className="flex items-center gap-2 text-sm">
                  <input
                    type="radio"
                    name="gen-run-mode"
                    checked={draft.defaultRunMode === mode}
                    onChange={() => set({ defaultRunMode: mode })}
                  />
                  {t(`defaults.mode.${mode}`)}
                </label>
              ))}
            </fieldset>
          </div>
        </SettingsSection>

        <Presets presets={draft.presets} onChange={(presets) => set({ presets })} />
      </fieldset>
      {canManage ? (
        <div className="flex max-w-3xl justify-end gap-2">
          <Button
            type="button"
            variant="outline"
            disabled={!dirty}
            onClick={() => setDraft(view.data?.settings ?? null)}
          >
            {t('reset')}
          </Button>
          <Button type="submit" disabled={!dirty || save.isPending}>
            {t('save')}
          </Button>
        </div>
      ) : (
        <p className="text-sm text-muted-foreground">{t('readOnly')}</p>
      )}
    </form>
  );
}

function EngineName({ engine }: { readonly engine: EngineId | 'auto' }) {
  const t = useTranslations('generation.engines.name');
  return <>{t(engine)}</>;
}

function EngineRow({
  engine,
  allowed,
  concurrency,
  budget,
  maxConcurrency,
  onAllowed,
  onConcurrency,
  onBudget,
}: {
  readonly engine: EngineId;
  readonly allowed: boolean;
  readonly concurrency: number | undefined;
  readonly budget: number | undefined;
  readonly maxConcurrency: number;
  readonly onAllowed: (on: boolean) => void;
  readonly onConcurrency: (value: number | undefined) => void;
  readonly onBudget: (value: number | undefined) => void;
}) {
  const t = useTranslations('generation.settings.engines');
  const id = `gen-engine-${engine}`;
  return (
    <li className="flex flex-wrap items-center gap-x-4 gap-y-2">
      <Label className="flex w-48 items-center gap-2 font-normal">
        <Checkbox checked={allowed} onCheckedChange={(on) => onAllowed(on === true)} />
        <EngineName engine={engine} />
      </Label>
      <span className="flex items-center gap-1.5">
        <Label htmlFor={`${id}-concurrency`} className="text-xs font-normal text-muted-foreground">
          {t('concurrency')}
        </Label>
        <Input
          id={`${id}-concurrency`}
          type="number"
          min={1}
          max={maxConcurrency}
          disabled={!allowed}
          placeholder={t('noLimit')}
          value={concurrency ?? ''}
          onChange={(event) =>
            onConcurrency(
              event.target.value === ''
                ? undefined
                : Math.max(1, Math.min(maxConcurrency, Number(event.target.value) || 1)),
            )
          }
          className="h-8 w-20"
        />
      </span>
      <span className="flex items-center gap-1.5">
        <Label htmlFor={`${id}-budget`} className="text-xs font-normal text-muted-foreground">
          {t('budget')}
        </Label>
        <Input
          id={`${id}-budget`}
          type="number"
          min={0.01}
          max={100}
          step={0.01}
          disabled={!allowed}
          value={budget ?? ''}
          onChange={(event) =>
            onBudget(
              event.target.value === ''
                ? undefined
                : Math.max(0.01, Math.min(100, Number(event.target.value))),
            )
          }
          className="h-8 w-24"
        />
      </span>
    </li>
  );
}

function Presets({
  presets,
  onChange,
}: {
  readonly presets: GenerationWorkspaceSettings['presets'];
  readonly onChange: (presets: GenerationWorkspaceSettings['presets']) => void;
}) {
  const t = useTranslations('generation.settings.presets');
  const [name, setName] = React.useState('');
  const [pattern, setPattern] = React.useState('');
  const valid = name.trim() !== '' && parsePattern(pattern) !== null;
  const add = () => {
    if (!valid || presets.length >= 20) return;
    const base =
      name
        .trim()
        .toLowerCase()
        .replace(/[^a-z0-9]+/g, '-')
        .replace(/^-|-$/g, '')
        .slice(0, 30) || 'preset';
    let id = base;
    for (let n = 2; presets.some((preset) => preset.id === id); n++) id = `${base}-${n}`;
    onChange([...presets, { id, name: name.trim(), pattern: pattern.trim() }]);
    setName('');
    setPattern('');
  };
  return (
    <SettingsSection id="gen-presets" title={t('title')} description={t('description')}>
      {presets.length === 0 ? (
        <p className="mb-3 text-sm text-muted-foreground">{t('none')}</p>
      ) : (
        <ul className="mb-3 space-y-1">
          {presets.map((preset) => (
            <li key={preset.id} className="flex items-center gap-3 text-sm">
              <span className="font-medium">{preset.name}</span>
              <span className="font-mono text-xs text-muted-foreground">{preset.pattern}</span>
              <Button
                type="button"
                size="icon"
                variant="ghost"
                className="ml-auto size-7"
                aria-label={t('remove', { name: preset.name })}
                onClick={() => onChange(presets.filter((candidate) => candidate.id !== preset.id))}
              >
                <TrashIcon aria-hidden />
              </Button>
            </li>
          ))}
        </ul>
      )}
      <div className="flex flex-wrap items-end gap-2">
        <div className="space-y-1">
          <Label htmlFor="preset-name">{t('name')}</Label>
          <Input
            id="preset-name"
            value={name}
            maxLength={60}
            onChange={(event) => setName(event.target.value)}
          />
        </div>
        <div className="space-y-1">
          <Label htmlFor="preset-pattern">{t('pattern')}</Label>
          <Input
            id="preset-pattern"
            value={pattern}
            maxLength={200}
            placeholder="2 claude-code + 2 codex + rest blocks"
            aria-invalid={pattern.trim() !== '' && parsePattern(pattern) === null}
            onChange={(event) => setPattern(event.target.value)}
            className="w-72"
          />
        </div>
        <Button type="button" variant="outline" disabled={!valid} onClick={add}>
          {t('add')}
        </Button>
      </div>
    </SettingsSection>
  );
}
