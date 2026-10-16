import type { Locale } from '@bf/contracts';
import {
  Body,
  Button,
  Container,
  Head,
  Heading,
  Hr,
  Html,
  Preview,
  Section,
  Text,
} from '@react-email/components';
import type * as React from 'react';
import { MESSAGES } from './messages.ts';

// Harbour palette of the dashboard (BF-007), inlined: email clients ignore stylesheets.
const ink = '#1f2a37';
const lagoon = '#0f766e';
const muted = '#5b6675';

function Layout({
  locale,
  preview,
  children,
}: {
  locale: Locale;
  preview: string;
  children: React.ReactNode;
}) {
  return (
    <Html lang={locale}>
      <Head />
      <Preview>{preview}</Preview>
      <Body style={{ backgroundColor: '#f4f6f8', fontFamily: 'Arial, Helvetica, sans-serif', color: ink }}>
        <Container
          style={{ backgroundColor: '#ffffff', margin: '24px auto', padding: '32px', maxWidth: '520px' }}
        >
          <Text style={{ fontWeight: 700, color: lagoon, margin: 0 }}>Business Finder</Text>
          {children}
          <Hr style={{ borderColor: '#e2e6ea', margin: '24px 0' }} />
          <Text style={{ color: muted, fontSize: '12px' }}>{MESSAGES[locale].footer}</Text>
        </Container>
      </Body>
    </Html>
  );
}

function Cta({ href, label }: { href: string; label: string }) {
  return (
    <Section style={{ margin: '24px 0' }}>
      <Button
        href={href}
        style={{
          backgroundColor: lagoon,
          color: '#ffffff',
          padding: '12px 20px',
          borderRadius: '6px',
          fontWeight: 600,
        }}
      >
        {label}
      </Button>
    </Section>
  );
}

export function VerifyEmail({ locale, name, url }: { locale: Locale; name: string; url: string }) {
  const t = MESSAGES[locale].verify;
  return (
    <Layout locale={locale} preview={t.heading}>
      <Heading as="h1">{t.heading}</Heading>
      <Text>{t.body(name)}</Text>
      <Cta href={url} label={t.cta} />
      <Text style={{ color: muted }}>{t.expiry}</Text>
      <Text style={{ color: muted }}>{MESSAGES[locale].ignore}</Text>
    </Layout>
  );
}

export function ResetPassword({ locale, name, url }: { locale: Locale; name: string; url: string }) {
  const t = MESSAGES[locale].reset;
  return (
    <Layout locale={locale} preview={t.heading}>
      <Heading as="h1">{t.heading}</Heading>
      <Text>{t.body(name)}</Text>
      <Cta href={url} label={t.cta} />
      <Text style={{ color: muted }}>{t.expiry}</Text>
      <Text style={{ color: muted }}>{MESSAGES[locale].ignore}</Text>
    </Layout>
  );
}

export function Invitation(props: {
  locale: Locale;
  inviterName: string;
  organizationName: string;
  role: string;
  url: string;
}) {
  const t = MESSAGES[props.locale].invite;
  const role = MESSAGES[props.locale].roles[props.role] ?? props.role;
  return (
    <Layout locale={props.locale} preview={t.heading(props.organizationName)}>
      <Heading as="h1">{t.heading(props.organizationName)}</Heading>
      <Text>{t.body(props.inviterName, props.organizationName, role)}</Text>
      <Cta href={props.url} label={t.cta} />
      <Text style={{ color: muted }}>{t.expiry}</Text>
    </Layout>
  );
}

export function TwoFactorEnabled({ locale, name }: { locale: Locale; name: string }) {
  const t = MESSAGES[locale].twoFactor;
  return (
    <Layout locale={locale} preview={t.heading}>
      <Heading as="h1">{t.heading}</Heading>
      <Text>{t.body(name)}</Text>
      <Text style={{ color: '#b45309', fontWeight: 600 }}>{t.warning}</Text>
    </Layout>
  );
}

/** Generic notification email (BF-012): the notification's title and body, a link, and how to opt out. */
export function NotificationEmail({
  locale,
  title,
  body,
  url,
}: {
  locale: Locale;
  title: string;
  body: string | null;
  url: string | null;
}) {
  const t = MESSAGES[locale].notification;
  return (
    <Layout locale={locale} preview={title}>
      <Heading as="h1">{title}</Heading>
      {body ? <Text>{body}</Text> : null}
      {url ? <Cta href={url} label={t.open} /> : null}
      <Text style={{ color: muted, fontSize: '12px' }}>{t.manage}</Text>
    </Layout>
  );
}
