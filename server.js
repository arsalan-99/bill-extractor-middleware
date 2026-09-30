require('dotenv').config();
const express = require('express');
const cors    = require('cors');
const multer  = require('multer');
const sharp   = require('sharp');
const path    = require('path');

const app  = express();
const PORT = process.env.PORT || 3000;
const GEMINI_API_KEY = process.env.GEMINI_API_KEY;

// ─── Model fallback chain ────────────────────────────────────────────────────
// Ordered by free-tier quota generosity / cost (cheapest first).
// The service tries each model in order if the previous one returns 429 or 503.
const MODEL_CHAIN = [
  'gemini-3.5-flash-lite',   // #1 – highest free quota, cheapest (replaces 2.0-flash-lite)
  'gemini-2.5-flash-lite',   // #2 – cheap lite fallback
  'gemini-2.5-flash',        // #3 – mid-tier fallback
  'gemini-1.5-flash',        // #4 – older but stable last resort
];

// ─── Middleware ──────────────────────────────────────────────────────────────
const upload = multer({ storage: multer.memoryStorage() });
app.use(cors());
app.use(express.json({ limit: '15mb' }));
app.use(express.urlencoded({ extended: true, limit: '15mb' }));
app.use(express.static(__dirname));

// ─── Routes ──────────────────────────────────────────────────────────────────
app.get('/', (req, res) => {
  res.sendFile(path.join(__dirname, 'test.html'));
});

app.post('/extract', upload.single('file'), async (req, res) => {
  try {
    let rawBuffer, mimeType;

    if (req.file) {
      rawBuffer = req.file.buffer;
      mimeType  = req.file.mimetype;
    } else if (req.body?.file_base64) {
      const b64str = req.body.file_base64.replace(/^data:.*;base64,/, '');
      rawBuffer    = Buffer.from(b64str, 'base64');
      mimeType     = req.body.mime_type || 'image/jpeg';
    } else {
      return res.status(400).json({
        error: 'No file provided. Send multipart "file" or JSON "file_base64".'
      });
    }

    // Optimise image before sending to Gemini (skips PDFs)
    const { buffer: optimisedBuffer, mimeType: optimisedMime } =
      await optimiseImage(rawBuffer, mimeType);

    const base64Data = optimisedBuffer.toString('base64');
    const fields     = req.body.fields || req.query.fields || '';
    const prompt     = buildPrompt(fields);

    const geminiData = await callGeminiWithFallback(base64Data, optimisedMime, prompt);

    return res.json({
      success: true,
      data: JSON.parse(geminiData.candidates[0].content.parts[0].text),
    });

  } catch (err) {
    console.error('[extract]', err.message);
    return res.status(500).json({ error: err.message });
  }
});

// ─── Image optimisation ───────────────────────────────────────────────────────
/**
 * Resize and compress an image buffer to reduce Gemini token usage.
 * PDFs are passed through unchanged (sharp cannot process them).
 */
async function optimiseImage(buffer, mimeType) {
  if (mimeType === 'application/pdf') {
    return { buffer, mimeType }; // PDFs: no optimisation
  }

  try {
    const optimised = await sharp(buffer)
      .resize({ width: 1600, withoutEnlargement: true }) // cap longest edge at 1600 px
      .jpeg({ quality: 82 })                              // convert to JPEG, 82% quality
      .toBuffer();

    const savedKB = ((buffer.length - optimised.length) / 1024).toFixed(0);
    if (savedKB > 0) console.log(`[sharp] Image compressed — saved ${savedKB} KB`);

    return { buffer: optimised, mimeType: 'image/jpeg' };
  } catch (err) {
    // Unsupported format or corrupt image — send original
    console.warn('[sharp] Optimisation skipped:', err.message);
    return { buffer, mimeType };
  }
}

// ─── Gemini call with automatic model fallback ────────────────────────────────
/**
 * Tries each model in MODEL_CHAIN in order.
 * Moves to the next model if the current one returns 429 (rate limit) or 503.
 * Throws if all models are exhausted.
 */
async function callGeminiWithFallback(base64Data, mimeType, prompt) {
  let lastError;

  for (let i = 0; i < MODEL_CHAIN.length; i++) {
    const model = MODEL_CHAIN[i];

    if (i > 0) {
      console.warn(`[fallback] Switching to model #${i + 1}: ${model}`);
    }

    const response = await fetch(
      `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${GEMINI_API_KEY}`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          contents: [{
            parts: [
              { text: prompt },
              { inline_data: { mime_type: mimeType, data: base64Data } },
            ],
          }],
          generationConfig: { responseMimeType: 'application/json' },
        }),
      }
    );

    // Retryable statuses → try next model
    if (response.status === 429 || response.status === 503) {
      const errBody = await response.json().catch(() => ({}));
      lastError = new Error(
        errBody.error?.message || `Model ${model} returned ${response.status}`
      );
      console.warn(`[fallback] ${model} → ${response.status}. Trying next...`);
      continue;
    }

    const data = await response.json();

    if (!response.ok) {
      throw new Error(data.error?.message || `Gemini API error (${response.status})`);
    }

    if (i > 0) console.log(`[fallback] Succeeded with model: ${model}`);
    return data;
  }

  // All models exhausted
  throw lastError || new Error('All Gemini models are currently unavailable.');
}

// ─── Prompt builder ───────────────────────────────────────────────────────────
function buildPrompt(fields) {
  const fieldList = fields
    ? fields.split(',').map(s => s.trim()).filter(Boolean)
    : [];

  // DEFAULT: no fields specified — extract exactly what the bill contains
  if (!fieldList.length) {
    return `Extract ALL data from this bill/receipt exactly as it appears.

Rules:
- Look at the actual columns/fields present in the bill. Extract every column you see — do not add columns that are not in the bill, do not drop any column that is in the bill.
- Row-level data (line items): return in "items" array. Each item object must have exactly the keys matching the columns visible in the bill (e.g. if bill has name + price + qty, each item has name, price, qty — not more, not less).
- Include ALL rows — never skip any row.
- Document-level data (merchant name, date, bill number, totals, taxes, etc.): return as top-level keys.
- If a value is unreadable, use null (numbers: 0).
- No currency symbols in numbers.
- Return valid JSON only.`;
  }

  // EXPLICIT FIELDS: caller specified fields to extract (e.g. item columns)
  const fieldNames = fieldList.join(', ');

  return `Extract data from this bill/receipt into structured JSON.

Requested item/custom fields: ${fieldNames}.

Extraction Rules:
1. Document-Level Details (ALWAYS INCLUDE):
   - Always extract document-wide metadata as top-level keys (such as merchant_name, date, invoice_number/bill_number, total, subtotal, tax). Never omit or skip these details.
2. Line Items ("items" array):
   - Include ALL rows/items from the bill (never skip any row).
   - For each item in "items", extract ONLY the requested line-item columns matching ${fieldNames} (e.g., if "name, amount" is requested, each item in "items" should contain only name and amount).
   - If any field in ${fieldNames} is a document-level field (e.g. merchant_name), ensure it is present at the top level.
3. Clean values:
   - No currency symbols in numbers.
   - If a field is missing or unreadable, use null (or 0 for numbers).
4. Return valid JSON only.`;
}

// ─── Start ────────────────────────────────────────────────────────────────────
app.listen(PORT, () => console.log(`Server running on port ${PORT}`));
