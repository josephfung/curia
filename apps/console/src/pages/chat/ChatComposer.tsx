// apps/console/src/pages/chat/ChatComposer.tsx
import { useState, useRef } from 'react';

interface ChatComposerProps {
  disabled: boolean;
  onSend: (text: string) => void;
}

export function ChatComposer({ disabled, onSend }: ChatComposerProps) {
  const [value, setValue] = useState('');
  const textareaRef = useRef<HTMLTextAreaElement>(null);

  function submit() {
    const text = value.trim();
    if (!text || disabled) return;
    onSend(text);
    setValue('');
    // Reset the auto-grown height back to the single-line minimum.
    if (textareaRef.current) {
      textareaRef.current.style.height = 'auto';
    }
  }

  function handleChange(e: React.ChangeEvent<HTMLTextAreaElement>) {
    setValue(e.target.value);
    // Auto-grow: reset then expand to scrollHeight so the textarea fits its content.
    e.target.style.height = 'auto';
    e.target.style.height = `${e.target.scrollHeight}px`;
  }

  function handleKeyDown(e: React.KeyboardEvent<HTMLTextAreaElement>) {
    // IME composition is still in progress — Enter should confirm the candidate, not submit.
    if (e.nativeEvent.isComposing) return;
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      // requestSubmit() triggers the parent form's onSubmit, keeping submit logic in one place.
      e.currentTarget.form?.requestSubmit();
    }
  }

  function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    submit();
  }

  return (
    <form
      className="chat-composer"
      onSubmit={handleSubmit}
    >
      <textarea
        ref={textareaRef}
        value={value}
        onChange={handleChange}
        onKeyDown={handleKeyDown}
        placeholder="Message Curia…"
        disabled={disabled}
        rows={1}
        aria-label="Message"
      />
      <button
        type="submit"
        className="btn btn-primary"
        disabled={disabled || value.trim().length === 0}
      >
        Send
      </button>
    </form>
  );
}
