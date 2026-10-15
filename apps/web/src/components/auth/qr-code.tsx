import { encode } from 'uqr';

/** QR code as SVG rectangles (no innerHTML). Used for the TOTP setup URI. */
export function QrCode({
  value,
  label,
  size = 192,
}: {
  readonly value: string;
  readonly label: string;
  readonly size?: number;
}) {
  const { data } = encode(value, { border: 2 });
  const modules = data.length;
  return (
    <svg
      role="img"
      aria-label={label}
      viewBox={`0 0 ${modules} ${modules}`}
      width={size}
      height={size}
      shapeRendering="crispEdges"
      className="rounded-md bg-white"
      data-testid="totp-qr"
    >
      {data.flatMap((row, y) =>
        row.map((dark, x) =>
          dark ? <rect key={`${x}-${y}`} x={x} y={y} width={1} height={1} fill="#111" /> : null,
        ),
      )}
    </svg>
  );
}
