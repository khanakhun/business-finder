'use client';

import {
  EMAIL_PURPOSES,
  type EmailLocale,
  type EmailPurpose,
  type EmailTemplate,
  type LintIssue,
  OFFERS,
  type Offer,
  TEMPLATE_VARIABLE_NAMES,
} from '@bf/contracts';
import { Badge } from '@bf/ui/components/badge';
import { Button } from '@bf/ui/components/button';
import { EmptyState } from '@bf/ui/components/empty-state';
import { ErrorState } from '@bf/ui/components/error-state';
import { Input } from '@bf/ui/components/input';
import { Label } from '@bf/ui/components/label';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@bf/ui/components/select';
import { Sheet, SheetContent, SheetDescription, SheetTitle } from '@bf/ui/components/sheet';
import { Skeleton } from '@bf/ui/components/skeleton';
import { Textarea } from '@bf/ui/components/textarea';
import { FileTextIcon, PlusIcon } from 'lucide-react';
import { useFormatter, useTranslations } from 'next-intl';
import * as React from 'react';
import { toProblemLike, useErrorLabels } from '@/components/states/problem.ts';
import { usePermission } from '@/lib/session.tsx';
import { getToast } from '@/lib/toast.tsx';
import { useTemplateActions, useTemplates, useTemplateVersions } from '../api.ts';

// Outreach → Templates (BF-051): the seeded EN/FR library and the workspace's own, by purpose; edit as a new version
// (a seed becomes the workspace's copy), live lint, insert variables, versions and archive.

export function TemplatesPage() {
  const t = useTranslations('templatesPage');
  const purposeName = useTranslations('templatesPage.purposes');
  const errorLabels = useErrorLabels();
  const canManage = usePermission('templates:manage');
  const templates = useTemplates();
  const [editing, setEditing] = React.useState<EmailTemplate | 'new' | null>(null);
  if (templates.isError)
    return (
      <ErrorState
        problem={toProblemLike(templates.error, t('loadError'))}
        labels={errorLabels}
        onRetry={() => void templates.refetch()}
      />
    );
  if (!templates.data) return <Skeleton className="h-64 w-full" />;
  return (
    <div className="space-y-6">
      {canManage ? (
        <div className="flex justify-end">
          <Button size="sm" onClick={() => setEditing('new')}>
            <PlusIcon aria-hidden />
            {t('new')}
          </Button>
        </div>
      ) : null}
      {templates.data.length === 0 ? (
        <EmptyState
          icon={<FileTextIcon aria-hidden />}
          title={t('emptyTitle')}
          description={t('emptyBody')}
        />
      ) : (
        EMAIL_PURPOSES.map((purpose) => {
          const items = templates.data.filter((item) => item.purpose === purpose);
          if (items.length === 0) return null;
          return (
            <section key={purpose} className="space-y-2">
              <h2 className="text-base font-semibold">{purposeName(purpose)}</h2>
              <ul className="grid gap-2 md:grid-cols-2">
                {items.map((item) => (
                  <li key={item.id}>
                    <button
                      type="button"
                      onClick={() => setEditing(item)}
                      className="w-full space-y-1 rounded-lg border p-3 text-left text-sm hover:bg-muted/50"
                    >
                      <span className="flex flex-wrap items-center gap-2">
                        <span className="font-medium">{item.name}</span>
                        <Badge variant="outline">{item.locale.toUpperCase()}</Badge>
                        <Badge variant="secondary">
                          {item.seeded ? t('seeded') : t('version', { version: item.version })}
                        </Badge>
                      </span>
                      <span className="block truncate text-xs text-muted-foreground">
                        {item.subjectVariants[0]}
                      </span>
                    </button>
                  </li>
                ))}
              </ul>
            </section>
          );
        })
      )}
      <Sheet open={editing !== null} onOpenChange={(open) => (open ? undefined : setEditing(null))}>
        <SheetContent side="right" className="w-full overflow-y-auto p-5 sm:max-w-3xl">
          <SheetTitle className="text-lg font-semibold">
            {editing === 'new' ? t('new') : editing?.name}
          </SheetTitle>
          <SheetDescription className="sr-only">{t('editorHint')}</SheetDescription>
          {editing ? (
            <TemplateEditor
              key={editing === 'new' ? 'new' : editing.id}
              template={editing === 'new' ? null : editing}
              canManage={canManage}
              onDone={() => setEditing(null)}
            />
          ) : null}
        </SheetContent>
      </Sheet>
    </div>
  );
}

