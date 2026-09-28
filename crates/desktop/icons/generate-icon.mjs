// Build-time artwork only. Install sharp for this optional script; normal Rust
// builds use the checked-in assets and need no Node.js or image dependencies.
// The source PNG is the single source for the UI, Windows icon and tray pixels.
import { readFileSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
const sharp = createRequire(import.meta.url)('sharp');
const artwork = readFileSync(new URL('./logo-source.png', import.meta.url));
const sizes = [16, 20, 24, 32, 40, 48, 64, 128, 256];
const images = await Promise.all(sizes.map(size =>
  sharp(artwork).resize(size, size, { kernel: 'lanczos3' }).png({ palette: true, quality: 90, dither: 0 }).toBuffer()));
const header = Buffer.alloc(6 + sizes.length * 16);
header.writeUInt16LE(1, 2);
header.writeUInt16LE(sizes.length, 4);
let offset = header.length;
sizes.forEach((size, i) => {
  const p = 6 + i * 16;
  header[p] = size === 256 ? 0 : size;
  header[p + 1] = header[p];
  header.writeUInt16LE(1, p + 4);
  header.writeUInt16LE(32, p + 6);
  header.writeUInt32LE(images[i].length, p + 8);
  header.writeUInt32LE(offset, p + 12);
  offset += images[i].length;
});
writeFileSync(new URL('./icon.ico', import.meta.url), Buffer.concat([header, ...images]));
writeFileSync(new URL('./tray.rgba', import.meta.url),
  await sharp(artwork).resize(32, 32, { kernel: 'lanczos3' }).ensureAlpha().raw().toBuffer());
await sharp(artwork).resize(512, 512, { kernel: 'lanczos3' }).png().toFile(fileURLToPath(new URL('./logo-512.png', import.meta.url)));
await sharp(artwork).resize(256, 256, { kernel: 'lanczos3' }).png({ palette: true, quality: 90, dither: 0 }).toFile(fileURLToPath(new URL('../ui/logo.png', import.meta.url)));
console.log(`Generated ${sizes.join('/')} px Windows icons, 32 px tray and 512 px artwork.`);
