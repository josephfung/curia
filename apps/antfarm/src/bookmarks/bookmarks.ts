export interface AntfarmBookmark {
  from: string;
  to: string;
  label: string;
  conversationId?: string;
  agentId?: string;
  eventKind?: string;
}

const STORAGE_KEY = 'curia-antfarm-bookmarks';

export function loadBookmarks(): AntfarmBookmark[] {
  if (typeof localStorage === 'undefined') return [];
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return [];
    const parsed = JSON.parse(raw) as AntfarmBookmark[];
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

export function saveBookmarks(bookmarks: AntfarmBookmark[]): void {
  if (typeof localStorage === 'undefined') return;
  localStorage.setItem(STORAGE_KEY, JSON.stringify(bookmarks));
}

export function addBookmark(bookmark: AntfarmBookmark): AntfarmBookmark[] {
  const next = [...loadBookmarks(), bookmark];
  saveBookmarks(next);
  return next;
}

export function removeBookmark(index: number): AntfarmBookmark[] {
  const current = loadBookmarks();
  const next = current.filter((_, i) => i !== index);
  saveBookmarks(next);
  return next;
}
