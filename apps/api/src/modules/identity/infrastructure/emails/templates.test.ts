import { describe, expect, it } from 'vitest';
import { renderEmail } from '../smtp-system-mailer.ts';
import { Invitation, ResetPassword, TwoFactorEnabled, VerifyEmail } from './templates.tsx';

describe('system email templates', () => {
  it('render the link and localized copy in both languages', async () => {
    const en = await renderEmail(
      VerifyEmail({ locale: 'en', name: 'Ana', url: 'https://api.test/verify?t=1' }),
    );
    expect(en.html).toContain('href="https://api.test/verify?t=1"');
    expect(en.html).toContain('Confirm your email');
    expect(en.html).toContain('lang="en"');
    expect(en.text).toContain('Hi Ana');

    const fr = await renderEmail(
      Invitation({
        locale: 'fr',
        inviterName: 'Léa',
        organizationName: 'Agence SBH',
        role: 'admin',
        url: 'https://app.test/invite/1',
      }),
    );
    expect(fr.html).toContain('Rejoindre Agence SBH');
    expect(fr.text).toContain('Léa vous invite à rejoindre Agence SBH en tant que administrateur.');
  });

  it('escapes user-provided text', async () => {
    const { html } = await renderEmail(
      ResetPassword({ locale: 'en', name: '<script>x</script>', url: 'https://a.test' }),
    );
    expect(html).not.toContain('<script>x</script>');
    expect(html).toContain('&lt;script&gt;');
  });

  it('warns about unexpected 2FA changes', async () => {
    const { text } = await renderEmail(TwoFactorEnabled({ locale: 'en', name: 'Ana' }));
    expect(text).toContain('If this was not you');
  });
});
