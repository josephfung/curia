/** Pixel-art credits for Ant Farm — licensed LimeZu art (in-repo) with CC0 procedural fallback. */

export function CreditsFooter() {
  return (
    <footer className="credits-footer">
      <span>
        Office art style inspired by{' '}
        <a href="https://limezu.itch.io/modernoffice" target="_blank" rel="noopener noreferrer">
          LimeZu Modern Office
        </a>
        {' '}and{' '}
        <a href="https://limezu.itch.io/moderninteriors" target="_blank" rel="noopener noreferrer">
          Modern Interiors
        </a>
        , used with permission. CC0 procedural placeholders render when the art is unavailable.
      </span>
    </footer>
  );
}
