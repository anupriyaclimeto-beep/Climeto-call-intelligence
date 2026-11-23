import path from 'path';
import AdmZip from 'adm-zip';
import mammoth from 'mammoth';
import { createExtractorFromData } from 'node-unrar-js';
import { PDFParse } from 'pdf-parse';
import { listKnowledgeDocs, upsertKnowledgeDoc, upsertPlaybookRule } from '../db.js';

const SUPPORTED_EXTS = new Set(['.pdf', '.docx', '.txt', '.md', '.csv']);

function normalizeText(text = '') {
  return String(text || '')
    .replace(/\r\n/g, '\n')
    .replace(/[ \t]+\n/g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

export async function extractSingleFileText(buffer, filename) {
  const ext = path.extname(String(filename || '')).toLowerCase();

  if (ext === '.pdf') {
    const parser = new PDFParse({ data: buffer });
    try {
      const result = await parser.getText();
      return { fileType: 'pdf', text: normalizeText(result?.text || '') };
    } finally {
      await parser.destroy().catch(() => {});
    }
  }

  if (ext === '.docx') {
    const result = await mammoth.extractRawText({ buffer });
    return { fileType: 'docx', text: normalizeText(result?.value || '') };
  }

  if (ext === '.txt' || ext === '.md' || ext === '.csv') {
    return { fileType: ext.slice(1), text: normalizeText(buffer.toString('utf8')) };
  }

  throw new Error(`Unsupported file format: ${ext || 'unknown'}`);
}

export async function ingestUploadedFiles(files = []) {
  const ingested = [];
  const skipped = [];

  for (const file of files) {
    const originalName = String(file.originalname || file.filename || 'document').trim();
    const ext = path.extname(originalName).toLowerCase();

    if (ext === '.zip') {
      try {
        const zip = new AdmZip(file.buffer);
        const entries = zip.getEntries();
        for (const entry of entries) {
          if (entry.isDirectory) continue;
          const entryName = entry.entryName || '';
          if (entryName.startsWith('__MACOSX/') || path.basename(entryName).startsWith('.')) {
            continue;
          }
          const entryExt = path.extname(entryName).toLowerCase();
          if (!SUPPORTED_EXTS.has(entryExt)) {
            skipped.push({ filename: entryName, reason: `Unsupported type inside ZIP (${entryExt || 'none'})` });
            continue;
          }
          try {
            const entryBuffer = entry.getData();
            const { fileType, text } = await extractSingleFileText(entryBuffer, entryName);
            if (!text || text.length < 15) {
              skipped.push({ filename: entryName, reason: 'No selectable text extracted (possibly scanned image PDF)' });
              continue;
            }
            const saved = upsertKnowledgeDoc({
              filename: path.basename(entryName),
              fileType,
              sourceZip: originalName,
              content: text.slice(0, 60000),
            });
            ingested.push({
              id: saved.id,
              filename: saved.filename,
              file_type: saved.file_type,
              source_zip: saved.source_zip,
              char_count: saved.char_count,
            });
          } catch (innerErr) {
            skipped.push({ filename: entryName, reason: innerErr.message });
          }
        }
      } catch (zipErr) {
        skipped.push({ filename: originalName, reason: `ZIP parse error: ${zipErr.message}` });
      }
      continue;
    }

    if (ext === '.rar') {
      try {
        const arrayBuffer = file.buffer.buffer.slice(
          file.buffer.byteOffset,
          file.buffer.byteOffset + file.buffer.byteLength,
        );
        const extractor = await createExtractorFromData({ data: arrayBuffer });
        const extracted = extractor.extract();
        const extractedFiles = [...extracted.files];

        for (const entry of extractedFiles) {
          if (entry.fileHeader?.flags?.directory) continue;
          const entryName = entry.fileHeader?.name || '';
          if (!entryName || entryName.startsWith('__MACOSX/') || path.basename(entryName).startsWith('.')) {
            continue;
          }
          const entryExt = path.extname(entryName).toLowerCase();
          if (!SUPPORTED_EXTS.has(entryExt)) {
            skipped.push({ filename: entryName, reason: `Unsupported type inside RAR (${entryExt || 'none'})` });
            continue;
          }
          try {
            const entryBuffer = Buffer.from(entry.extraction);
            const { fileType, text } = await extractSingleFileText(entryBuffer, entryName);
            if (!text || text.length < 15) {
              skipped.push({ filename: entryName, reason: 'No selectable text extracted (possibly scanned image PDF)' });
              continue;
            }
            const saved = upsertKnowledgeDoc({
              filename: path.basename(entryName),
              fileType,
              sourceZip: originalName,
              content: text.slice(0, 60000),
            });
            ingested.push({
              id: saved.id,
              filename: saved.filename,
              file_type: saved.file_type,
              source_zip: saved.source_zip,
              char_count: saved.char_count,
            });
          } catch (innerErr) {
            skipped.push({ filename: entryName, reason: innerErr.message });
          }
        }
      } catch (rarErr) {
        skipped.push({ filename: originalName, reason: `RAR parse error: ${rarErr.message}` });
      }
      continue;
    }

    if (!SUPPORTED_EXTS.has(ext)) {
      skipped.push({ filename: originalName, reason: `Unsupported format (${ext || 'unknown'}). Use PDF, DOCX, ZIP, RAR, or TXT.` });
      continue;
    }

    try {
      const { fileType, text } = await extractSingleFileText(file.buffer, originalName);
      if (!text || text.length < 15) {
        skipped.push({ filename: originalName, reason: 'No selectable text extracted (possibly scanned image PDF)' });
        continue;
      }
      const saved = upsertKnowledgeDoc({
        filename: originalName,
        fileType,
        sourceZip: '',
        content: text.slice(0, 60000),
      });
      ingested.push({
        id: saved.id,
        filename: saved.filename,
        file_type: saved.file_type,
        source_zip: saved.source_zip,
        char_count: saved.char_count,
      });
    } catch (err) {
      skipped.push({ filename: originalName, reason: err.message });
    }
  }

  return { ingested, skipped };
}

export function buildKnowledgeContextBlock({ maxChars = 6500 } = {}) {
  const docs = listKnowledgeDocs({ activeOnly: true });
  if (!docs.length) return '';

  const chunks = [];
  let used = 0;
  const perDocCap = Math.max(Math.floor(maxChars / Math.min(docs.length, 5)), 1200);

  for (const doc of docs) {
    if (used >= maxChars) break;
    const excerpt = String(doc.content || '').slice(0, Math.min(perDocCap, maxChars - used));
    const block = `### DOCUMENT: ${doc.title} (${doc.file_type.toUpperCase()})\n${excerpt}`;
    chunks.push(block);
    used += block.length;
  }

  return `\n\nCLIMETO OFFICIAL EPR KNOWLEDGE BASE (Use these facts to verify compliance accuracy and answer technical questions):\n${chunks.join('\n\n')}`;
}

export async function generatePlaybookRulesFromKnowledge() {
  const docs = listKnowledgeDocs({ activeOnly: true });
  if (!docs.length) {
    throw new Error('Please upload at least one EPR document first.');
  }

  const combinedContext = buildKnowledgeContextBlock({ maxChars: 12000 });
  const apiKey = String(process.env.GEMINI_API_KEY || '').trim();
  const model = String(process.env.GEMINI_MODEL || 'gemini-flash-lite-latest').trim();
  const useLiveAi = Boolean(apiKey) && process.env.NODE_ENV !== 'test';

  let generatedRules = [];

  if (useLiveAi) {
    const url = `https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(model)}:generateContent?key=${encodeURIComponent(apiKey)}`;
    const systemPrompt = `You are Climeto's Senior EPR Compliance & Sales Trainer.
Read the uploaded official EPR documents below and extract 4 to 6 high-impact, practical sales playbook rules (Discovery Questions, Technical Objection Rebuttals, WhatsApp Templates, or Compliance Red Flags) tailored for Indian B2B sales executives speaking Hinglish/English.
Return ONLY valid JSON with this exact schema:
{
  "rules": [
    {
      "category": "discovery" | "objection" | "whatsapp_template" | "red_flag",
      "title": "Short rule title",
      "client_cue": "When to use this rule / client question",
      "ideal_response": "Exact natural Hinglish/English guidance or script grounded in the EPR documents"
    }
  ]
}`;

    const res = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      signal: AbortSignal.timeout(25000),
      body: JSON.stringify({
        systemInstruction: { parts: [{ text: systemPrompt }] },
        contents: [{ role: 'user', parts: [{ text: combinedContext }] }],
        generationConfig: { temperature: 0.3, responseMimeType: 'application/json' },
      }),
    });

    if (!res.ok) {
      const errText = await res.text();
      throw new Error(`Gemini API ${res.status}: ${errText.slice(0, 180)}`);
    }

    const json = await res.json();
    const rawText = json?.candidates?.[0]?.content?.parts?.[0]?.text || '{}';
    const parsed = JSON.parse(rawText.replace(/^```json\s*/i, '').replace(/```\s*$/i, '').trim());
    generatedRules = Array.isArray(parsed.rules) ? parsed.rules : [];
  } else {
    generatedRules = [
      {
        category: 'objection',
        title: `EPR Reference: ${docs[0].title}`,
        client_cue: 'Client asks for official EPR compliance documentation',
        ideal_response: `As per our official ${docs[0].title} guide: ${docs[0].summary}`,
      },
    ];
  }

  const saved = [];
  for (const r of generatedRules) {
    if (!r?.title || !r?.ideal_response) continue;
    saved.push(
      upsertPlaybookRule({
        category: r.category || 'objection',
        title: r.title,
        client_cue: r.client_cue || 'Derived from uploaded EPR documentation',
        ideal_response: r.ideal_response,
        priority: 1,
      }),
    );
  }

  return { created_count: saved.length, rules: saved };
}

