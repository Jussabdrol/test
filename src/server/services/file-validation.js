const path = require('node:path');
const { HttpError } = require('../shared/errors');
function validateFileContent(file) {
  const b = file.buffer;
  const starts = hex => b.subarray(0, hex.length / 2).equals(Buffer.from(hex, 'hex'));
  const ext = path.extname(file.originalname || '').toLowerCase();
  const signatures = {
    '.pdf': () => b.subarray(0,5).toString() === '%PDF-',
    '.png': () => starts('89504e470d0a1a0a'), '.jpg': () => starts('ffd8ff'), '.jpeg': () => starts('ffd8ff'),
    '.gif': () => ['GIF87a','GIF89a'].includes(b.subarray(0,6).toString()), '.bmp': () => b.subarray(0,2).toString() === 'BM',
    '.webp': () => b.subarray(0,4).toString() === 'RIFF' && b.subarray(8,12).toString() === 'WEBP',
    '.docx': () => starts('504b0304'), '.xlsx': () => starts('504b0304'), '.pptx': () => starts('504b0304'),
    '.zip': () => starts('504b0304') || starts('504b0506'),
    '.doc': () => starts('d0cf11e0a1b11ae1'), '.xls': () => starts('d0cf11e0a1b11ae1'), '.ppt': () => starts('d0cf11e0a1b11ae1'),
    '.txt': () => !b.includes(0), '.csv': () => !b.includes(0), '.json': () => { try { JSON.parse(b.toString('utf8')); return true; } catch { return false; } },
  };
  if (!Buffer.isBuffer(b) || !signatures[ext] || !signatures[ext]()) throw new HttpError(400, 'File contents do not match an allowed file format');
  if (file.mimetype === 'application/pdf' && ext !== '.pdf') throw new HttpError(400, 'PDF uploads must contain a PDF file');
}
module.exports = { validateFileContent };
