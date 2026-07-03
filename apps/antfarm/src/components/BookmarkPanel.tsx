import type { AntfarmBookmark } from '../bookmarks/bookmarks.js';

interface BookmarkPanelProps {
  bookmarks: AntfarmBookmark[];
  onSave: () => void;
  onLoad: (bookmark: AntfarmBookmark) => void;
  onRemove: (index: number) => void;
}

export function BookmarkPanel({ bookmarks, onSave, onLoad, onRemove }: BookmarkPanelProps) {
  return (
    <aside className="bookmarks">
      <div className="bookmarks-header">
        <h2>Bookmarks</h2>
        <button type="button" onClick={onSave}>Save window</button>
      </div>
      <ul>
        {bookmarks.map((bookmark, index) => (
          <li key={`${bookmark.label}-${index}`}>
            <button type="button" className="bookmark-load" onClick={() => onLoad(bookmark)}>
              {bookmark.label}
            </button>
            <button type="button" className="bookmark-remove" onClick={() => onRemove(index)}>×</button>
          </li>
        ))}
      </ul>
    </aside>
  );
}
