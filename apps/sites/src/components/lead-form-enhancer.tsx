'use client';

import { solveChallenge } from 'altcha-lib';
import { deriveKey } from 'altcha-lib/algorithms/web/pbkdf2';
import { useEffect } from 'react';

/**
 * Proof of work for a lead form (BF-048): when the form is sent, fetch a challenge from our API, solve it in the
 * browser (ALTCHA, no third party), put the answer in the form and post it as usual. Without JavaScript the form posts
 * without it (the API is then stricter); if solving fails, the form still posts.
 */
export function LeadFormEnhancer({
  formId,
  challengeUrl,
  sendingLabel,
}: {
  formId: string;
  challengeUrl: string;
  sendingLabel: string;
}) {
  useEffect(() => {
    const form = document.getElementById(formId);
    if (!(form instanceof HTMLFormElement)) return;
    let solving = false;
    const onSubmit = async (event: SubmitEvent) => {
      if (form.dataset.solved === 'true') return;
      event.preventDefault();
      if (solving) return;
      solving = true;
      const button = form.querySelector<HTMLButtonElement>('button[type="submit"]');
      if (button) {
        button.disabled = true;
        button.textContent = sendingLabel;
      }
      try {
        const response = await fetch(challengeUrl, { credentials: 'omit' });
        if (response.ok) {
          const challenge = await response.json();
          const solution = await solveChallenge({ challenge, deriveKey });
          if (solution) {
            const input = document.createElement('input');
            input.type = 'hidden';
            input.name = 'altcha';
            input.value = btoa(JSON.stringify({ challenge, solution }));
            form.append(input);
          }
        }
      } catch {
        // The API judges a form without proof more strictly; it is still sent.
      }
      form.dataset.solved = 'true';
      form.requestSubmit();
    };
    const listener = (event: Event) => void onSubmit(event as SubmitEvent);
    form.addEventListener('submit', listener);
    return () => form.removeEventListener('submit', listener);
  }, [formId, challengeUrl, sendingLabel]);
  return null;
}
