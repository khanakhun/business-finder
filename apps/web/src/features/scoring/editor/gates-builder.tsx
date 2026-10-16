'use client';

import { FEATURE_DEFINITIONS, FEATURE_KEYS, type FeatureKey } from '@bf/contracts';
import { Button } from '@bf/ui/components/button';
import { Input } from '@bf/ui/components/input';
import { Label } from '@bf/ui/components/label';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@bf/ui/components/select';
import { PlusIcon, Trash2Icon, XIcon } from 'lucide-react';
import { useTranslations } from 'next-intl';
import { type GateDraft, type Operator, operatorsFor, type Rule, ruleToLeaf } from './gates.ts';

// Gates (BF-032): rules over features that exclude a business (tier X) or cap its score, each with an EN/FR reason.
// A gate the builder cannot show is kept read-only.

type Locale = 'en' | 'fr';
type RulesGate = Extract<GateDraft, { mode: 'rules' }>;

const newGate = (n: number): GateDraft => ({
  id: `gate_${n}`,
  effect: { type: 'exclude' },
  reason: { en: '', fr: '' },
  mode: 'rules',
  match: 'all',
  rules: [{ feature: 'operating_status', op: 'eq', value: 'closed_permanently' }],
});

function ValueInput({
  rule,
  id,
  onChange,
  readOnly,
  locale,
}: {
  readonly rule: Rule;
  readonly id: string;
  readonly onChange: (value: string) => void;
  readonly readOnly: boolean;
  readonly locale: Locale;
}) {
  const t = useTranslations('scoringEditor.gates');
  const { type, values } = FEATURE_DEFINITIONS[rule.feature];
  if (rule.op === 'isNull') return <span />;
  const choices =
    type === 'boolean' ? ['true', 'false'] : type === 'enum' && rule.op !== 'in' ? [...(values ?? [])] : null;
  if (choices) {
    return (
      <Select value={rule.value} disabled={readOnly} onValueChange={onChange}>
        <SelectTrigger id={id} className="w-48" aria-label={t('value')}>
          <SelectValue placeholder={t('value')} />
        </SelectTrigger>
        <SelectContent>
          {choices.map((choice) => (
            <SelectItem key={choice} value={choice}>
              {type === 'boolean' ? t(choice as 'true' | 'false') : choice}
            </SelectItem>
          ))}
        </SelectContent>
      </Select>
    );
  }
  return (
    <Input
      id={id}
      value={rule.value}
      disabled={readOnly}
      aria-label={t('value')}
      aria-invalid={ruleToLeaf(rule) === null}
      placeholder={
        rule.op === 'in'
          ? (values ?? []).slice(0, 2).join(', ')
          : FEATURE_DEFINITIONS[rule.feature].label[locale]
      }
      className="w-48"
      onChange={(event) => onChange(event.target.value)}
    />
  );
}

