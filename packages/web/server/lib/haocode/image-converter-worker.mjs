// Isolated image-conversion worker. Runs the onnxruntime-backed local
// converters (OCR + caption) in a separate process so a native segfault only
// kills the conversion, not the host app. Protocol: JSON-lines over stdio —
// requests `{ id, kind: 'ocr' | 'caption', dataUri }` on stdin, responses
// `{ id, ok, text | error }` on stdout. stdout is the protocol channel, so
// every console method is redirected to stderr before importing converters
// (onnxruntime/transformers log through console).

for (const method of ['log', 'info', 'warn', 'error', 'debug', 'trace']) {
  console[method] = (...args) => process.stderr.write(`${args.map(String).join(' ')}\n`);
}

const { createImageConverters } = await import('./image-converters.js');

const converters = createImageConverters({
  dataDir: process.env.HAOWORK_IMAGE_DATA_DIR || process.cwd(),
  logger: console,
});

const write = (payload) => process.stdout.write(`${JSON.stringify(payload)}\n`);

const handle = async ({ id, kind, dataUri }) => {
  const converter = typeof kind === 'string' ? converters[kind] : null;
  if (typeof converter !== 'function') {
    write({ id, ok: false, error: `unknown conversion kind: ${String(kind)}` });
    return;
  }
  try {
    const text = await converter(dataUri);
    write({ id, ok: true, text: typeof text === 'string' ? text : '' });
  } catch (error) {
    write({ id, ok: false, error: error instanceof Error ? error.message : String(error) });
  }
};

let buffer = '';
process.stdin.on('data', (chunk) => {
  buffer += chunk;
  let index;
  while ((index = buffer.indexOf('\n')) >= 0) {
    const line = buffer.slice(0, index);
    buffer = buffer.slice(index + 1);
    if (!line.trim()) continue;
    try {
      handle(JSON.parse(line));
    } catch {
      // Malformed request line: ignore, keep the channel alive.
    }
  }
});

write({ ready: true });
