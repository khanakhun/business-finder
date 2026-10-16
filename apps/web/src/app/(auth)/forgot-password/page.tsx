import type { Metadata } from 'next';
import { getTranslations } from 'next-intl/server';
import { ForgotPasswordForm } from './forgot-password-form.tsx';

export async function generateMetadata(): Promise<Metadata> {
  return { title: (await getTranslations('auth.forgot'))('title') };
}

export default function ForgotPasswordPage() {
  return <ForgotPasswordForm />;
}