function TemplateEditor({
  template,
  canManage,
  onDone,
}: {
  readonly template: EmailTemplate | null;
  readonly canManage: boolean;
  readonly onDone: () => void;
}) {
  const t = useTranslations('templatesPage');
  const purposeName = useTranslations('templatesPage.purposes');
  const offerName = useTranslations('composer.offers');
  const format = useFormatter();
  const actions = useTemplateActions();
  const versions = useTemplateVersions(template?.id ?? null);
  const [name, setName] = React.useState(template?.name ?? '');
  const [purpose, setPurpose] = React.useState<EmailPurpose>(template?.purpose ?? 'first_touch');
  const [offer, setOffer] = React.useState<Offer>(template?.offer ?? 'website_redesign');
  const [locale, setLocale] = React.useState<EmailLocale>(template?.locale ?? 'fr');
  const [subjects, setSubjects] = React.useState((template?.subjectVariants ?? ['']).join('\n'));
  const [body, setBody] = React.useState(template?.bodyMd ?? '');
  const [issues, setIssues] = React.useState<LintIssue[]>(template?.lint ?? []);
  const bodyRef = React.useRef<HTMLTextAreaElement>(null);
  const lint = actions.lint.mutateAsync;
  const request = React.useCallback(
    () => ({
      name,
      purpose,
      offer,
      locale,
      subjectVariants: subjects
        .split('\n')
        .map((line) => line.trim())
        .filter(Boolean),
      bodyMd: body,
    }),
    [name, purpose, offer, locale, subjects, body],
  );
  React.useEffect(() => {
    if (!canManage || body.trim().length < 10 || name.trim().length < 2) return;
    const handle = setTimeout(() => {
      lint(request())
        .then((result) => setIssues(result.issues))
        .catch(() => undefined);
    }, 600);
    return () => clearTimeout(handle);
  }, [request, canManage, body, name, lint]);
  const insert = (variable: string) => {
    const area = bodyRef.current;
    const tag = `{{${variable}}}`;
    if (!area) {
      setBody(`${body}${tag}`);
      return;
    }
    setBody(`${body.slice(0, area.selectionStart)}${tag}${body.slice(area.selectionEnd)}`);
  };
  const save = async () => {
    const toast = await getToast();
    try {
      if (template) await actions.saveVersion.mutateAsync({ id: template.id, body: request() });
      else await actions.create.mutateAsync(request());
      toast.success(t('saved'));
      onDone();
    } catch (error) {
      const problem = toProblemLike(error, t('failed'));
      toast.error(problem.detail ?? problem.title);
    }
  };
  const archive = async () => {
    if (!template) return;
    const toast = await getToast();
    try {
      await actions.archive.mutateAsync(template.id);
      toast.success(t('archived'));
      onDone();
    } catch (error) {
      toast.error(toProblemLike(error, t('failed')).title);
    }
  };
  const readOnly = !canManage;
  return (
    <div className="space-y-4 text-sm">
      {template?.seeded ? <p className="rounded-md bg-muted/60 p-2 text-xs">{t('seedHint')}</p> : null}
      <div className="grid gap-3 sm:grid-cols-2">
        <div className="space-y-1">
          <Label htmlFor="tpl-name">{t('name')}</Label>
          <Input
            id="tpl-name"
            value={name}
            readOnly={readOnly}
            maxLength={120}
            onChange={(event) => setName(event.target.value)}
          />
        </div>
        <div className="space-y-1">
          <Label htmlFor="tpl-purpose">{t('purpose')}</Label>
          <Select
            value={purpose}
            onValueChange={(value) => setPurpose(value as EmailPurpose)}
            disabled={readOnly}
          >
            <SelectTrigger id="tpl-purpose">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {EMAIL_PURPOSES.map((value) => (
                <SelectItem key={value} value={value}>
                  {purposeName(value)}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>
        <div className="space-y-1">
          <Label htmlFor="tpl-offer">{t('offer')}</Label>
          <Select value={offer} onValueChange={(value) => setOffer(value as Offer)} disabled={readOnly}>
            <SelectTrigger id="tpl-offer">
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
        <div className="space-y-1">
          <Label htmlFor="tpl-locale">{t('language')}</Label>
          <Select
            value={locale}
            onValueChange={(value) => setLocale(value as EmailLocale)}
            disabled={readOnly || template !== null}
          >
            <SelectTrigger id="tpl-locale">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="fr">{t('locale.fr')}</SelectItem>
              <SelectItem value="en">{t('locale.en')}</SelectItem>
            </SelectContent>
          </Select>
        </div>
      </div>
      <div className="space-y-1">
        <Label htmlFor="tpl-subjects">{t('subjects')}</Label>
        <Textarea
          id="tpl-subjects"
          rows={3}
          readOnly={readOnly}
          value={subjects}
          onChange={(event) => setSubjects(event.target.value)}
        />
      </div>
      <div className="space-y-1">
        <Label htmlFor="tpl-body">{t('body')}</Label>
        {canManage ? (
          <fieldset className="flex flex-wrap gap-1">
            <legend className="sr-only">{t('variables')}</legend>
            {TEMPLATE_VARIABLE_NAMES.map((variable) => (
              <button
                key={variable}
                type="button"
                className="rounded border px-1.5 py-0.5 font-mono text-[11px] hover:bg-muted"
                onClick={() => insert(variable)}
              >
                {variable}
              </button>
            ))}
          </fieldset>
        ) : null}
        <Textarea
          ref={bodyRef}
          id="tpl-body"
          rows={16}
          readOnly={readOnly}
          className="font-mono text-xs"
          value={body}
          onChange={(event) => setBody(event.target.value)}
        />
        <p className="text-xs text-muted-foreground">{t('syntaxHint')}</p>
      </div>
      {issues.length > 0 ? (
        <ul className="space-y-1 text-xs">
          {issues.map((issue) => (
            <li
              key={`${issue.code}-${issue.message}`}
              className={
                issue.severity === 'error' ? 'text-destructive' : 'text-amber-700 dark:text-amber-300'
              }
            >
              {issue.message}
            </li>
          ))}
        </ul>
      ) : null}
      {canManage ? (
        <div className="flex flex-wrap gap-2">
          <Button
            size="sm"
            disabled={
              actions.create.isPending ||
              actions.saveVersion.isPending ||
              issues.some((issue) => issue.severity === 'error')
            }
            onClick={() => void save()}
          >
            {template ? t('saveVersion') : t('create')}
          </Button>
          {template ? (
            <Button size="sm" variant="ghost" onClick={() => void archive()}>
              {t('archive')}
            </Button>
          ) : null}
        </div>
      ) : null}
      {template && versions.data && versions.data.length > 1 ? (
        <section className="space-y-1">
          <h3 className="font-medium">{t('versions')}</h3>
          <ul className="space-y-0.5 text-xs text-muted-foreground">
            {versions.data.map((version) => (
              <li key={version.id}>
                {t('version', { version: version.version })} ·{' '}
                {format.dateTime(new Date(version.createdAt), { dateStyle: 'medium' })}
                {version.seeded ? ` · ${t('seeded')}` : ''}
              </li>
            ))}
          </ul>
        </section>
      ) : null}
    </div>
  );
}
