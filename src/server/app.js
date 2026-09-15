// Patch Express to forward async errors to the error handler automatically (must be first)
require('express-async-errors');
const mammoth = require('mammoth');
const HTMLtoDOCX = require('html-to-docx');

const express = require('express');
const path = require('path');
const crypto = require('crypto');
const zlib = require('zlib');
const { promisify } = require('util');
const deflateRaw = promisify(zlib.deflateRaw);
const XLSX = require('xlsx');
const db = require('./database');
const multer = require('multer');
const bcrypt = require('bcryptjs');
const helmet = require('helmet');
const rateLimit = require('express-rate-limit');

const { HttpError } = require('./shared/errors');
const { computeNextDue } = require('./services/recurrence');
const { getOpenAI } = require('./services/openai');
const { logAuditAction } = require('./services/audit-log');
const { supabase, supabaseAdmin } = require('./config/supabase');
const { upload, uploadPdf, uploadToSupabase, getSignedUrl, deleteFromSupabase, storageClient, UPLOADS_BUCKET } = require('./services/storage');
const { ensureTaskInstances, parseIntParam, isValidDateStr, validateRecurrenceFields, emitEvent } = require('./services/planning');
const { validateWebhookUrl, sendValidatedWebhook, fireWebhooks } = require('./services/webhooks');

const app = express();
require('./middleware/route-handling').installRouteHandling(app, db);
const { getOrgId, requireOrgContext, requireOpsAccess, requireSuperadmin, requireAdmin, bumpUserSessionVersion, authRateLimiter } = require('./middleware/security').configureSecurity(app, { crypto, db, express, helmet, rateLimit });

// Serve login page without auth
app.get('/login', async (req, res) => {
  if (req.session.userId) {
    return res.redirect('/');
  }
  res.sendFile(path.join(__dirname, '../../public', 'login.html'));
});

app.use(express.static(path.join(__dirname, '../../public')));

// Registration order is significant: middleware precedes routes; fallbacks follow them.
require('./routes/auth').registerAuthRoutes(app, { authRateLimiter, bcrypt, bumpUserSessionVersion, db, getOrgId, requireSuperadmin, supabase, supabaseAdmin });
const { completeTaskSeries } = require('./routes/tasks').registerTasksRoutes(app, { HttpError, computeNextDue, db, emitEvent, fireWebhooks, isValidDateStr, requireOpsAccess, requireOrgContext, validateRecurrenceFields });
require('./routes/task-instances').registerTaskInstancesRoutes(app, { HttpError, computeNextDue, db, deleteFromSupabase, emitEvent, ensureTaskInstances, fireWebhooks, getSignedUrl, parseIntParam, requireOpsAccess, requireOrgContext, upload, uploadToSupabase });
const { updateFollowup } = require('./routes/actions').registerActionsRoutes(app, { HttpError, db, requireOpsAccess, requireOrgContext });
require('./routes/plan-bundles').registerPlanBundlesRoutes(app, { db, requireOpsAccess, requireOrgContext });
require('./routes/audits').registerAuditsRoutes(app, { db, fireWebhooks, logAuditAction, requireOrgContext, uploadPdf, uploadToSupabase });
const { updateChecklistItem } = require('./routes/checklist').registerChecklistRoutes(app, { HttpError, db, deleteFromSupabase, getSignedUrl, requireOrgContext, upload, uploadToSupabase });
require('./routes/non-conformities').registerNonConformitiesRoutes(app, { db, emitEvent, fireWebhooks, requireOrgContext });
require('./routes/requirements').registerRequirementsRoutes(app, { db, requireOrgContext });
require('./routes/threats').registerThreatsRoutes(app, { db, requireOrgContext });
require('./routes/risks').registerRisksRoutes(app, { db, fireWebhooks, requireOrgContext });
require('./routes/treatments').registerTreatmentsRoutes(app, { db, requireOrgContext });
require('./routes/soa').registerSoaRoutes(app, { db, requireOrgContext, uploadPdf, uploadToSupabase });
require('./routes/organization').registerOrganizationRoutes(app, { db, fireWebhooks, requireOrgContext });
require('./routes/documents').registerDocumentsRoutes(app, { HTMLtoDOCX, UPLOADS_BUCKET, XLSX, db, deleteFromSupabase, fireWebhooks, getSignedUrl, mammoth, requireOrgContext, storageClient, upload, uploadToSupabase });
require('./routes/links').registerLinksRoutes(app, { db, requireOrgContext });
require('./routes/admin').registerAdminRoutes(app, { UPLOADS_BUCKET, bcrypt, bumpUserSessionVersion, crypto, db, deleteFromSupabase, getSignedUrl, logAuditAction, parseIntParam, requireAdmin, sendValidatedWebhook, storageClient, supabaseAdmin, validateWebhookUrl });
require('./routes/saml').registerSamlRoutes(app, { crypto, db, deflateRaw, express, logAuditAction, requireAdmin });
require('./routes/management-reviews').registerManagementReviewsRoutes(app, { db, requireOrgContext, uploadPdf, uploadToSupabase });
require('./routes/suppliers').registerSuppliersRoutes(app, { db, requireOrgContext });
const { executeAgentTool } = require('./routes/agent').registerAgentRoutes(app, { HttpError, completeTaskSeries, db, getOpenAI, requireOrgContext, updateChecklistItem, updateFollowup });
require('./routes/imports').registerImportsRoutes(app, { XLSX, db, getOpenAI, requireOrgContext, upload });

app.use('/api', (req,res) => res.status(404).json({error:'API endpoint not found'}));

// SPA fallback
app.get('*', async (req, res) => {
  res.sendFile(path.join(__dirname, '../../public', 'index.html'));
});

// Global error handler - must be last middleware
app.use((err, req, res, next) => {
  if (err.code === 'EBADCSRFTOKEN') return res.status(403).json({error:'CSRF validation failed. Reload the page and try again.'});
  if (err instanceof HttpError) return res.status(err.status).json({error:err.message});
  if (['23503','23505','23514','22P02','22007','22008'].includes(err.code)) return res.status(err.code === '23505' ? 409 : 400).json({error:'Invalid value or conflicting reference. Check the linked records and fields.'});
  // Surface upload validation failures as 400 so the UI can show a helpful message
  if (err && (err instanceof multer.MulterError ||
      (typeof err.message === 'string' &&
       (err.message.startsWith('MIME type not allowed') ||
        err.message.startsWith('File type not allowed'))))) {
    return res.status(400).json({ error: err.message });
  }
  console.error('Unhandled error:', err.stack || err);
  res.status(500).json({ error: 'Internal server error' });
});

module.exports = { app, executeAgentTool };
