'use client';

/** The renderer failed (a database outage): a 500 without internals, in English and French. */
export default function ErrorPage() {
  return (
    <main className="bf-status">
      <h1>Something went wrong · Une erreur est survenue</h1>
      <p>The page could not be shown. Please try again in a moment.</p>
      <p lang="fr">La page n’a pas pu être affichée. Réessayez dans un instant.</p>
    </main>
  );
}
