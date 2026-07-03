/** Pixel-art assets for Ant Farm (CC0 placeholders; licensed LimeZu art layered at deploy). */

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
        . CC0 placeholders in-repo; production builds layer licensed assets from curia-deploy.
      </span>
    </footer>
  );
}
