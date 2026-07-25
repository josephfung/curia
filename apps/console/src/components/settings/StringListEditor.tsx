import { useState } from 'react';

interface StringListEditorProps {
  id: string;
  label: string;
  items: string[];
  onChange: (next: string[]) => void;
  placeholder?: string;
  emptyHint?: string;
}

/**
 * Ordered string-list editor (add / remove / reorder via delete+re-add).
 * Used for standing preferences, writing patterns, and vocabulary lists.
 */
export function StringListEditor({
  id,
  label,
  items,
  onChange,
  placeholder = 'Add an item…',
  emptyHint,
}: StringListEditorProps) {
  const [draft, setDraft] = useState('');

  function addItem() {
    const trimmed = draft.trim();
    if (!trimmed) return;
    if (items.includes(trimmed)) {
      setDraft('');
      return;
    }
    onChange([...items, trimmed]);
    setDraft('');
  }

  return (
    <div className="string-list-editor">
      <label className="wizard-label" htmlFor={`${id}-input`}>{label}</label>
      {items.length === 0 && emptyHint && (
        <p className="settings-muted-hint">{emptyHint}</p>
      )}
      <ul className="string-list" aria-label={label}>
        {items.map((item, idx) => (
          <li key={`${idx}-${item}`} className="string-list-item">
            <span className="string-list-text">{item}</span>
            <button
              type="button"
              className="btn btn-secondary string-list-remove"
              aria-label={`Remove: ${item}`}
              onClick={() => onChange(items.filter((_, i) => i !== idx))}
            >
              Remove
            </button>
          </li>
        ))}
      </ul>
      <div className="string-list-add-row">
        <input
          id={`${id}-input`}
          type="text"
          value={draft}
          placeholder={placeholder}
          onChange={e => setDraft(e.target.value)}
          onKeyDown={e => {
            if (e.key === 'Enter') {
              e.preventDefault();
              addItem();
            }
          }}
        />
        <button
          type="button"
          className="btn btn-secondary"
          disabled={!draft.trim()}
          onClick={addItem}
        >
          Add
        </button>
      </div>
    </div>
  );
}
