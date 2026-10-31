import { create } from 'qrcode';

/** QR rendered as SVG elements. A data-URL image would be blocked by img-src 'self'. */
export function PairingQr({ value }: { value: string }) {
  const qr = create(value, { errorCorrectionLevel: 'M' });
  const size = qr.modules.size;
  const quiet = 4;
  const span = size + quiet * 2;
  const cells: Array<{ row: number; col: number }> = [];
  for (let row = 0; row < size; row += 1) {
    for (let col = 0; col < size; col += 1) {
      if (qr.modules.get(row, col)) cells.push({ row, col });
    }
  }
  return (
    <svg className="pair-qr" viewBox={`${-quiet} ${-quiet} ${span} ${span}`} role="img" aria-label="Pairing QR code">
      <rect x={-quiet} y={-quiet} width={span} height={span} fill="#F5F4F1" />
      {cells.map((cell) => (
        <rect key={`${cell.col}-${cell.row}`} x={cell.col} y={cell.row} width="1" height="1" fill="#1C1C1E" />
      ))}
    </svg>
  );
}
