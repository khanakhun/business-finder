'use client';

import {
  HOLIDAY_CALENDARS,
  OFFERS,
  type Offer,
  type SaveSequenceRequest,
  type Sequence,
  type SequenceSettings,
  type SequenceStep,
  STEP_CONDITIONS,
  STEP_KINDS,
  validateDefinition,
} from '@bf/contracts';
import { Button } from '@bf/ui/components/button';
import { Checkbox } from '@bf/ui/components/checkbox';
import { Input } from '@bf/ui/components/input';
import { Label } from '@bf/ui/components/label';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@bf/ui/components/select';
import { Sheet, SheetContent, SheetDescription, SheetTitle } from '@bf/ui/components/sheet';
import { Textarea } from '@bf/ui/components/textarea';
import { ArrowDownIcon, ArrowUpIcon, PlusIcon, Trash2Icon } from 'lucide-react';
import { useFormatter, useTranslations } from 'next-intl';
import * as React from 'react';
import { toProblemLike } from '@/components/states/problem.ts';
import { useTemplates } from '@/features/outreach/api.ts';
import { getToast } from '@/lib/toast.tsx';
import { useSequenceActions } from './api.ts';

// The sequence builder (BF-053): steps with their waits in business days ("+3 business days at 09:30"), kind,
// condition, threading, A/B variants (template or AI instructions, weights) and task titles; the safety rails are
// checked live (the same rules as the API), and a timeline previews the dates from today (weekends skipped).

const DEFAULT_SETTINGS: SequenceSettings = {
  calendars: ['FR'],
  maxEmails: 3,
  minGapBusinessDays: 2,
  approval: 'auto_when_permitted',
  stopOnPreviewLead: true,
};

const blankStep = (index: number): SequenceStep => ({
  id: `step-${index + 1}`,
  kind: 'email',
  wait: { businessDays: index === 0 ? 0 : 3, preferredLocalTime: '09:30' },
  condition: 'always',
  threading: index === 0 ? 'new_thread' : 'reply_in_thread',
  variants: [{ id: 'a', weight: 100, templateId: null, instructions: '' }],
  taskTitle: null,
  skipIfUnverified: false,
});

/** Business days from today (weekends only: holidays are applied by the server). */
function previewDates(steps: readonly SequenceStep[]): Date[] {
  const dates: Date[] = [];
  const day = new Date();
  for (const step of steps) {
    let left = step.wait.businessDays;
    while (day.getDay() === 0 || day.getDay() === 6) day.setDate(day.getDate() + 1);
    while (left > 0) {
      day.setDate(day.getDate() + 1);
      if (day.getDay() !== 0 && day.getDay() !== 6) left--;
    }
    dates.push(new Date(day));
  }
  return dates;
}

