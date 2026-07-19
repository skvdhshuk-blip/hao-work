import models from '@gutenye/ocr-models/node';
import fs from 'node:fs';
for (const [k, v] of Object.entries(models)) console.log(k, v, fs.existsSync(v));
