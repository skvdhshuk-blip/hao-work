// Image-to-text converters for providers whose models cannot consume image
// inputs. The compat server (prompt_async) converts image attachments into
// plain text before sending when the provider's imagePolicy is non-native.
//
// - `ocr` runs RapidOCR (PP-OCRv4, bundled Chinese+English models from
//   @gutenye/ocr-node) fully offline — no downloads, strong Chinese quality.
// - `caption` runs a small image-captioning model through
//   @xenova/transformers (weights lazily downloaded into
//   `<dataDir>/haocode/models/`).
// - `vlm` asks a vision-capable model through the provider's own chat
//   completions / messages endpoint.
//
// The RapidOCR instance and caption pipeline are singletons per converter
// instance so repeated runs reuse the loaded runtime and model weights.
// Nothing here throws on model download by itself: loading happens on first
// use, and callers degrade failed conversions to a placeholder line instead
// of blocking the conversation.

import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

const CAPTION_MODEL_ID = 'Xenova/vit-gpt2-image-captioning';
const VLM_DESCRIBE_PROMPT = '用中文简要描述这张图片的内容，50 字以内';

const OPENAI_VLM_MAX_TOKENS = 256;
const ANTHROPIC_VLM_VERSION = '2023-06-01';

// Parse a `data:<mime>;base64,<payload>` URI. Returns null for non-base64 or
// non-data payloads (file paths and remote URLs are not supported by the
// local converters).
const parseDataUri = (dataUri) => {
  const match = /^data:([^;,]+)?;base64,([\s\S]*)$/i.exec(typeof dataUri === 'string' ? dataUri.trim() : '');
  if (!match) return null;
  return { mimeType: match[1] || 'image/png', base64: match[2] };
};

