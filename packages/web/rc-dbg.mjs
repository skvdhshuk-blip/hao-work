import Ocr from '@gutenye/ocr-node';
const ocr = await Ocr.create();
const r = await ocr.detect('/tmp/ocr-cn.png');
console.log('CN:', r.map((l) => l.text).join(' | '));
