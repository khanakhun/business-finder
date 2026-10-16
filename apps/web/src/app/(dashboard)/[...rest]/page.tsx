import { notFound } from 'next/navigation';

// Unknown URLs render (dashboard)/not-found.tsx inside the shell instead of a bare 404 page.
export default function CatchAll() {
  notFound();
}
