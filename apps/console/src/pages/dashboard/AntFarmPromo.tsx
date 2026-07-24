// AntFarmPromo — promo banner linking to the Ant Farm visualisation.
//
// The Ant Farm is served by the backend at /antfarm/ (its own SPA), NOT a
// TanStack route, so this is a plain <a href> with a trailing slash to trigger
// a full navigation. The hero image is a placeholder served from public/;
// @TODO: replace public/antfarm-promo.gif with the user-provided promo gif.

import { useState } from 'react';

export function AntFarmPromo() {
  // If the placeholder gif isn't present yet, hide the broken <img> so the
  // styled media panel shows instead of a broken-image icon.
  const [imageOk, setImageOk] = useState(true);

  return (
    <a href="/antfarm/" className="dash-promo">
      <div className="dash-promo-media">
        {imageOk && (
          <img
            src="/antfarm-promo.gif"
            alt="Ant Farm — the bullpen rendered as a live office floor plan"
            className="dash-promo-img"
            onError={() => setImageOk(false)}
          />
        )}
      </div>
      <div className="dash-promo-body">
        <span className="dash-promo-eyebrow">Ant Farm</span>
        <h3 className="dash-promo-title">Watch the bullpen work</h3>
        <p className="dash-promo-text">
          Every agent, task and hand-off rendered as a live floor plan. The same events as the
          activity feed, just watchable.
        </p>
        <span className="dash-promo-cta">
          Open the Ant Farm
          <svg viewBox="0 0 24 24" width="15" height="15" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
            <path d="M5 12h14m-6-6 6 6-6 6" />
          </svg>
        </span>
      </div>
    </a>
  );
}
