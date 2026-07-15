/**
 * qr — zeichnet Text als QR-Code auf ein Canvas.
 *
 * Nutzt den einkopierten Nayuki-Generator (js/vendor/qrcodegen.js, MIT) —
 * bewusst als Vendor-Datei statt Eigenbau: Reed-Solomon-Tabellen selbst zu
 * schreiben ist fehleranfällig, und die Datei läuft komplett offline
 * (kein CDN, keine Laufzeit-Abhängigkeit).
 */
import { qrcodegen } from '../vendor/qrcodegen.js';

/**
 * Zeichnet `text` als QR-Code auf das Canvas. ECC MEDIUM gibt Reserve
 * fürs Abfilmen vom Display. Liefert false, wenn kein 2D-Kontext
 * verfügbar ist (jsdom, sehr alte WebViews) — Aufrufer zeigt dann nur
 * den Text-Code.
 */
export function drawQR(canvas, text, { scale = 4, border = 3 } = {}) {
  const ctx = canvas.getContext?.('2d');
  if (!ctx) return false;

  let qr;
  try {
    qr = qrcodegen.QrCode.encodeText(text, qrcodegen.QrCode.Ecc.MEDIUM);
  } catch {
    return false; // Payload zu groß für QR (praktisch: > ~2 KB)
  }

  const size = (qr.size + border * 2) * scale;
  canvas.width = canvas.height = size;
  ctx.fillStyle = '#f3efe2';   // helles Feld im warmen Faceplate-Ton
  ctx.fillRect(0, 0, size, size);
  ctx.fillStyle = '#16120d';
  for (let y = 0; y < qr.size; y++) {
    for (let x = 0; x < qr.size; x++) {
      if (qr.getModule(x, y)) {
        ctx.fillRect((x + border) * scale, (y + border) * scale, scale, scale);
      }
    }
  }
  return true;
}
