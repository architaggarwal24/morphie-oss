import qrcode from "qrcode-generator";

/** A QR code as an SVG string (black on white, scales to its box). Used for UPI payment links. */
export function qrSvg(text: string): string {
  const q = qrcode(0, "M");
  q.addData(text);
  q.make();
  return q.createSvgTag({ cellSize: 4, margin: 2, scalable: true });
}
