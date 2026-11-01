import { PHONE_DOCS_URL } from '../../../../src/phone/phone-docs.js';

/** Renders a pairing warning. The docs URL becomes a link when the text includes it. */
export function PhoneNotice({ text }: { text: string }) {
  const index = text.indexOf(PHONE_DOCS_URL);
  if (index === -1) {
    return <p className="pair-warning" role="status">{text}</p>;
  }
  return (
    <p className="pair-warning" role="status">
      {text.slice(0, index)}
      <a href={PHONE_DOCS_URL}>Use Curia on your phone</a>
      {text.slice(index + PHONE_DOCS_URL.length)}
    </p>
  );
}