export function SequenceBuilder({
  open,
  sequence,
  onClose,
}: {
  readonly open: boolean;
  readonly sequence: Sequence | null;
  readonly onClose: () => void;
}) {
  const t = useTranslations('sequences.builder');
  const offerName = useTranslations('composer.offers');
  const format = useFormatter();
  const actions = useSequenceActions();
  const [name, setName] = React.useState('');
  const [offer, setOffer] = React.useState<Offer>('website_redesign');
  const [settings, setSettings] = React.useState<SequenceSettings>(DEFAULT_SETTINGS);
  const [steps, setSteps] = React.useState<SequenceStep[]>([blankStep(0)]);
  React.useEffect(() => {
    if (!open) return;
    setName(sequence?.name ?? '');
    setOffer(sequence?.offer ?? 'website_redesign');
    setSettings(sequence?.settings ?? DEFAULT_SETTINGS);
    setSteps(sequence?.steps ?? [blankStep(0)]);
  }, [open, sequence]);
  const issues = validateDefinition(settings, steps);
  const dates = previewDates(steps);
  const update = (index: number, patch: Partial<SequenceStep>) =>
    setSteps((current) => current.map((step, i) => (i === index ? { ...step, ...patch } : step)));
  const move = (index: number, by: number) =>
    setSteps((current) => {
      const next = [...current];
      const [step] = next.splice(index, 1);
      if (step) next.splice(index + by, 0, step);
      return next;
    });
  const save = async () => {
    const toast = await getToast();
    const body: SaveSequenceRequest = { name, offer, settings, steps };
    try {
      if (sequence) await actions.update.mutateAsync({ id: sequence.id, body });
      else await actions.create.mutateAsync(body);
      toast.success(t('saved'));
      onClose();
    } catch (error) {
      const problem = toProblemLike(error, t('failed'));
      toast.error(problem.detail ?? problem.title);
    }
  };
  return (
    <Sheet open={open} onOpenChange={(value) => (value ? undefined : onClose())}>
      <SheetContent side="right" className="w-full overflow-y-auto p-5 sm:max-w-3xl">
        <SheetTitle className="text-lg font-semibold">{sequence ? t('editTitle') : t('newTitle')}</SheetTitle>
        <SheetDescription>{t('description')}</SheetDescription>
        <div className="mt-4 space-y-4 text-sm">
          <div className="grid gap-3 sm:grid-cols-2">
            <div className="space-y-1">
              <Label htmlFor="seq-name">{t('name')}</Label>
              <Input
                id="seq-name"
                maxLength={120}
                value={name}
                onChange={(event) => setName(event.target.value)}
              />
            </div>
            <div className="space-y-1">
              <Label htmlFor="seq-offer">{t('offer')}</Label>
              <Select value={offer} onValueChange={(value) => setOffer(value as Offer)}>
                <SelectTrigger id="seq-offer">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {OFFERS.map((value) => (
                    <SelectItem key={value} value={value}>
                      {offerName(value)}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
          </div>
          <fieldset className="grid gap-3 rounded-lg border p-3 sm:grid-cols-3">
            <legend className="px-1 text-xs font-medium">{t('rails')}</legend>
            <div className="space-y-1">
              <Label htmlFor="seq-max">{t('maxEmails')}</Label>
              <Input
                id="seq-max"
                type="number"
                min={1}
                max={4}
                value={settings.maxEmails}
                onChange={(event) => setSettings({ ...settings, maxEmails: Number(event.target.value) || 1 })}
              />
            </div>
            <div className="space-y-1">
              <Label htmlFor="seq-gap">{t('minGap')}</Label>
              <Input
                id="seq-gap"
                type="number"
                min={2}
                max={30}
                value={settings.minGapBusinessDays}
                onChange={(event) =>
                  setSettings({ ...settings, minGapBusinessDays: Number(event.target.value) || 2 })
                }
              />
            </div>
            <div className="space-y-1">
              <Label htmlFor="seq-approval">{t('approval')}</Label>
              <Select
                value={settings.approval}
                onValueChange={(value) =>
                  setSettings({ ...settings, approval: value as SequenceSettings['approval'] })
                }
              >
                <SelectTrigger id="seq-approval">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="auto_when_permitted">{t('approvalAuto')}</SelectItem>
                  <SelectItem value="always">{t('approvalAlways')}</SelectItem>
                </SelectContent>
              </Select>
            </div>
            <div className="flex flex-wrap items-center gap-3 sm:col-span-3">
              <span className="text-xs text-muted-foreground">{t('calendars')}</span>
              {HOLIDAY_CALENDARS.map((calendar) => (
                <div key={calendar} className="flex items-center gap-1 text-xs">
                  <Checkbox
                    id={`seq-cal-${calendar}`}
                    checked={settings.calendars.includes(calendar)}
                    onCheckedChange={(checked) =>
                      setSettings({
                        ...settings,
                        calendars: checked
                          ? [...settings.calendars, calendar]
                          : settings.calendars.filter((value) => value !== calendar),
                      })
                    }
                  />
                  <Label htmlFor={`seq-cal-${calendar}`} className="text-xs font-normal">
                    {calendar}
                  </Label>
                </div>
              ))}
              <div className="ml-auto flex items-center gap-1 text-xs">
                <Checkbox
                  id="seq-stop-lead"
                  checked={settings.stopOnPreviewLead}
                  onCheckedChange={(checked) =>
                    setSettings({ ...settings, stopOnPreviewLead: checked === true })
                  }
                />
                <Label htmlFor="seq-stop-lead" className="text-xs font-normal">
                  {t('stopOnLead')}
                </Label>
              </div>
            </div>
          </fieldset>
          <ol className="space-y-3">
            {steps.map((step, index) => (
              <StepEditor
                key={`${step.id}-${index}`}
                step={step}
                index={index}
                last={index === steps.length - 1}
                date={dates[index]}
                onChange={(patch) => update(index, patch)}
                onMove={(by) => move(index, by)}
                onRemove={() => setSteps((current) => current.filter((_, i) => i !== index))}
              />
            ))}
          </ol>
          <Button
            size="sm"
            variant="outline"
            onClick={() => setSteps((current) => [...current, blankStep(current.length)])}
            disabled={steps.length >= 8}
          >
            <PlusIcon aria-hidden />
            {t('addStep')}
          </Button>
          <section aria-live="polite">
            <h3 className="mb-1 text-xs font-medium">{t('timeline')}</h3>
            <p className="text-xs text-muted-foreground">
              {dates
                .map((date) => format.dateTime(date, { weekday: 'short', day: 'numeric', month: 'short' }))
                .join(' → ')}
            </p>
          </section>
          {issues.length > 0 ? (
            <ul className="space-y-1 text-xs text-destructive" aria-label={t('issues')}>
              {issues.map((issue) => (
                <li key={`${issue.path}-${issue.code}`}>{issue.message}</li>
              ))}
            </ul>
          ) : (
            <p className="text-xs text-muted-foreground">{t('railsOk')}</p>
          )}
          <div className="flex gap-2">
            <Button variant="outline" onClick={onClose}>
              {t('cancel')}
            </Button>
            <Button
              disabled={
                !name.trim() || issues.length > 0 || actions.create.isPending || actions.update.isPending
              }
              onClick={() => void save()}
            >
              {t('save')}
            </Button>
          </div>
        </div>
      </SheetContent>
    </Sheet>
  );
}

function StepEditor({
  step,
  index,
  last,
  date,
  onChange,
  onMove,
  onRemove,
}: {
  readonly step: SequenceStep;
  readonly index: number;
  readonly last: boolean;
  readonly date: Date | undefined;
  readonly onChange: (patch: Partial<SequenceStep>) => void;
  readonly onMove: (by: number) => void;
  readonly onRemove: () => void;
}) {
  const t = useTranslations('sequences.builder');
  const format = useFormatter();
  const templates = useTemplates();
  const setVariant = (v: number, patch: Partial<SequenceStep['variants'][number]>) =>
    onChange({ variants: step.variants.map((variant, i) => (i === v ? { ...variant, ...patch } : variant)) });
  return (
    <li className="space-y-2 rounded-lg border p-3">
      <div className="flex flex-wrap items-center gap-2">
        <span className="font-medium">{t('stepNumber', { number: index + 1 })}</span>
        <span className="text-xs text-muted-foreground">
          {t('wait', { days: step.wait.businessDays, time: step.wait.preferredLocalTime ?? '—' })}
          {date ? ` · ${format.dateTime(date, { weekday: 'short', day: 'numeric', month: 'short' })}` : ''}
        </span>
        <div className="ml-auto flex gap-1">
          <Button
            size="icon"
            variant="ghost"
            aria-label={t('up')}
            disabled={index === 0}
            onClick={() => onMove(-1)}
          >
            <ArrowUpIcon aria-hidden />
          </Button>
          <Button
            size="icon"
            variant="ghost"
            aria-label={t('down')}
            disabled={last}
            onClick={() => onMove(1)}
          >
            <ArrowDownIcon aria-hidden />
          </Button>
          <Button size="icon" variant="ghost" aria-label={t('remove')} onClick={onRemove}>
            <Trash2Icon aria-hidden />
          </Button>
        </div>
      </div>
      <div className="grid gap-2 sm:grid-cols-4">
        <Select
          value={step.kind}
          onValueChange={(value) => onChange({ kind: value as SequenceStep['kind'] })}
        >
          <SelectTrigger aria-label={t('kind')}>
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            {STEP_KINDS.map((kind) => (
              <SelectItem key={kind} value={kind}>
                {t(`kinds.${kind}`)}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
        <Input
          aria-label={t('waitDays')}
          type="number"
          min={0}
          max={30}
          value={step.wait.businessDays}
          onChange={(event) =>
            onChange({ wait: { ...step.wait, businessDays: Math.max(0, Number(event.target.value) || 0) } })
          }
        />
        <Input
          aria-label={t('time')}
          type="time"
          value={step.wait.preferredLocalTime ?? ''}
          onChange={(event) =>
            onChange({ wait: { ...step.wait, preferredLocalTime: event.target.value || null } })
          }
        />
        <Select
          value={step.condition}
          onValueChange={(value) => onChange({ condition: value as SequenceStep['condition'] })}
        >
          <SelectTrigger aria-label={t('condition')}>
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            {STEP_CONDITIONS.map((condition) => (
              <SelectItem key={condition} value={condition}>
                {t(`conditions.${condition}`)}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      </div>
      {step.kind === 'email' ? (
        <div className="space-y-2">
          <div className="flex flex-wrap items-center gap-3 text-xs">
            <Select
              value={step.threading}
              onValueChange={(value) => onChange({ threading: value as SequenceStep['threading'] })}
            >
              <SelectTrigger aria-label={t('threading')} className="h-8 w-48">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="reply_in_thread">{t('inThread')}</SelectItem>
                <SelectItem value="new_thread">{t('newThread')}</SelectItem>
              </SelectContent>
            </Select>
            <div className="flex items-center gap-1">
              <Checkbox
                id={`seq-skip-${index}`}
                checked={step.skipIfUnverified}
                onCheckedChange={(checked) => onChange({ skipIfUnverified: checked === true })}
              />
              <Label htmlFor={`seq-skip-${index}`} className="text-xs font-normal">
                {t('skipUnverified')}
              </Label>
            </div>
          </div>
          {step.variants.map((variant, v) => (
            <div
              key={`${variant.id}-${v}`}
              className="grid gap-2 rounded-md bg-muted/40 p-2 sm:grid-cols-[4rem_5rem_1fr]"
            >
              <Input
                aria-label={t('variantId')}
                value={variant.id}
                onChange={(event) =>
                  setVariant(v, { id: event.target.value.toLowerCase().replace(/[^a-z0-9-]/g, '') })
                }
              />
              <Input
                aria-label={t('weight')}
                type="number"
                min={0}
                max={100}
                value={variant.weight}
                onChange={(event) => setVariant(v, { weight: Number(event.target.value) || 0 })}
              />
              <div className="space-y-1">
                <Select
                  value={variant.templateId ?? 'ai'}
                  onValueChange={(value) => setVariant(v, { templateId: value === 'ai' ? null : value })}
                >
                  <SelectTrigger aria-label={t('writer')} className="h-8">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="ai">{t('aiWriter')}</SelectItem>
                    {(templates.data ?? []).map((template) => (
                      <SelectItem key={template.id} value={template.id}>
                        {template.name} · {template.locale.toUpperCase()}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
                {variant.templateId ? null : (
                  <Textarea
                    aria-label={t('instructions')}
                    rows={2}
                    maxLength={300}
                    value={variant.instructions ?? ''}
                    onChange={(event) => setVariant(v, { instructions: event.target.value })}
                  />
                )}
              </div>
            </div>
          ))}
          {step.variants.length < 4 ? (
            <Button
              size="sm"
              variant="ghost"
              onClick={() =>
                onChange({
                  variants: [
                    ...step.variants,
                    {
                      id: String.fromCharCode(97 + step.variants.length),
                      weight: 0,
                      templateId: null,
                      instructions: '',
                    },
                  ],
                })
              }
            >
              <PlusIcon aria-hidden />
              {t('addVariant')}
            </Button>
          ) : null}
        </div>
      ) : (
        <Input
          aria-label={t('taskTitle')}
          placeholder={t('taskTitle')}
          maxLength={200}
          value={step.taskTitle ?? ''}
          onChange={(event) => onChange({ taskTitle: event.target.value || null })}
        />
      )}
    </li>
  );
}