function RulesEditor({
  gate,
  index,
  onChange,
  readOnly,
  locale,
}: {
  readonly gate: RulesGate;
  readonly index: number;
  readonly onChange: (gate: GateDraft) => void;
  readonly readOnly: boolean;
  readonly locale: Locale;
}) {
  const t = useTranslations('scoringEditor.gates');
  const setRule = (i: number, rule: Rule) =>
    onChange({ ...gate, rules: gate.rules.map((current, j) => (j === i ? rule : current)) });
  return (
    <div className="grid gap-2">
      <div className="flex items-center gap-2 text-sm">
        <span>{t('when')}</span>
        <Select
          value={gate.match}
          disabled={readOnly}
          onValueChange={(match) => onChange({ ...gate, match: match as 'all' | 'any' })}
        >
          <SelectTrigger className="w-40" aria-label={t('match')}>
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="all">{t('all')}</SelectItem>
            <SelectItem value="any">{t('any')}</SelectItem>
          </SelectContent>
        </Select>
      </div>
      <ul className="grid gap-2">
        {gate.rules.map((rule, i) => (
          <li key={i} className="flex flex-wrap items-center gap-2" data-testid={`gate-${index}-rule-${i}`}>
            <Select
              value={rule.feature}
              disabled={readOnly}
              onValueChange={(feature) => {
                const key = feature as FeatureKey;
                const op = operatorsFor(key).includes(rule.op) ? rule.op : (operatorsFor(key)[0] as Operator);
                setRule(i, { feature: key, op, value: '' });
              }}
            >
              <SelectTrigger className="w-56" aria-label={t('feature')}>
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {FEATURE_KEYS.map((key) => (
                  <SelectItem key={key} value={key}>
                    {FEATURE_DEFINITIONS[key].label[locale]}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
            <Select
              value={rule.op}
              disabled={readOnly}
              onValueChange={(op) => setRule(i, { ...rule, op: op as Operator })}
            >
              <SelectTrigger className="w-40" aria-label={t('operator')}>
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {operatorsFor(rule.feature).map((op) => (
                  <SelectItem key={op} value={op}>
                    {t(`operators.${op}`)}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
            <ValueInput
              rule={rule}
              id={`gate-${index}-value-${i}`}
              readOnly={readOnly}
              locale={locale}
              onChange={(value) => setRule(i, { ...rule, value })}
            />
            {!readOnly && gate.rules.length > 1 ? (
              <Button
                type="button"
                variant="ghost"
                size="icon"
                aria-label={t('removeRule')}
                onClick={() => onChange({ ...gate, rules: gate.rules.filter((_, j) => j !== i) })}
              >
                <XIcon aria-hidden />
              </Button>
            ) : null}
          </li>
        ))}
      </ul>
      {!readOnly ? (
        <Button
          type="button"
          variant="outline"
          size="sm"
          className="justify-self-start"
          onClick={() =>
            onChange({
              ...gate,
              rules: [...gate.rules, { feature: 'has_website', op: 'eq', value: 'false' }],
            })
          }
        >
          <PlusIcon aria-hidden />
          {t('addRule')}
        </Button>
      ) : null}
    </div>
  );
}

export function GatesBuilder({
  gates,
  onChange,
  locale,
  readOnly,
}: {
  readonly gates: readonly GateDraft[];
  readonly onChange: (gates: readonly GateDraft[]) => void;
  readonly locale: Locale;
  readonly readOnly: boolean;
}) {
  const t = useTranslations('scoringEditor.gates');
  const set = (i: number, gate: GateDraft) => onChange(gates.map((current, j) => (j === i ? gate : current)));
  return (
    <div className="grid gap-4">
      <p className="text-sm text-muted-foreground">{t('help')}</p>
      {gates.length === 0 ? <p className="text-sm text-muted-foreground">{t('none')}</p> : null}
      <ol className="grid gap-4">
        {gates.map((gate, i) => (
          <li key={i} className="grid gap-3 rounded-md border p-3" data-testid={`gate-${i}`}>
            <div className="flex flex-wrap items-end gap-3">
              <div className="grid gap-1">
                <Label htmlFor={`gate-${i}-id`} className="text-xs text-muted-foreground">
                  {t('id')}
                </Label>
                <Input
                  id={`gate-${i}-id`}
                  value={gate.id}
                  disabled={readOnly}
                  className="w-48 font-mono"
                  onChange={(event) => set(i, { ...gate, id: event.target.value })}
                />
              </div>
              <div className="grid gap-1">
                <Label className="text-xs text-muted-foreground" htmlFor={`gate-${i}-effect`}>
                  {t('effect')}
                </Label>
                <Select
                  value={gate.effect.type}
                  disabled={readOnly}
                  onValueChange={(type) =>
                    set(i, {
                      ...gate,
                      effect: type === 'cap' ? { type: 'cap', max: 40 } : { type: 'exclude' },
                    })
                  }
                >
                  <SelectTrigger id={`gate-${i}-effect`} className="w-40">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="exclude">{t('exclude')}</SelectItem>
                    <SelectItem value="cap">{t('cap')}</SelectItem>
                  </SelectContent>
                </Select>
              </div>
              {gate.effect.type === 'cap' ? (
                <div className="grid gap-1">
                  <Label htmlFor={`gate-${i}-max`} className="text-xs text-muted-foreground">
                    {t('capMax')}
                  </Label>
                  <Input
                    id={`gate-${i}-max`}
                    type="number"
                    min={0}
                    max={100}
                    value={gate.effect.max}
                    disabled={readOnly}
                    className="w-24"
                    onChange={(event) =>
                      set(i, { ...gate, effect: { type: 'cap', max: Number(event.target.value) } })
                    }
                  />
                </div>
              ) : null}
              {!readOnly ? (
                <Button
                  type="button"
                  variant="ghost"
                  size="icon"
                  className="ml-auto"
                  aria-label={t('remove', { id: gate.id })}
                  onClick={() => onChange(gates.filter((_, j) => j !== i))}
                >
                  <Trash2Icon aria-hidden />
                </Button>
              ) : null}
            </div>
            {gate.mode === 'rules' ? (
              <RulesEditor
                gate={gate}
                index={i}
                onChange={(next) => set(i, next)}
                readOnly={readOnly}
                locale={locale}
              />
            ) : (
              <div className="grid gap-1">
                <p className="text-sm text-muted-foreground">{t('advanced')}</p>
                <pre className="overflow-x-auto rounded bg-muted p-2 text-xs">
                  {JSON.stringify(gate.when, null, 2)}
                </pre>
              </div>
            )}
            <div className="grid gap-2 sm:grid-cols-2">
              {(['en', 'fr'] as const).map((language) => (
                <div key={language} className="grid gap-1">
                  <Label htmlFor={`gate-${i}-reason-${language}`} className="text-xs text-muted-foreground">
                    {t(`reason.${language}`)}
                  </Label>
                  <Input
                    id={`gate-${i}-reason-${language}`}
                    value={gate.reason[language]}
                    maxLength={300}
                    disabled={readOnly}
                    onChange={(event) =>
                      set(i, { ...gate, reason: { ...gate.reason, [language]: event.target.value } })
                    }
                  />
                </div>
              ))}
            </div>
          </li>
        ))}
      </ol>
      {!readOnly ? (
        <Button
          type="button"
          variant="outline"
          className="justify-self-start"
          onClick={() => onChange([...gates, newGate(gates.length + 1)])}
        >
          <PlusIcon aria-hidden />
          {t('add')}
        </Button>
      ) : null}
    </div>
  );
}
