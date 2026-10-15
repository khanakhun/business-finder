import { describe, expect, it } from 'vitest';
import { EmailAddress } from './email-address.ts';
import {
  classifyEmail,
  FREE_MAIL_DOMAINS,
  isDisposableDomain,
  isFreeMailDomain,
  matchesWebsiteDomain,
} from './email-classification.ts';

describe('email subtype (FR/EN role addresses)', () => {
  it.each([
    // English
    ['info', 'generic'],
    ['contact', 'generic'],
    ['hello', 'generic'],
    ['sales', 'generic'],
    ['booking', 'generic'],
    ['reservations', 'generic'],
    ['admin', 'generic'],
    ['office', 'generic'],
    ['support', 'generic'],
    ['accounting', 'department'],
    ['billing', 'department'],
    ['careers', 'department'],
    ['press', 'department'],
    // French
    ['bonjour', 'generic'],
    ['ventes', 'generic'],
    ['reservation', 'generic'],
    ['resa', 'generic'],
    ['bureau', 'generic'],
    ['accueil', 'generic'],
    ['commande', 'generic'],
    ['compta', 'department'],
    ['comptabilite', 'department'],
    ['facturation', 'department'],
    ['recrutement', 'department'],
    ['presse', 'department'],
    // Variants
    ['info2', 'generic'],
    ['contact+web', 'generic'],
    // People and the rest
    ['marie.lefevre', 'personal'],
    ['john_smith', 'personal'],
    ['jd', 'unknown'],
    ['ondine', 'unknown'],
  ])('%s@ → %s', (local, subtype) => {
    expect(classifyEmail(EmailAddress.parse(`${local}@salon.example.fr`)).subtype).toBe(subtype);
  });

  it('marks generic and department addresses as role accounts, never people', () => {
    const at = (local: string) =>
      classifyEmail(EmailAddress.parse(`${local}@salon.example.fr`)).isRoleAccount;
    expect(at('info')).toBe(true);
    expect(at('compta')).toBe(true);
    expect(at('marie.lefevre')).toBe(false);
    expect(at('jd')).toBe(false);
  });
});

describe('free-mail', () => {
  it.each([
    'gmail.com',
    'hotmail.fr',
    'outlook.com',
    'yahoo.fr',
    'icloud.com',
    'orange.fr',
    'wanadoo.fr',
    'laposte.net',
    'free.fr',
    'sfr.fr',
  ])('%s is webmail', (domain) => {
    expect(isFreeMailDomain(domain)).toBe(true);
    expect(classifyEmail(EmailAddress.parse(`marie@${domain}`)).isFreeMail).toBe(true);
  });

  it.each(['salon.example.fr', 'mail.salon.example.fr', 'gmail.example.com'])('%s is not', (domain) => {
    expect(isFreeMailDomain(domain)).toBe(false);
  });

  it('is case-insensitive', () => {
    expect(isFreeMailDomain('GMAIL.com')).toBe(true);
  });
});

describe('disposable', () => {
  it.each(['mailinator.com', 'guerrillamail.com', 'yopmail.com', 'sub.mailinator.com'])(
    '%s is disposable',
    (domain) => {
      expect(isDisposableDomain(domain)).toBe(true);
    },
  );

  it.each(['salon.example.fr', 'com', 'mailinator.com.example.test'])('%s is not', (domain) => {
    expect(isDisposableDomain(domain)).toBe(false);
  });

  it('never lists a webmail provider as disposable', () => {
    expect([...FREE_MAIL_DOMAINS].filter(isDisposableDomain)).toEqual([]);
  });
});

describe('matchesWebsiteDomain', () => {
  it.each([
    ['salon-ondine.fr', 'www.salon-ondine.fr', true],
    ['mail.salon-ondine.fr', 'salon-ondine.fr', true],
    ['villa.example.co.uk', 'shop.villa.example.co.uk', true],
    ['gmail.com', 'www.salon-ondine.fr', false],
    ['salon-ondine.com', 'salon-ondine.fr', false],
  ] as const)('%s vs %s → %s', (emailDomain, host, expected) => {
    expect(matchesWebsiteDomain(emailDomain, host)).toBe(expected);
  });

  it('is null without a website', () => {
    expect(matchesWebsiteDomain('salon-ondine.fr', null)).toBeNull();
    expect(classifyEmail(EmailAddress.parse('info@salon-ondine.fr')).matchesWebsiteDomain).toBeNull();
  });
});
