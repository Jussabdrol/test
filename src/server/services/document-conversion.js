const { Worker, isMainThread, parentPort, workerData } = require('node:worker_threads');
const sanitizeHtml = require('sanitize-html');
const { HttpError } = require('../shared/errors');
function cleanHtml(html) {
  if (typeof html !== 'string' || Buffer.byteLength(html) > 1024 * 1024) throw new HttpError(413, 'Document content is too large');
  return sanitizeHtml(html, {
    allowedTags: ['p','br','h1','h2','h3','h4','h5','h6','strong','b','em','i','u','s','ul','ol','li','table','thead','tbody','tfoot','tr','td','th','blockquote','pre','code','span','div'],
    allowedAttributes: { td: ['colspan','rowspan'], th: ['colspan','rowspan'] }, allowedSchemes: [],
  });
}
// Only sanitized text and tables enter the worker. Remote/data images and styles
// are stripped before conversion, preventing network access through HTML content.
if (!isMainThread && workerData?.bopConversion) {
  require('@turbodocx/html-to-docx')(workerData.html, null, { table: { row: { cantSplit: true } } })
    .then(bytes => parentPort.postMessage(Buffer.from(bytes)))
    .catch(() => { throw new Error('Document conversion failed'); });
}
let activeConversions = 0;
async function convertToDocx(html) {
  const clean = cleanHtml(html);
  if (activeConversions >= 2) throw new HttpError(429, 'Document conversion is busy; retry shortly');
  activeConversions++;
  try {
    return await new Promise((resolve, reject) => {
      const worker = new Worker(__filename, { workerData: { bopConversion: true, html: clean }, resourceLimits: { maxOldGenerationSizeMb: 128 } });
      const timer = setTimeout(() => { void worker.terminate(); reject(new HttpError(408, 'Document conversion timed out')); }, 15000);
      worker.once('message', bytes => { clearTimeout(timer); resolve(Buffer.from(bytes)); void worker.terminate(); });
      worker.once('error', () => { clearTimeout(timer); reject(new HttpError(422, 'Document cannot be converted')); });
      worker.once('exit', code => { clearTimeout(timer); if (code !== 0) reject(new HttpError(422, 'Document cannot be converted')); });
    });
  } finally { activeConversions--; }
}
module.exports = { convertToDocx, cleanHtml };
