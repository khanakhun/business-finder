'use client';

import { type Contact, type EmailDraft, type EmailLocale, OFFERS, type Offer } from '@bf/contracts';
import { Badge } from '@bf/ui/components/badge';
import { Button } from '@bf/ui/components/button';
import { Label } from '@bf/ui/components/label';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@bf/ui/components/select';
import { Sheet, SheetContent, SheetDescription, SheetTitle } from '@bf/ui/components/sheet';
import { Skeleton } from '@bf/ui/components/skeleton';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@bf/ui/components/tabs';
import { Textarea } from '@bf/ui/components/textarea';
import { cn } from '@bf/ui/lib/utils';
import { CopyIcon, LanguagesIcon, SparklesIcon, WandIcon } from 'lucide-react';
import { useTranslations } from 'next-intl';
import * as React from 'react';
import { toProblemLike } from '@/components/states/problem.ts';
import { useContacts } from '@/features/business/api.ts';
import { useEvaluation } from '@/features/compliance/api.ts';
import { CompliancePanel } from '@/features/compliance/compliance-panel.tsx';
import { useMailboxes } from '@/features/mailboxes/api.ts';
import { getToast } from '@/lib/toast.tsx';
import { useDraftActions, useDraftPreview, useTemplates } from '../api.ts';
import { SendButton } from '../send/send-button.tsx';
import { closeComposer, useComposerTarget } from './store.ts';

// The email composer (BF-051): pick the recipient (with its verification and today's compliance decision — a
// blocked contact is not selectable and its alternatives are shown), the mailbox, the language, the offer and a
// template; generate (AI, grounded) or fill the template; pick a subject; edit with the cited facts and lint
// beside; preview the final message (signature and footer included); send it with an undo window (BF-052).

const QUICK = ['shorter', 'formal', 'mentionPreview', 'booking'] as const;
const AUTO = 'auto';

export function ComposerHost() {
  const target = useComposerTarget();
  const t = useTranslations('composer');
  return (
    <Sheet open={target !== null} onOpenChange={(open) => (open ? undefined : closeComposer())}>
      <SheetContent side="right" className="w-full overflow-y-auto p-5 sm:max-w-4xl">
        <SheetTitle className="text-lg font-semibold">
          {t('title', { business: target?.businessName ?? '' })}
        </SheetTitle>
        <SheetDescription className="sr-only">{t('hint')}</SheetDescription>
        {target ? (
          <Composer
            key={target.businessId}
            businessId={target.businessId}
            initialContactId={target.contactId}
          />
        ) : null}
      </SheetContent>
    </Sheet>
  );
}

