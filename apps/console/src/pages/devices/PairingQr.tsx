import { create } from 'qrcode';

/** QR rendered as SVG elements. A data-URL image would be blocked by img-src 'self'. */
export function PairingQr({ value }: { value: string }) {
  const qr = create(value, { errorCorrectionLevel: 'M' });
  const size = qr.modules.size;
  const cells: Array<{ row: number; col: number }> = [];
  for (let row = 0; row < size; row += 1) {
    for (let col = 0; col < size; col += 1) {
      if (qr.modules.get(row, col)) cells.push({ row, col });
    }
  }
  return (
    <svg className="pair-qr" viewBox={`0 0 ${size} ${size}`} role="img" aria-label="Pairing QR code">
      <rect width={size} height={size} fill="#F5F4F1" />
      {cells.map((cell) => (
        <rect key={`${cell.col}-${cell.row}`} x={cell.col} y={cell.row} width="1" height="1" fill="#1C1C1E" />
      ))}
    </svg>
  );
}
