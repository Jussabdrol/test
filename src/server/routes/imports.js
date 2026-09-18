// Register on the shared app to retain middleware and transaction boundaries.
function registerImportsRoutes(app, { XLSX, db, getOpenAI, requireOrgContext, upload }) {
  // ---------------------------------------------------------------------------
  // Agent Import endpoint – file-based bulk population
  // POST /api/agent/import
  // Accepts an Excel/CSV file, uses OpenAI to map columns → app schema fields,
  // then bulk-inserts records respecting the user's module permissions.
  // ---------------------------------------------------------------------------

  // Schema context sent to OpenAI so it knows what fields are available per type.
  const IMPORT_SCHEMAS = {
    risks: {
      description: 'Risk register entries',
      fields: {
        title:       'string (required) – short risk name',
        description: 'string – full description',
        category:    'string – e.g. Operational, Compliance, Financial, Information Security',
        likelihood:  'integer 1–5',
        impact:      'integer 1–5',
        risk_owner:  'string – responsible person',
        status:      'string – one of: identified, analyzing, treating, accepted, closed',
      },
    },
    risk_treatments: {
      description: 'Risk treatment / control entries (linked to risks by title)',
      fields: {
        risk_title:   'string (required) – title of the parent risk to link to',
        description:  'string (required) – what the treatment does',
        status:       'string – one of: planned, in_progress, implemented, verified',
        due_date:     'string YYYY-MM-DD',
        responsible:  'string – person responsible',
      },
    },
    architecture: {
      description: 'Organizational architecture items: roles, processes, systems, assets, facilities',
      fields: {
        arch_type:   'string (required) – one of: role, process, system, asset, facility',
        name:        'string (required)',
        description: 'string',
        owner:       'string',
        status:      'string – active or inactive',
        parent_name: 'string – name of parent architecture item (optional)',
      },
    },
    requirements: {
      description: 'Standard requirements / clauses, optionally linked to processes',
      fields: {
        standard:     'string – e.g. ISO 27001, ISO 9001 (default: ISO 27001)',
        clause:       'string (required) – e.g. 4.1, 6.1.2',
        title:        'string (required) – requirement title',
        description:  'string',
        category:     'string',
        process_name: 'string – name of architecture process to cross-link to (optional)',
      },
    },
    tasks: {
      description: 'Recurring compliance tasks',
      fields: {
        title:       'string (required)',
        description: 'string',
        assignee:    'string',
        recurrence:  'string – one of: daily, weekly, biweekly, monthly, quarterly, yearly',
        category:    'string',
        priority:    'string – one of: Low, Medium, High, Critical',
      },
    },
    actions: {
      description: 'Follow-up action items',
      fields: {
        title:       'string (required)',
        description: 'string',
        assignee:    'string',
        priority:    'string – one of: Low, Medium, High, Critical',
        due_date:    'string YYYY-MM-DD',
      },
    },
    nonconformities: {
      description: 'Non-conformities (attached to most recent audit)',
      fields: {
        description: 'string (required) – description of the NC',
        severity:    'string – minor or major',
        clause:      'string – related ISO clause',
        responsible: 'string',
        status:      'string – one of: open, in_progress, closed, verified',
      },
    },
    documents: {
      description: 'Document register entries',
      fields: {
        title:       'string (required)',
        doc_type:    'string – one of: policy, procedure, work_instruction, record, form, report, evidence, other',
        version:     'string – e.g. 1.0',
        owner:       'string',
        status:      'string – one of: draft, review, approved, obsolete',
        review_date: 'string YYYY-MM-DD',
      },
    },
  };

  // Permission required per import type (mirrors AGENT_TOOL_PERMISSIONS)
  const IMPORT_TYPE_PERMISSIONS = {
    risks:            'risk',
    risk_treatments:  'risk',
    architecture:     'org',
    requirements:     'org',
    tasks:            'ops',
    actions:          'org',
    nonconformities:  'audit',
    documents:        'org',
  };

  // Maps template tab names → import data types (case-insensitive)
  const SHEET_NAME_TO_TYPE = {
    risks:             'risks',
    risk_treatments:   'risk_treatments',
    'risk treatments': 'risk_treatments',
    architecture:      'architecture',
    requirements:      'requirements',
    tasks:             'tasks',
    actions:           'actions',
    nonconformities:   'nonconformities',
    documents:         'documents',
  };

  function parseImportFile(buffer, originalname) {
    const ext = (originalname || '').split('.').pop().toLowerCase();
    const workbook = XLSX.read(buffer, { type: 'buffer', raw: ext === 'csv' });

    const sheets = [];
    for (const sheetName of workbook.SheetNames) {
      const ws = workbook.Sheets[sheetName];
      const rows = XLSX.utils.sheet_to_json(ws, { defval: '' });
      if (rows.length === 0) continue; // skip empty / instructions tabs
      const headers = Object.keys(rows[0]);
      // Skip the Instructions sheet (its first column is the long intro text)
      if (sheetName.toLowerCase() === 'instructions') continue;
      sheets.push({ sheetName, headers, rows });
    }
    return sheets; // array of { sheetName, headers, rows }
  }

  async function detectAndMap(openai, headers, sampleRows, dataTypeHint, userMessage) {
    const schemaBlock = dataTypeHint && IMPORT_SCHEMAS[dataTypeHint]
      ? JSON.stringify({ [dataTypeHint]: IMPORT_SCHEMAS[dataTypeHint] }, null, 2)
      : JSON.stringify(IMPORT_SCHEMAS, null, 2);

    const prompt = `You are a data-import assistant. A user is uploading a spreadsheet to import into a compliance management system.

  Available import types and their target fields:
  ${schemaBlock}

  The spreadsheet has these column headers:
  ${JSON.stringify(headers)}

  Sample rows (up to 3):
  ${JSON.stringify(sampleRows.slice(0, 3), null, 2)}

  ${userMessage ? `User note: "${userMessage}"` : ''}

  Respond with ONLY valid JSON in this exact format (no markdown, no extra text):
  {
    "data_type": "<one of the import type keys above>",
    "mapping": {
      "<target_field>": "<source_column_name_or_null>"
    }
  }

  Rules:
  - Pick the best matching data_type based on the column names and sample data.
  - For each target field, set the value to the matching source column name (exact header), or null if no match.
  - Required fields must map to a column. If you cannot find a match for a required field, still include it with null.
  - Do not invent column names. Only use headers from the list above.`;

    const response = await openai.chat.completions.create({
      model: 'gpt-4o-mini',
      messages: [{ role: 'user', content: prompt }],
      max_tokens: 512,
      temperature: 0,
    });

    const text = response.choices[0].message.content.trim();
    return JSON.parse(text);
  }

  function applyMapping(rows, mapping) {
    return rows.map(row => {
      const out = {};
      for (const [field, col] of Object.entries(mapping)) {
        if (col && row[col] !== undefined) {
          const val = String(row[col]).trim();
          out[field] = val === '' ? null : val;
        } else {
          out[field] = null;
        }
      }
      return out;
    });
  }

  async function bulkInsert(dataType, mappedRows, orgId) {
    const results = { imported: 0, skipped: 0, errors: [] };

    for (let i = 0; i < mappedRows.length; i++) {
      const row = mappedRows[i];
      const rowNum = i + 2; // 1-indexed + header row
      try {
        if (dataType === 'risks') {
          if (!row.title) { results.skipped++; results.errors.push(`Row ${rowNum}: missing title`); continue; }
          const likelihood = Math.min(5, Math.max(1, parseInt(row.likelihood) || 3));
          const impact     = Math.min(5, Math.max(1, parseInt(row.impact)     || 3));
          const validStatuses = ['identified','analyzing','treating','accepted','closed'];
          const status = validStatuses.includes(row.status) ? row.status : 'identified';
          await db.prepare(`
            INSERT INTO risks (organization_id, title, description, category, likelihood, impact, inherent_score, risk_owner, status)
            VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)
          `).run(orgId, row.title, row.description||'', row.category||'General',
                 likelihood, impact, likelihood*impact, row.risk_owner||'', status);
          results.imported++;

        } else if (dataType === 'risk_treatments') {
          if (!row.risk_title || !row.description) { results.skipped++; results.errors.push(`Row ${rowNum}: missing risk_title or description`); continue; }
          const risk = await db.prepare('SELECT id FROM risks WHERE organization_id = $1 AND LOWER(title) = LOWER($2) LIMIT 1').get(orgId, row.risk_title);
          if (!risk) { results.skipped++; results.errors.push(`Row ${rowNum}: risk not found: "${row.risk_title}"`); continue; }
          const validStatuses = ['planned','in_progress','implemented','verified'];
          const status = validStatuses.includes(row.status) ? row.status : 'planned';
          await db.prepare(`
            INSERT INTO risk_treatments (organization_id, risk_id, description, status, due_date, responsible)
            VALUES ($1,$2,$3,$4,$5,$6)
          `).run(orgId, risk.id, row.description, status, row.due_date||null, row.responsible||'');
          results.imported++;

        } else if (dataType === 'architecture') {
          const validTypes = ['role','process','system','asset','facility'];
          if (!row.name) { results.skipped++; results.errors.push(`Row ${rowNum}: missing name`); continue; }
          const archType = validTypes.includes(row.arch_type) ? row.arch_type : 'process';
          let parentId = null;
          if (row.parent_name) {
            const parent = await db.prepare('SELECT id FROM org_architecture WHERE organization_id = $1 AND LOWER(name) = LOWER($2) LIMIT 1').get(orgId, row.parent_name);
            if (parent) parentId = parent.id;
          }
          const status = row.status === 'inactive' ? 'inactive' : 'active';
          // Upsert: update if name+type already exists, otherwise insert
          const existing = await db.prepare('SELECT id FROM org_architecture WHERE organization_id = $1 AND arch_type = $2 AND LOWER(name) = LOWER($3) LIMIT 1').get(orgId, archType, row.name);
          if (existing) {
            await db.prepare(`UPDATE org_architecture SET description=$1, owner=$2, status=$3, parent_id=$4, updated_at=NOW() WHERE id=$5`)
              .run(row.description||'', row.owner||'', status, parentId, existing.id);
          } else {
            await db.prepare(`INSERT INTO org_architecture (organization_id, arch_type, name, description, owner, status, parent_id) VALUES ($1,$2,$3,$4,$5,$6,$7)`)
              .run(orgId, archType, row.name, row.description||'', row.owner||'', status, parentId);
          }
          results.imported++;

        } else if (dataType === 'requirements') {
          if (!row.clause || !row.title) { results.skipped++; results.errors.push(`Row ${rowNum}: missing clause or title`); continue; }
          const standard = row.standard || 'ISO 27001';
          // Upsert requirement
          let req = await db.prepare('SELECT id FROM standard_requirements WHERE organization_id = $1 AND standard = $2 AND clause = $3 LIMIT 1').get(orgId, standard, row.clause);
          if (req) {
            await db.prepare(`UPDATE standard_requirements SET title=$1, description=$2, category=$3, updated_at=NOW() WHERE id=$4`)
              .run(row.title, row.description||'', row.category||'', req.id);
          } else {
            const ins = await db.prepare(`INSERT INTO standard_requirements (organization_id, standard, clause, title, description, category) VALUES ($1,$2,$3,$4,$5,$6)`)
              .run(orgId, standard, row.clause, row.title, row.description||'', row.category||'');
            req = { id: ins.lastInsertRowid };
          }
          // Cross-link to architecture process if provided
          if (row.process_name) {
            const arch = await db.prepare('SELECT id FROM org_architecture WHERE organization_id = $1 AND LOWER(name) = LOWER($2) LIMIT 1').get(orgId, row.process_name);
            if (arch) {
              await db.prepare(`
                INSERT INTO cross_links (organization_id, source_type, source_id, target_type, target_id)
                VALUES ($1,'requirement',$2,'process',$3)
                ON CONFLICT DO NOTHING
              `).run(orgId, req.id, arch.id);
            }
          }
          results.imported++;

        } else if (dataType === 'tasks') {
          if (!row.title) { results.skipped++; results.errors.push(`Row ${rowNum}: missing title`); continue; }
          const validRec = ['daily','weekly','biweekly','monthly','quarterly','yearly'];
          const recurrence = validRec.includes(row.recurrence) ? row.recurrence : 'monthly';
          const priority = row.priority ? row.priority.charAt(0).toUpperCase() + row.priority.slice(1).toLowerCase() : 'Medium';
          await db.prepare(`
            INSERT INTO tasks (organization_id, title, description, assignee, recurrence, category, priority, start_date, next_due)
            VALUES ($1,$2,$3,$4,$5,$6,$7,CURRENT_DATE,CURRENT_DATE)
          `).run(orgId, row.title, row.description||'', row.assignee||'', recurrence, row.category||'General', priority);
          results.imported++;

        } else if (dataType === 'actions') {
          if (!row.title) { results.skipped++; results.errors.push(`Row ${rowNum}: missing title`); continue; }
          const priority = row.priority ? row.priority.charAt(0).toUpperCase() + row.priority.slice(1).toLowerCase() : 'Medium';
          await db.prepare(`
            INSERT INTO actions (organization_id, title, description, assignee, priority, status, due_date)
            VALUES ($1,$2,$3,$4,$5,'open',$6)
          `).run(orgId, row.title, row.description||'', row.assignee||'', priority, row.due_date||null);
          results.imported++;

        } else if (dataType === 'nonconformities') {
          if (!row.description) { results.skipped++; results.errors.push(`Row ${rowNum}: missing description`); continue; }
          const audit = await db.prepare('SELECT id FROM audits WHERE organization_id = $1 ORDER BY created_at DESC LIMIT 1').get(orgId);
          if (!audit) { results.skipped++; results.errors.push(`Row ${rowNum}: no audit found – create an audit first`); continue; }
          const validSev = ['minor','major'];
          const severity = validSev.includes(row.severity) ? row.severity : 'minor';
          const validStat = ['open','in_progress','closed','verified'];
          const status = validStat.includes(row.status) ? row.status : 'open';
          await db.prepare(`
            INSERT INTO non_conformities (organization_id, audit_id, description, severity, clause, responsible, status)
            VALUES ($1,$2,$3,$4,$5,$6,$7)
          `).run(orgId, audit.id, row.description, severity, row.clause||'', row.responsible||'', status);
          results.imported++;

        } else if (dataType === 'documents') {
          if (!row.title) { results.skipped++; results.errors.push(`Row ${rowNum}: missing title`); continue; }
          const validTypes = ['policy','procedure','work_instruction','record','form','report','evidence','other'];
          const docType = validTypes.includes(row.doc_type) ? row.doc_type : 'policy';
          const validStat = ['draft','review','approved','obsolete'];
          const status = validStat.includes(row.status) ? row.status : 'draft';
          await db.prepare(`
            INSERT INTO documents (organization_id, title, doc_type, version, owner, status, review_date)
            VALUES ($1,$2,$3,$4,$5,$6,$7)
          `).run(orgId, row.title, docType, row.version||'1.0', row.owner||'', status, row.review_date||null);
          results.imported++;
        }
      } catch (err) {
        results.errors.push(`Row ${rowNum}: ${err.message}`);
        results.skipped++;
      }
    }
    return results;
  }

  function buildImportTemplate() {
    const wb = XLSX.utils.book_new();

    // Shared style helpers (xlsx CE supports limited cell styling via !cols / !rows)
    const col = w => ({ wch: w });

    // ── Sheet definitions ────────────────────────────────────────────────────
    const sheets = [
      {
        name: 'Instructions',
        headerColor: null,
        colWidths: [28, 60],
        rows: [
          ['BOP Compliance Platform – Master Import Template', ''],
          ['', ''],
          ['How to use this file:', ''],
          ['1. Fill in the relevant sheet(s) for the data you want to import.', ''],
          ['2. Do NOT rename the column headers – the AI uses them to map your data.', ''],
          ['3. Delete the example rows before importing (rows starting with "EXAMPLE").', ''],
          ['4. Upload the file via the Agent → Import button in the app.', ''],
          ['5. You can upload one sheet at a time or all sheets in one file – the agent detects the type automatically.', ''],
          ['', ''],
          ['Sheet', 'What it imports'],
          ['Risks', 'Risk register entries'],
          ['Risk_Treatments', 'Treatment / control actions linked to a risk (by title)'],
          ['Architecture', 'Roles, processes, systems, assets, facilities'],
          ['Requirements', 'Standard clauses (ISO 27001, ISO 9001 etc.) + optional link to a process'],
          ['Tasks', 'Recurring compliance tasks'],
          ['Actions', 'One-off follow-up action items'],
          ['Nonconformities', 'Non-conformities (attached to the most recent audit)'],
          ['Documents', 'Document register entries (metadata only, no file)'],
          ['', ''],
          ['Notes:', ''],
          ['• likelihood / impact: integers 1 (very low) to 5 (very high)', ''],
          ['• Dates: use YYYY-MM-DD format (e.g. 2025-12-31)', ''],
          ['• arch_type must be exactly: role | process | system | asset | facility', ''],
          ['• risk_title in Risk_Treatments must exactly match a title in the Risks sheet (or an existing risk in the app)', ''],
          ['• process_name in Requirements links to an architecture item by name (fuzzy match is case-insensitive)', ''],
          ['• Priority values: Low | Medium | High | Critical', ''],
          ['• Recurrence values: daily | weekly | biweekly | monthly | quarterly | yearly', ''],
        ],
      },
      {
        name: 'Risks',
        colWidths: [30, 50, 25, 12, 10, 25, 20],
        headers: ['title','description','category','likelihood','impact','risk_owner','status'],
        notes:   ['Required. Short name','Full description','e.g. Operational, Compliance, Financial, Information Security','1–5 (1=very low)','1–5 (1=very low)','Responsible person','identified | analyzing | treating | accepted | closed'],
        examples: [
          ['Unauthorised access to customer data','A breach of the customer database by an external attacker','Information Security',4,4,'John Smith','identified'],
          ['GDPR non-compliance','Failure to maintain adequate records of processing activities','Compliance',3,5,'Jane Doe','analyzing'],
          ['Key supplier failure','Single-source supplier goes out of business','Operational',2,4,'Operations Manager','treating'],
        ],
      },
      {
        name: 'Risk_Treatments',
        colWidths: [32, 50, 20, 15, 25],
        headers: ['risk_title','description','status','due_date','responsible'],
        notes:   ['Required. Must match a risk title exactly','What will be done','planned | in_progress | implemented | verified','YYYY-MM-DD','Person responsible'],
        examples: [
          ['Unauthorised access to customer data','Implement multi-factor authentication for all admin accounts','planned','2025-06-30','IT Security Lead'],
          ['Unauthorised access to customer data','Conduct penetration test of customer portal','in_progress','2025-04-15','IT Manager'],
          ['GDPR non-compliance','Appoint a Data Protection Officer and document all processing activities','planned','2025-07-31','Legal Counsel'],
        ],
      },
      {
        name: 'Architecture',
        colWidths: [15, 30, 45, 22, 12, 28],
        headers: ['arch_type','name','description','owner','status','parent_name'],
        notes:   ['Required: role | process | system | asset | facility','Required. Item name','What this item does / is','Owner / manager','active | inactive','Name of parent item (leave blank if none)'],
        examples: [
          ['process','Customer Onboarding','End-to-end process for onboarding new customers','Sales Director','active',''],
          ['role','Data Protection Officer','Responsible for GDPR compliance and data governance','Jane Doe','active',''],
          ['system','CRM Platform','Customer relationship management system (Salesforce)','IT Manager','active',''],
          ['asset','Customer Database','Primary PostgreSQL database containing customer PII','IT Manager','active','CRM Platform'],
          ['facility','Head Office','Main office location in Amsterdam','Facilities Manager','active',''],
        ],
      },
      {
        name: 'Requirements',
        colWidths: [18, 12, 40, 50, 22, 28],
        headers: ['standard','clause','title','description','category','process_name'],
        notes:   ['e.g. ISO 27001, ISO 9001','Required: e.g. 4.1','Required. Requirement title','Full requirement text','Category / theme','Architecture process to cross-link (leave blank if none)'],
        examples: [
          ['ISO 27001','4.1','Understanding the organisation','Determine external and internal issues relevant to the ISMS','Context','Strategic Planning'],
          ['ISO 27001','6.1.2','Information security risk assessment','Establish and apply a risk assessment process','Risk','Risk Management Process'],
          ['ISO 9001','8.1','Operational planning and control','Plan, implement, control, monitor and review processes','Operations','Customer Onboarding'],
        ],
      },
      {
        name: 'Tasks',
        colWidths: [32, 45, 22, 15, 20, 12],
        headers: ['title','description','assignee','recurrence','category','priority'],
        notes:   ['Required','What needs to be done','Person responsible','daily | weekly | biweekly | monthly | quarterly | yearly','Task category','Low | Medium | High | Critical'],
        examples: [
          ['Monthly backup verification','Verify that all system backups completed successfully and are restorable','IT Manager','monthly','IT Operations','High'],
          ['Quarterly security awareness training','Deliver security awareness training session to all staff','HR Manager','quarterly','Training','Medium'],
          ['Annual penetration test','Commission and complete external penetration test of production systems','IT Security Lead','yearly','Security','High'],
        ],
      },
      {
        name: 'Actions',
        colWidths: [32, 45, 22, 12, 15],
        headers: ['title','description','assignee','priority','due_date'],
        notes:   ['Required','Details','Person responsible','Low | Medium | High | Critical','YYYY-MM-DD'],
        examples: [
          ['Update privacy notice on website','Review and update the public privacy notice to reflect new processing activities','Legal Counsel','High','2025-05-31'],
          ['Remediate open firewall ports','Close unnecessary open ports identified in last vulnerability scan','IT Security Lead','Critical','2025-04-01'],
          ['Complete DPA with new processor','Execute a Data Processing Agreement with the new payroll provider','Legal Counsel','Medium','2025-06-15'],
        ],
      },
      {
        name: 'Nonconformities',
        colWidths: [55, 10, 12, 22, 15],
        headers: ['description','severity','clause','responsible','status'],
        notes:   ['Required. Full description of the non-conformity','minor | major','Related ISO clause e.g. 8.1','Responsible person','open | in_progress | closed | verified'],
        examples: [
          ['Backup restore procedure has not been tested in the last 12 months as required by the backup policy','minor','A.12.3','IT Manager','open'],
          ['No evidence of management review meeting held in current calendar year','major','9.3','Quality Manager','in_progress'],
          ['Third-party supplier risk assessment overdue by 6 months','minor','A.15.2','Procurement Manager','open'],
        ],
      },
      {
        name: 'Documents',
        colWidths: [35, 20, 10, 22, 12, 15],
        headers: ['title','doc_type','version','owner','status','review_date'],
        notes:   ['Required','policy | procedure | work_instruction | record | form | report | evidence | other','e.g. 1.0','Document owner','draft | review | approved | obsolete','YYYY-MM-DD'],
        examples: [
          ['Information Security Policy','policy','3.1','CISO','approved','2026-01-01'],
          ['Incident Response Procedure','procedure','2.0','IT Security Lead','approved','2025-12-01'],
          ['Risk Assessment Record – 2024','record','1.0','Risk Manager','approved',''],
          ['Access Control Work Instruction','work_instruction','1.2','IT Manager','review','2025-09-01'],
        ],
      },
    ];

    // ── Build each sheet ─────────────────────────────────────────────────────
    for (const def of sheets) {
      const wsData = [];

      if (def.name === 'Instructions') {
        wsData.push(...def.rows);
      } else {
        // Row 1: Notes / valid values
        wsData.push(def.notes);
        // Row 2: Bold column headers
        wsData.push(def.headers);
        // Example rows
        for (const ex of def.examples) {
          wsData.push(ex);
        }
      }

      const ws = XLSX.utils.aoa_to_sheet(wsData);

      // Column widths
      ws['!cols'] = def.colWidths.map(col);

      // Freeze the header row (row 2 for data sheets, row 1 for Instructions)
      if (def.name !== 'Instructions') {
        ws['!freeze'] = { xSplit: 0, ySplit: 2 };
      }

      XLSX.utils.book_append_sheet(wb, ws, def.name);
    }

    return XLSX.write(wb, { type: 'buffer', bookType: 'xlsx' });
  }

  app.get('/api/agent/import/template', requireOrgContext, (req, res) => {
    try {
      const buf = buildImportTemplate();
      res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
      res.setHeader('Content-Disposition', 'attachment; filename="BOP_Import_Template.xlsx"');
      res.send(buf);
    } catch (err) {
      console.error('[Import Template] error:', err);
      res.status(500).json({ error: 'Failed to generate template.' });
    }
  });

  app.post('/api/agent/import', requireOrgContext, upload.single('file'), async (req, res) => {
    const openai = getOpenAI();
    if (!openai) return res.status(503).json({ error: 'AI Agent is not configured (missing OPENAI_API_KEY).' });
    if (!req.file) return res.status(400).json({ error: 'No file uploaded.' });

    // Load user permissions
    const userRecord = await db.prepare('SELECT permissions FROM users WHERE id = $1').get(req.session.userId);
    let userPerms = [];
    try { userPerms = JSON.parse(userRecord?.permissions || '[]'); } catch (_) {}
    if (['superadmin','org_admin','admin'].includes(req.session.userRole)) {
      userPerms = ['org', 'risk', 'ops', 'audit'];
    }

    const { data_type: hintedType, message } = req.body;

    // 1. Parse all sheets from the file
    let sheets;
    try {
      sheets = parseImportFile(req.file.buffer, req.file.originalname);
    } catch (err) {
      console.error('[Import] parse error:', err.message);
      return res.status(400).json({ error: `Could not parse file: ${err.message}` });
    }
    if (sheets.length > 10) return res.status(400).json({ error: 'Import at most 10 sheets at a time' });
    if (sheets.length === 0) return res.status(400).json({ error: 'File is empty or contains no importable data.' });

    const MAX_ROWS = 500;
    const sheetResults = [];
    let totalImported = 0;
    let totalSkipped = 0;

    for (const { sheetName, headers, rows } of sheets) {
      // Resolve data type: tab name takes priority, then caller hint, then OpenAI detection
      const nameKey = sheetName.toLowerCase().trim();
      let dataType = SHEET_NAME_TO_TYPE[nameKey] || (sheets.length === 1 ? hintedType : null);

      const workingRows = rows.slice(0, MAX_ROWS);
      const truncated = rows.length > MAX_ROWS;

      // Skip rows that look like the template's notes row (first cell matches a known notes phrase)
      const dataRows = workingRows.filter(r => {
        const firstVal = String(Object.values(r)[0] || '').trim();
        return firstVal !== '' && !firstVal.startsWith('Required') && !firstVal.startsWith('e.g.');
      });

      if (dataRows.length === 0) {
        continue;
      }

      // If type still unknown, ask OpenAI
      if (!dataType || !IMPORT_SCHEMAS[dataType]) {
        try {
          ({ data_type: dataType } = await detectAndMap(openai, headers, dataRows, hintedType, message));
        } catch (err) {
          sheetResults.push({ sheet: sheetName, error: `Type detection failed: ${err.message}` });
          continue;
        }
      }

      if (!IMPORT_SCHEMAS[dataType]) {
        sheetResults.push({ sheet: sheetName, error: `Unrecognised data type: "${dataType}"` });
        continue;
      }

      // Permission check
      const requiredPerm = IMPORT_TYPE_PERMISSIONS[dataType];
      if (!userPerms.includes(requiredPerm)) {
        sheetResults.push({ sheet: sheetName, data_type: dataType, error: `Permission denied (requires '${requiredPerm}' module access)` });
        continue;
      }

      // Get column mapping (use cached type-based mapping for named sheets, OpenAI otherwise)
      let mapping;
      try {
        ({ mapping } = await detectAndMap(openai, headers, dataRows, dataType, message));
      } catch (err) {
        sheetResults.push({ sheet: sheetName, data_type: dataType, error: `Column mapping failed: ${err.message}` });
        continue;
      }


      const mappedRows = applyMapping(dataRows, mapping);
      const results = await bulkInsert(dataType, mappedRows, req.orgId);

      totalImported += results.imported;
      totalSkipped  += results.skipped;
      sheetResults.push({
        sheet:     sheetName,
        data_type: dataType,
        rows:      dataRows.length,
        imported:  results.imported,
        skipped:   results.skipped,
        truncated,
        errors:    results.errors,
      });
    }

    // Build human-readable summary
    const summaryLines = [`**Import complete** — ${totalImported} record(s) imported across ${sheetResults.filter(s => !s.error).length} sheet(s).`];
    for (const s of sheetResults) {
      if (s.error) {
        summaryLines.push(`• ${s.sheet}: ⚠ ${s.error}`);
      } else {
        const line = [`• ${s.sheet} (${s.data_type}): ✓ ${s.imported} imported`];
        if (s.skipped)   line.push(`⚠ ${s.skipped} skipped`);
        if (s.truncated) line.push(`(capped at ${MAX_ROWS} rows)`);
        summaryLines.push(line.join(', '));
        if (s.errors?.length) {
          summaryLines.push(...s.errors.slice(0, 5).map(e => `  – ${e}`));
          if (s.errors.length > 5) summaryLines.push(`  – …and ${s.errors.length - 5} more`);
        }
      }
    }

    res.json({ sheets: sheetResults, imported: totalImported, skipped: totalSkipped, summary: summaryLines.join('\n') });
  });
}

module.exports = { registerImportsRoutes };
