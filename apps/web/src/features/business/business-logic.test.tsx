import type { BusinessDetail, CrmState, Permission } from '@bf/contracts';
import { render } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { registerDefaultQuickActions, whatsAppUrl } from './actions/defaults.ts';
import { quickActionsFor } from './actions/registry.ts';
import { SafeMarkdown } from './markdown.tsx';
import { businessTabs, visibleTabs } from './tabs/registry.ts';
import { parseTags } from './tags.ts';

const business = (overrides: Partial<BusinessDetail> = {}) =>
  ({
    id: '0192a1b2-0000-7000-8000-000000000001',
    displayName: 'Boulangerie du Port',
    websiteUrl: 'https://example.test/',
    primaryPhone: '+33 1 99 00 27 00',
    ...overrides,
  }) as BusinessDetail;
const crm = (overrides: Partial<CrmState> = {}) => ({ doNotContact: false, ...overrides }) as CrmState;
const permissions = (...list: Permission[]) => new Set<Permission>(list);

describe('quick actions', () => {
  registerDefaultQuickActions();

  it('offers links only where the business has them and permissions allow', () => {
    const member = quickActionsFor({
      business: business(),
      crm: crm(),
      permissions: permissions('business:read', 'business:write', 'sites:generate', 'outreach:send'),
    });
    expect(member.map((a) => [a.action.id, a.enabled, a.href])).toEqual([
      ['business.open-website', true, 'https://example.test/'],
      ['business.call', true, 'tel:+33199002700'],
      ['business.whatsapp', true, 'https://wa.me/33199002700'],
      ['enrichment.enrich', false, null],
      ['sites.generate', false, null],
      ['outreach.send-email', false, null],
    ]);
    const viewer = quickActionsFor({
      business: business({ websiteUrl: 'javascript:alert(1)', primaryPhone: null }),
      crm: crm(),
      permissions: permissions('business:read'),
    });
    expect(viewer).toEqual([]);
  });

  it('blocks messaging a do-not-contact business', () => {
    const actions = quickActionsFor({
      business: business(),
      crm: crm({ doNotContact: true }),
      permissions: permissions('business:read', 'outreach:send'),
    });
    expect(actions.find((a) => a.action.id === 'business.call')?.enabled).toBe(false);
    expect(actions.find((a) => a.action.id === 'business.whatsapp')?.reason).toBe(
      'business.actions.doNotContact',
    );
    expect(actions.find((a) => a.action.id === 'outreach.send-email')?.reason).toBe(
      'business.actions.doNotContact',
    );
  });

  it('builds wa.me links from digits only', () => {
    expect(whatsAppUrl('+33 (1) 99-00-27-00')).toBe('https://wa.me/33199002700');
    expect(whatsAppUrl('12')).toBeNull();
    expect(whatsAppUrl(null)).toBeNull();
  });
});

describe('tabs registry', () => {
  it('hides tabs the user may not see', () => {
    const Empty = () => null;
    businessTabs.register({ id: 'mine', labelKey: 'x', order: 2, component: Empty });
    businessTabs.register({
      id: 'admin',
      labelKey: 'y',
      order: 1,
      permission: 'scoring:manage',
      component: Empty,
    });
    expect(visibleTabs(permissions('business:read')).map((tab) => tab.id)).toEqual(['mine']);
    expect(visibleTabs(permissions('scoring:manage')).map((tab) => tab.id)).toEqual(['admin', 'mine']);
    businessTabs.reset();
  });
});

describe('parseTags', () => {
  it('splits, trims and dedupes', () => {
    expect(parseTags(' VIP, restaurant ,,VIP')).toEqual(['VIP', 'restaurant']);
    expect(parseTags(Array.from({ length: 25 }, (_, i) => `t${i}`).join(','))).toHaveLength(20);
  });
});

describe('SafeMarkdown', () => {
  it('renders markdown but never raw HTML, scripts, images or javascript: links', () => {
    const { container } = render(
      <SafeMarkdown>
        {[
          '**Bold** and [site](https://example.test) and [bad](javascript:alert(1))',
          '<script>alert(1)</script><b onclick="x()">raw</b>',
          '![pixel](https://tracker.test/p.gif)',
          '# Heading',
          '## Second',
          '### Third',
          '#### Fourth',
        ].join('\n\n')}
      </SafeMarkdown>,
    );
    expect(container.querySelector('strong')?.textContent).toBe('Bold');
    const links = [...container.querySelectorAll('a')];
    expect(links[0]?.getAttribute('href')).toBe('https://example.test');
    expect(links[0]?.getAttribute('rel')).toBe('noopener noreferrer nofollow');
    expect(links[1]?.getAttribute('href') ?? '').not.toContain('javascript');
    expect(container.querySelector('script, b, img, h1')).toBeNull();
    expect(container.innerHTML).not.toContain('onclick');
    expect(container.textContent).toContain('Heading');
    expect(container.querySelector('h2, h3, h4')).toBeNull();
    expect(container.textContent).toContain('Fourth');
  });
});
