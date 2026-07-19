import { createWorker } from 'tesseract.js';
const dir = process.argv[2];
const w = await createWorker(['eng'], 1, { cachePath: dir, workerBlobURL: false });
const r = await w.recognize(process.argv[3]);
console.log('OCR:', JSON.stringify(r.data.text));
await w.terminate();
