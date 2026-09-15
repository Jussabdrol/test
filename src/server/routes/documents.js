// Register on the shared app to retain middleware and transaction boundaries.
function registerDocumentsRoutes(app, { HTMLtoDOCX, UPLOADS_BUCKET, XLSX, db, deleteFromSupabase, fireWebhooks, getSignedUrl, mammoth, requireOrgContext, storageClient, upload, uploadToSupabase }) {
  // --- Document Control API ---

  app.get('/api/documents', requireOrgContext, async (req, res) => {
    const { doc_type, status, linked_module, classification } = req.query;
    let sql = 'SELECT * FROM documents WHERE organization_id = ?';
    const params = [req.orgId];
    if (doc_type) { sql += ' AND doc_type = ?'; params.push(doc_type); }
    if (status) { sql += ' AND status = ?'; params.push(status); }
    if (linked_module) { sql += ' AND linked_module = ?'; params.push(linked_module); }
    if (classification) { sql += ' AND classification = ?'; params.push(classification); }
    sql += ' ORDER BY updated_at DESC';
    res.json(await db.prepare(sql).all(...params));
  });

  app.post('/api/documents', requireOrgContext, upload.single('file'), async (req, res) => {
    const { title, description, doc_type, version, owner, status, linked_module, linked_ref_type, linked_ref_id, review_date, classification } = req.body;
    if (!title) return res.status(400).json({ error: 'Title is required' });
    const file = req.file;
    let storagePath = '';
    if (file) {
      try {
        storagePath = await uploadToSupabase('documents', file);
      } catch (err) {
        // Storage unavailable — continue without file storage; record the metadata
        console.warn('File upload skipped (storage unavailable):', err.message);
      }
    }
    const result = await db.prepare(`INSERT INTO documents (organization_id, title, description, doc_type, version, owner, status, file_name, file_path, file_size, mime_type, linked_module, linked_ref_type, linked_ref_id, review_date, classification) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(
      req.orgId,
      title, description || '', doc_type || 'policy', version || '1.0', owner || '', status || 'draft',
      file ? file.originalname : '', storagePath, file ? file.size : 0, file ? file.mimetype : '',
      linked_module || '', linked_ref_type || '', linked_ref_id || null, review_date || null, classification || ''
    );
    res.status(201).json(await db.prepare('SELECT * FROM documents WHERE id = ?').get(result.lastInsertRowid));
  });

  app.put('/api/documents/:id', requireOrgContext, upload.single('file'), async (req, res) => {
    const existing = await db.prepare('SELECT * FROM documents WHERE id = ? AND organization_id = ?').get(req.params.id, req.orgId);
    if (!existing) return res.status(404).json({ error: 'Document not found' });
    const { title, description, doc_type, version, owner, status, linked_module, linked_ref_type, linked_ref_id, review_date, classification } = req.body;
    const file = req.file;
    let storagePath = file ? '' : existing.file_path;
    if (file) {
      try {
        storagePath = await uploadToSupabase('documents', file);
        // Delete the old file from Supabase Storage
        if (existing.file_path) await deleteFromSupabase(existing.file_path);
      } catch (err) {
        // Storage unavailable — keep existing path, update metadata only
        storagePath = existing.file_path;
        console.warn('File upload skipped (storage unavailable):', err.message);
      }
    }
    await db.prepare(`UPDATE documents SET title=?, description=?, doc_type=?, version=?, owner=?, status=?, file_name=?, file_path=?, file_size=?, mime_type=?, linked_module=?, linked_ref_type=?, linked_ref_id=?, review_date=?, classification=?, updated_at=datetime('now') WHERE id=?`).run(
      title || existing.title, description !== undefined ? description : existing.description,
      doc_type || existing.doc_type, version || existing.version, owner !== undefined ? owner : existing.owner,
      status || existing.status,
      file ? file.originalname : existing.file_name, storagePath,
      file ? file.size : existing.file_size, file ? file.mimetype : existing.mime_type,
      linked_module !== undefined ? linked_module : existing.linked_module,
      linked_ref_type !== undefined ? linked_ref_type : existing.linked_ref_type,
      linked_ref_id !== undefined ? (linked_ref_id || null) : existing.linked_ref_id,
      review_date !== undefined ? (review_date || null) : existing.review_date,
      classification !== undefined ? classification : (existing.classification || ''),
      req.params.id
    );
    const updatedDoc = await db.prepare('SELECT * FROM documents WHERE id = ?').get(req.params.id);
    if (status === 'approved' && existing.status !== 'approved') {
      fireWebhooks(req.orgId, 'doc_approved', {
        id: updatedDoc.id, title: updatedDoc.title, doc_type: updatedDoc.doc_type,
        version: updatedDoc.version, owner: updatedDoc.owner,
      });
    }
    res.json(updatedDoc);
  });

  app.delete('/api/documents/:id', requireOrgContext, async (req, res) => {
    const doc = await db.prepare('SELECT * FROM documents WHERE id = ? AND organization_id = ?').get(req.params.id, req.orgId);
    if (!doc) return res.status(404).json({ error: 'Document not found' });
    if (doc.file_path) await deleteFromSupabase(doc.file_path);
    await db.prepare('DELETE FROM documents WHERE id = ? AND organization_id = ?').run(req.params.id, req.orgId);
    res.json({ success: true });
  });

  app.get('/api/documents/:id/download', requireOrgContext, async (req, res) => {
    const doc = await db.prepare('SELECT * FROM documents WHERE id = ? AND organization_id = ?').get(req.params.id, req.orgId);
    if (!doc) return res.status(404).json({ error: 'File not found' });

    // Special case: management review reports are stored as HTML in the reviews table
    if (doc.linked_ref_type === 'management_review' && doc.doc_type === 'report' && (!doc.file_path || doc.file_path === '')) {
      const review = await db.prepare(
        'SELECT report_html, title FROM management_reviews WHERE id = ? AND organization_id = ?'
      ).get(doc.linked_ref_id, req.orgId);
      if (!review || !review.report_html) return res.status(404).json({ error: 'Report not generated yet' });
      res.setHeader('Content-Type', 'text/html');
      res.setHeader('Content-Disposition', `attachment; filename="management-review-${doc.linked_ref_id}.html"`);
      return res.send(review.report_html);
    }

    if (!doc.file_path) return res.status(404).json({ error: 'File not found' });
    try {
      const signedUrl = await getSignedUrl(doc.file_path, 300, doc.file_name || doc.title || true);
      res.redirect(signedUrl);
    } catch (err) {
      res.status(404).json({ error: 'File not found in storage' });
    }
  });

  // GET /api/documents/:id/edit-content — download file from storage and return editable content
  app.get('/api/documents/:id/edit-content', requireOrgContext, async (req, res) => {
    const doc = await db.prepare('SELECT * FROM documents WHERE id = ? AND organization_id = ?').get(req.params.id, req.orgId);
    if (!doc) return res.status(404).json({ error: 'Document not found' });
    if (!doc.file_path) return res.status(400).json({ error: 'No file attached to this document' });

    const ext = (doc.file_name || '').split('.').pop().toLowerCase();
    if (!['docx', 'doc', 'xlsx', 'xls'].includes(ext)) {
      return res.status(400).json({ error: 'Only Word (.docx) and Excel (.xlsx) files can be edited in the browser' });
    }

    if (!storageClient) return res.status(503).json({ error: 'Storage not configured' });
    const { data: blob, error: dlErr } = await storageClient.storage.from(UPLOADS_BUCKET).download(doc.file_path);
    if (dlErr) return res.status(500).json({ error: 'Failed to retrieve file from storage' });

    const buffer = Buffer.from(await blob.arrayBuffer());

    if (['xlsx', 'xls'].includes(ext)) {
      const wb = XLSX.read(buffer, { type: 'buffer' });
      const sheets = {};
      for (const name of wb.SheetNames) {
        sheets[name] = XLSX.utils.sheet_to_json(wb.Sheets[name], { header: 1, defval: '' });
      }
      return res.json({ type: 'excel', sheetNames: wb.SheetNames, sheets });
    }

    // Word
    const { value: html } = await mammoth.convertToHtml({ buffer });
    res.json({ type: 'word', html });
  });

  // PUT /api/documents/:id/save-content — save edited content back to storage
  app.put('/api/documents/:id/save-content', requireOrgContext, async (req, res) => {
    const doc = await db.prepare('SELECT * FROM documents WHERE id = ? AND organization_id = ?').get(req.params.id, req.orgId);
    if (!doc) return res.status(404).json({ error: 'Document not found' });
    if (!doc.file_path) return res.status(400).json({ error: 'No file path on record' });

    const { type, content } = req.body;
    if (!type || !content) return res.status(400).json({ error: 'Missing type or content' });

    let fileBuffer, mimeType;

    if (type === 'excel') {
      const wb = XLSX.utils.book_new();
      for (const [name, rows] of Object.entries(content.sheets || {})) {
        XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet(rows), name);
      }
      fileBuffer = XLSX.write(wb, { type: 'buffer', bookType: 'xlsx' });
      mimeType = 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet';
    } else if (type === 'word') {
      const docxBuffer = await HTMLtoDOCX(content.html || '', null, { table: { row: { cantSplit: true } } });
      fileBuffer = Buffer.isBuffer(docxBuffer) ? docxBuffer : Buffer.from(docxBuffer);
      mimeType = 'application/vnd.openxmlformats-officedocument.wordprocessingml.document';
    } else {
      return res.status(400).json({ error: 'Unsupported content type' });
    }

    if (!storageClient) return res.status(503).json({ error: 'Storage not configured' });
    const { error: upErr } = await storageClient.storage
      .from(UPLOADS_BUCKET)
      .update(doc.file_path, fileBuffer, { contentType: mimeType, upsert: true });
    if (upErr) return res.status(500).json({ error: 'Failed to save file: ' + upErr.message });

    await db.prepare("UPDATE documents SET file_size=?, mime_type=?, updated_at=datetime('now') WHERE id=?").run(fileBuffer.length, mimeType, req.params.id);
    res.json({ success: true });
  });
}

module.exports = { registerDocumentsRoutes };
