import models from '@gutenye/ocr-models/node';
import fs from 'node:fs';
console.log('paths:', JSON.stringify(models, null, 1));
for (const [k, v] of Object.entries(models)) console.log(k, fs.existsSync(v));