function Composer({
  businessId,
  initialContactId,
}: {
  readonly businessId: string;
  readonly initialContactId?: string | undefined;
}) {
  const t = useTranslations('composer');
  const offerName = useTranslations('composer.offers');
  const contacts = useContacts(businessId);
  const mailboxes = useMailboxes();
  const templates = useTemplates();
  const actions = useDraftActions();
  const emails = (contacts.data?.items ?? []).filter((contact) => contact.type === 'email');
  const [contactId, setContactId] = React.useState<string | undefined>(initialContactId);
  const chosenContact = contactId ?? emails[0]?.id;
  const [offer, setOffer] = React.useState<Offer>('website_redesign');
  const [mailboxId, setMailboxId] = React.useState<string>(AUTO);
  const [locale, setLocale] = React.useState<EmailLocale | typeof AUTO>(AUTO);
  const [templateId, setTemplateId] = React.useState<string>(AUTO);
  const [draft, setDraft] = React.useState<EmailDraft | null>(null);
  const evaluation = useEvaluation(businessId, 'email', offer, chosenContact !== undefined, chosenContact);
  const blocked = evaluation.data?.decision === 'blocked';

  const run = async (action: () => Promise<EmailDraft>) => {
    const toast = await getToast();
    try {
      setDraft(await action());
    } catch (error) {
      const problem = toProblemLike(error, t('failed'));
      toast.error(problem.detail ?? problem.title);
    }
  };
  const create = (mode: 'ai' | 'template', instructions?: string) =>
    run(() =>
      actions.create.mutateAsync({
        businessId: businessId as never,
        contactId: chosenContact ?? null,
        offer,
        purpose: 'first_touch',
        mode,
        ...(templateId !== AUTO ? { templateId } : {}),
        ...(locale !== AUTO ? { locale } : {}),
        ...(mailboxId !== AUTO ? { mailboxId } : {}),
        ...(instructions ? { instructions } : {}),
      }),
    );
  const busy = actions.create.isPending || actions.regenerate.isPending || actions.translate.isPending;

  return (
    <div className="grid gap-5 lg:grid-cols-[18rem_1fr]">
      <aside className="space-y-4 text-sm">
        <Field id="cmp-contact" label={t('recipient')}>
          {contacts.isLoading ? (
            <Skeleton className="h-9 w-full" />
          ) : emails.length === 0 ? (
            <p className="text-muted-foreground">{t('noEmail')}</p>
          ) : (
            <Select value={chosenContact} onValueChange={setContactId}>
              <SelectTrigger id="cmp-contact">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {emails.map((contact) => (
                  <SelectItem key={contact.id} value={contact.id}>
                    <ContactLabel contact={contact} />
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          )}
        </Field>
        {evaluation.data ? (
          <div className="rounded-lg border p-2">
            <CompliancePanel decision={evaluation.data} />
          </div>
        ) : null}
        <Field id="cmp-mailbox" label={t('mailbox')}>
          <Select value={mailboxId} onValueChange={setMailboxId}>
            <SelectTrigger id="cmp-mailbox">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value={AUTO}>{t('autoMailbox')}</SelectItem>
              {(mailboxes.data ?? []).map((mailbox) => (
                <SelectItem key={mailbox.id} value={mailbox.id}>
                  {mailbox.email}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </Field>
        <div className="grid grid-cols-2 gap-2">
          <Field id="cmp-locale" label={t('language')}>
            <Select value={locale} onValueChange={(value) => setLocale(value as EmailLocale | typeof AUTO)}>
              <SelectTrigger id="cmp-locale">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value={AUTO}>{t('autoLanguage')}</SelectItem>
                <SelectItem value="fr">{t('locale.fr')}</SelectItem>
                <SelectItem value="en">{t('locale.en')}</SelectItem>
              </SelectContent>
            </Select>
          </Field>
          <Field id="cmp-offer" label={t('offer')}>
            <Select value={offer} onValueChange={(value) => setOffer(value as Offer)}>
              <SelectTrigger id="cmp-offer">
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
          </Field>
        </div>
        <Field id="cmp-template" label={t('template')}>
          <Select value={templateId} onValueChange={setTemplateId}>
            <SelectTrigger id="cmp-template">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value={AUTO}>{t('autoTemplate')}</SelectItem>
              {(templates.data ?? [])
                .filter((template) => template.purpose === 'first_touch')
                .map((template) => (
                  <SelectItem key={template.id} value={template.id}>
                    {template.name} · {template.locale.toUpperCase()}
                  </SelectItem>
                ))}
            </SelectContent>
          </Select>
        </Field>
        <div className="flex flex-wrap gap-2">
          <Button
            size="sm"
            disabled={busy || blocked || emails.length === 0}
            onClick={() => void create('ai')}
          >
            <SparklesIcon aria-hidden />
            {draft ? t('newDraft') : t('generate')}
          </Button>
          <Button
            size="sm"
            variant="outline"
            disabled={busy || blocked || emails.length === 0}
            onClick={() => void create('template')}
          >
            {t('fromTemplate')}
          </Button>
        </div>
        {blocked ? <p className="text-xs text-destructive">{t('blocked')}</p> : null}
      </aside>
      <section className="min-w-0 space-y-3">
        {busy && !draft ? <Skeleton className="h-80 w-full" /> : null}
        {draft ? (
          <DraftEditor draft={draft} onChange={setDraft} busy={busy} decision={evaluation.data?.decision} />
        ) : !busy ? (
          <p className="text-sm text-muted-foreground">{t('empty')}</p>
        ) : null}
      </section>
    </div>
  );
}

function ContactLabel({ contact }: { readonly contact: Contact }) {
  const t = useTranslations('composer');
  return (
    <span className="flex items-center gap-2">
      {contact.value}
      {contact.verificationStatus !== 'unknown' ? (
        <Badge variant="outline" className="text-[10px]">
          {t(`verification.${contact.verificationStatus}` as never)}
        </Badge>
      ) : null}
    </span>
  );
}

function DraftEditor({
  draft,
  onChange,
  busy,
  decision,
}: {
  readonly draft: EmailDraft;
  readonly onChange: (draft: EmailDraft) => void;
  readonly busy: boolean;
  /** Today's compliance decision for the recipient (the Send button adapts to it). */
  readonly decision: string | undefined;
}) {
  const t = useTranslations('composer');
  const actions = useDraftActions();
  const [subject, setSubject] = React.useState(draft.subject);
  const [body, setBody] = React.useState(draft.bodyMd);
  React.useEffect(() => {
    setSubject(draft.subject);
    setBody(draft.bodyMd);
  }, [draft.subject, draft.bodyMd]);
  const dirty = subject !== draft.subject || body !== draft.bodyMd;
  const preview = useDraftPreview(dirty ? null : draft);
  const save = async () => {
    const toast = await getToast();
    try {
      onChange(await actions.update.mutateAsync({ id: draft.id, body: { subject, bodyMd: body } }));
      toast.success(t('saved'));
    } catch (error) {
      const problem = toProblemLike(error, t('failed'));
      toast.error(problem.detail ?? problem.title);
    }
  };
  const regenerate = async (instructions?: string) => {
    const toast = await getToast();
    try {
      onChange(
        await actions.regenerate.mutateAsync({ id: draft.id, ...(instructions ? { instructions } : {}) }),
      );
    } catch (error) {
      toast.error(toProblemLike(error, t('failed')).title);
    }
  };
  const translate = async () => {
    const toast = await getToast();
    try {
      onChange(
        await actions.translate.mutateAsync({ id: draft.id, locale: draft.locale === 'fr' ? 'en' : 'fr' }),
      );
    } catch (error) {
      toast.error(toProblemLike(error, t('failed')).title);
    }
  };
  const copy = async () => {
    const toast = await getToast();
    const text = preview.data?.text ?? body;
    await navigator.clipboard.writeText(`${preview.data?.subject ?? subject}\n\n${text}`);
    toast.success(t('copied'));
  };
  const errors = draft.lint.filter((issue) => issue.severity === 'error');
  const warnings = draft.lint.filter((issue) => issue.severity === 'warning');
  return (
    <div className="space-y-3">
      <div className="flex flex-wrap items-center gap-2">
        <Badge variant="secondary">{t(`source.${draft.generatedBy}`)}</Badge>
        <Badge variant="outline">{draft.locale.toUpperCase()}</Badge>
        <div className="ml-auto flex flex-wrap gap-1">
          {QUICK.map((quick) => (
            <Button
              key={quick}
              size="sm"
              variant="ghost"
              disabled={busy}
              onClick={() => void regenerate(t(`quick.${quick}`))}
            >
              <WandIcon aria-hidden />
              {t(`quickLabel.${quick}`)}
            </Button>
          ))}
          <Button size="sm" variant="ghost" disabled={busy} onClick={() => void translate()}>
            <LanguagesIcon aria-hidden />
            {draft.locale === 'fr' ? t('toEnglish') : t('toFrench')}
          </Button>
        </div>
      </div>
      <fieldset className="space-y-1">
        <legend className="text-sm font-medium">{t('subject')}</legend>
        <div className="flex flex-wrap gap-1">
          {draft.subjectVariants.map((variant) => (
            <button
              key={variant}
              type="button"
              aria-pressed={variant === subject}
              onClick={() => setSubject(variant)}
              className={cn(
                'rounded-full border px-3 py-1 text-xs',
                variant === subject ? 'border-primary bg-primary text-primary-foreground' : 'hover:bg-muted',
              )}
            >
              {variant}
            </button>
          ))}
        </div>
        <input
          aria-label={t('subject')}
          className="mt-1 w-full rounded-md border bg-background px-3 py-2 text-sm"
          value={subject}
          maxLength={150}
          onChange={(event) => setSubject(event.target.value)}
        />
      </fieldset>
      <Tabs defaultValue="edit">
        <TabsList>
          <TabsTrigger value="edit">{t('edit')}</TabsTrigger>
          <TabsTrigger value="preview" disabled={dirty}>
            {t('preview')}
          </TabsTrigger>
          <TabsTrigger value="text" disabled={dirty}>
            {t('plainText')}
          </TabsTrigger>
        </TabsList>
        <TabsContent value="edit" className="grid gap-3 xl:grid-cols-[1fr_16rem]">
          <Textarea
            aria-label={t('body')}
            rows={16}
            className="font-mono text-sm"
            value={body}
            onChange={(event) => setBody(event.target.value)}
          />
          <div className="space-y-3 text-xs">
            <section>
              <h3 className="mb-1 font-medium">{t('factsUsed')}</h3>
              {draft.factsUsed.length === 0 ? (
                <p className="text-muted-foreground">{t('noFacts')}</p>
              ) : (
                <ul className="space-y-1">
                  {draft.factsUsed.map((fact) => (
                    <li key={fact.id} title={fact.id} className="rounded border p-1">
                      <span className="text-muted-foreground">{t(`factKind.${fact.kind}`)}</span> {fact.label}
                    </li>
                  ))}
                </ul>
              )}
            </section>
            {errors.length + warnings.length > 0 ? (
              <section>
                <h3 className="mb-1 font-medium">{t('checks')}</h3>
                <ul className="space-y-1">
                  {[...errors, ...warnings].map((issue) => (
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
              </section>
            ) : null}
          </div>
        </TabsContent>
        <TabsContent value="preview">
          {preview.data ? (
            <iframe
              title={t('preview')}
              sandbox=""
              className="h-[32rem] w-full rounded-md border bg-white"
              srcDoc={preview.data.html}
            />
          ) : (
            <Skeleton className="h-96 w-full" />
          )}
        </TabsContent>
        <TabsContent value="text">
          {preview.data ? (
            <pre className="max-h-[32rem] overflow-auto whitespace-pre-wrap rounded-md border p-3 text-xs">
              {`${preview.data.subject}\n\n${preview.data.text}`}
            </pre>
          ) : (
            <Skeleton className="h-96 w-full" />
          )}
        </TabsContent>
      </Tabs>
      <div className="flex flex-wrap gap-2">
        <Button
          size="sm"
          variant="outline"
          disabled={!dirty || actions.update.isPending}
          onClick={() => void save()}
        >
          {t('save')}
        </Button>
        <Button size="sm" variant="outline" onClick={() => void copy()}>
          <CopyIcon aria-hidden />
          {t('copy')}
        </Button>
        <SendButton
          draft={draft}
          decision={decision}
          disabled={dirty || errors.length > 0 || busy}
          copyText={() => `${preview.data?.subject ?? subject}\n\n${preview.data?.text ?? body}`}
        />
      </div>
    </div>
  );
}

function Field({
  id,
  label,
  children,
}: {
  readonly id: string;
  readonly label: string;
  readonly children: React.ReactNode;
}) {
  return (
    <div className="space-y-1">
      <Label htmlFor={id}>{label}</Label>
      {children}
    </div>
  );
}