export const createImageConverters = ({
  dataDir,
  logger = console,
  fetchImpl = globalThis.fetch?.bind(globalThis),
}) => {
  const modelsDir = path.join(dataDir, 'haocode', 'models');
  let rapidOcrPromise = null;
  let captionPipelinePromise = null;

  // RapidOCR ships PP-OCRv4 det/rec/cls ONNX models inside
  // @gutenye/ocr-models (~15MB) and runs them on onnxruntime-node — fully
  // offline, so there is nothing to download on first use. A failed creation
  // resets the singleton so the next run retries.
  const getRapidOcr = () => {
    rapidOcrPromise ??= (async () => {
      const { default: Ocr } = await import('@gutenye/ocr-node');
      return Ocr.create();
    })().catch((error) => {
      rapidOcrPromise = null;
      throw error;
    });
    return rapidOcrPromise;
  };

  // Import transformers.js with the Node/sharp image-decoding branch even
  // under Bun: Bun exposes `self`, which flips the library to its browser
  // branch (createImageBitmap), an API Bun does not implement. `BROWSER_ENV`
  // is computed once at module evaluation, so hiding `self` for the duration
  // of the import is enough.
  const importTransformers = async () => {
    if (typeof process !== 'undefined' && process.versions?.bun
      && typeof globalThis.self !== 'undefined' && typeof globalThis.createImageBitmap === 'undefined') {
      const original = globalThis.self;
      globalThis.self = undefined;
      try {
        return await import('@xenova/transformers');
      } finally {
        globalThis.self = original;
      }
    }
    return import('@xenova/transformers');
  };

  // The caption pipeline downloads the model weights on first use and caches
  // them under modelsDir (same lazy-provisioning pattern as the sandbox
  // runtime cache; nothing is committed to the repository).
  const getCaptionPipeline = () => {
    captionPipelinePromise ??= (async () => {
      await fs.mkdir(modelsDir, { recursive: true });
      const { env, pipeline } = await importTransformers();
      env.cacheDir = modelsDir;
      // huggingface.co is unreachable from some networks (CN); default to the
      // public mirror so the caption model can actually download there, with
      // an env override for users who have direct access or another mirror.
      env.remoteHost = process.env.HAOWORK_HF_ENDPOINT || 'https://hf-mirror.com/';
      return pipeline('image-to-text', CAPTION_MODEL_ID);
    })().catch((error) => {
      captionPipelinePromise = null;
      throw error;
    });
    return captionPipelinePromise;
  };

  // Local converters read pixel data from a temp file: RapidOCR accepts a
  // file path directly and the transformers RawImage loader handles paths
  // without pulling Blob polyfills into the pipeline.
  const withTempImage = async (dataUri, run) => {
    const parsed = parseDataUri(dataUri);
    if (!parsed) throw new Error('Image conversion requires a base64 data URI.');
    const file = path.join(
      await fs.mkdtemp(path.join(os.tmpdir(), 'hao-image-convert-')),
      `image.${(parsed.mimeType.split('/')[1] || 'png').replace(/[^a-z0-9]/gi, '')}`,
    );
    try {
      await fs.writeFile(file, Buffer.from(parsed.base64, 'base64'));
      return await run(file);
    } finally {
      await fs.rm(path.dirname(file), { recursive: true, force: true }).catch(() => {});
    }
  };

  const ocr = (dataUri) => withTempImage(dataUri, async (file) => {
    const engine = await getRapidOcr();
    const lines = await engine.detect(file);
    if (!Array.isArray(lines)) return '';
    return lines
      .map((line) => (typeof line?.text === 'string' ? line.text.trim() : ''))
      .filter(Boolean)
      .join('\n');
  });

  const caption = (dataUri) => withTempImage(dataUri, async (file) => {
    const pipe = await getCaptionPipeline();
    const output = await pipe(file);
    const text = Array.isArray(output) ? output[0]?.generated_text : output?.generated_text;
    return typeof text === 'string' ? text.trim() : '';
  });

  // Ask a vision-capable model on the provider's own endpoint to describe the
  // image. OpenAI-compatible providers receive chat/completions with an
  // image_url part; anthropic providers receive /v1/messages with a base64
  // image block.
  const vlm = async (dataUri, { apiKey, baseUrl, providerType, model } = {}) => {
    if (!apiKey) throw new Error('VLM image description requires provider credentials.');
    if (typeof model !== 'string' || !model.trim()) throw new Error('VLM image description requires a model id.');
    if (typeof baseUrl !== 'string' || !baseUrl.trim()) throw new Error('VLM image description requires a base URL.');
    if (typeof fetchImpl !== 'function') throw new Error('VLM image description requires fetch.');
    const root = baseUrl.trim().replace(/\/+$/, '');
    if (providerType === 'anthropic') {
      const parsed = parseDataUri(dataUri);
      if (!parsed) throw new Error('Anthropic VLM description requires a base64 data URI.');
      const response = await fetchImpl(`${root}/v1/messages`, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          'x-api-key': apiKey,
          'anthropic-version': ANTHROPIC_VLM_VERSION,
        },
        body: JSON.stringify({
          model: model.trim(),
          max_tokens: OPENAI_VLM_MAX_TOKENS,
          messages: [{
            role: 'user',
            content: [
              { type: 'image', source: { type: 'base64', media_type: parsed.mimeType, data: parsed.base64 } },
              { type: 'text', text: VLM_DESCRIBE_PROMPT },
            ],
          }],
        }),
      });
      if (!response.ok) throw new Error(`VLM request failed with status ${response.status}.`);
      const payload = await response.json();
      const text = (Array.isArray(payload?.content) ? payload.content : [])
        .filter((block) => block?.type === 'text')
        .map((block) => block.text)
        .join(' ')
        .trim();
      if (!text) throw new Error('VLM response did not include a description.');
      return text;
    }
    const response = await fetchImpl(`${root}/chat/completions`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        authorization: `Bearer ${apiKey}`,
      },
      body: JSON.stringify({
        model: model.trim(),
        max_tokens: OPENAI_VLM_MAX_TOKENS,
        messages: [{
          role: 'user',
          content: [
            { type: 'text', text: VLM_DESCRIBE_PROMPT },
            { type: 'image_url', image_url: { url: dataUri } },
          ],
        }],
      }),
    });
    if (!response.ok) throw new Error(`VLM request failed with status ${response.status}.`);
    const payload = await response.json();
    const content = payload?.choices?.[0]?.message?.content;
    const text = typeof content === 'string'
      ? content.trim()
      : (Array.isArray(content) ? content : [])
        .filter((block) => block?.type === 'text')
        .map((block) => block.text)
        .join(' ')
        .trim();
    if (!text) throw new Error('VLM response did not include a description.');
    return text;
  };

  return { ocr, caption, vlm };
};
