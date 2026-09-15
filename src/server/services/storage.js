const path = require('node:path');
const multer = require('multer');
const { supabase, supabaseAdmin } = require('../config/supabase');

const UPLOADS_BUCKET = 'uploads';

// Allowed MIME types for general evidence/document uploads. SVG is intentionally
// excluded because it can carry inline scripts. HTML-ish types are rejected to
// stop stored-XSS via uploaded files that a browser might render.
const ALLOWED_UPLOAD_MIMES = new Set([
  'application/pdf',
  'image/png', 'image/jpeg', 'image/jpg', 'image/gif', 'image/webp', 'image/bmp',
  'text/plain', 'text/csv',
  'application/json', 'application/xml', 'text/xml',
  'application/msword',
  'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  'application/vnd.ms-excel',
  'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  'application/vnd.ms-powerpoint',
  'application/vnd.openxmlformats-officedocument.presentationml.presentation',
  'application/zip', 'application/x-zip-compressed',
  'application/octet-stream', // generic binary — still forced to download by storage headers
]);
const BLOCKED_UPLOAD_EXTENSIONS = new Set([
  '.html', '.htm', '.xhtml', '.svg', '.xml', '.js', '.mjs', '.cjs', '.php',
  '.phtml', '.phar', '.jsp', '.asp', '.aspx', '.cgi', '.pl', '.py', '.rb',
  '.sh', '.bat', '.cmd', '.ps1', '.exe', '.dll', '.so', '.msi',
]);

function uploadFileFilter(allowed) {
  return (req, file, cb) => {
    const mime = (file.mimetype || '').toLowerCase();
    const ext = path.extname(file.originalname || '').toLowerCase();
    if (BLOCKED_UPLOAD_EXTENSIONS.has(ext)) {
      return cb(new Error(`File type not allowed: ${ext}`));
    }
    if (!allowed.has(mime)) {
      return cb(new Error(`MIME type not allowed: ${mime || 'unknown'}`));
    }
    cb(null, true);
  };
}

// File upload setup - use memory storage; files are sent to Supabase Storage
const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 50 * 1024 * 1024 },
  fileFilter: uploadFileFilter(ALLOWED_UPLOAD_MIMES),
});
// PDF-only uploads for report endpoints
const uploadPdf = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 50 * 1024 * 1024 },
  fileFilter: uploadFileFilter(new Set(['application/pdf'])),
});

// Helper: generate a unique storage path for an uploaded file
function storageKey(folder, originalname) {
  const ext = path.extname(originalname);
  const base = path.basename(originalname, ext).replace(/[^a-zA-Z0-9_-]/g, '_');
  return `${folder}/${Date.now()}_${base}${ext}`;
}

// Helper: upload a buffer to Supabase Storage; returns the storage path
// Use the service-role client for server-side storage operations (bypasses RLS)
const storageClient = supabaseAdmin || supabase;

async function uploadToSupabase(folder, file) {
  if (!storageClient) throw new Error('Supabase is not configured (missing SUPABASE_SERVICE_ROLE_KEY or NEXT_PUBLIC_SUPABASE_ANON_KEY)');
  const key = storageKey(folder, file.originalname);
  const { error } = await storageClient.storage
    .from(UPLOADS_BUCKET)
    .upload(key, file.buffer, { contentType: file.mimetype, upsert: false });
  if (error) throw new Error(`Supabase upload failed: ${error.message}`);
  return key;
}

// Helper: get a short-lived signed download URL from Supabase Storage.
// Forces Content-Disposition: attachment so the browser never renders
// user-uploaded files inline (defense against HTML/SVG/PDF-hosted XSS).
async function getSignedUrl(storagePath, expiresIn = 300, downloadName = true) {
  if (!storageClient) throw new Error('Supabase is not configured (missing SUPABASE_SERVICE_ROLE_KEY or NEXT_PUBLIC_SUPABASE_ANON_KEY)');
  const { data, error } = await storageClient.storage
    .from(UPLOADS_BUCKET)
    .createSignedUrl(storagePath, expiresIn, { download: downloadName });
  if (error) throw new Error(`Supabase signed URL failed: ${error.message}`);
  return data.signedUrl;
}

// Helper: delete a file from Supabase Storage (ignores "not found" errors)
async function deleteFromSupabase(storagePath) {
  if (!storageClient) return;
  await storageClient.storage.from(UPLOADS_BUCKET).remove([storagePath]);
}

module.exports = { upload, uploadPdf, uploadToSupabase, getSignedUrl, deleteFromSupabase, storageClient, UPLOADS_BUCKET };
