// Register on the shared app to retain middleware and transaction boundaries.
function registerAgentRoutes(app, { HttpError, completeTaskSeries, db, getOpenAI, requireOrgContext, updateChecklistItem, updateFollowup }) {
  // ===== AI AGENT =====
  const AGENT_SYSTEM_PROMPT =
    'You are an AI assistant for BOP (Business Orchestration Platform), an ISO and compliance ' +
    'management system. You help users manage their compliance activities. You have full access to ' +
    "the organization's data and can read AND write records on behalf of the user. " +
    'You can: create and update risks, add risk treatments, create and close non-conformities, ' +
    'complete and update tasks, create and resolve actions, create and update audits, rate audit ' +
    'checklist items, and register documents. ' +
    'Always use the available tools to take real action — do not just describe what you would do. ' +
    'After taking an action, confirm what you did with a brief summary. ' +
    'Be professional, concise and compliance-focused. When unsure of an ID, first use a get_ tool to look it up.';

  // Maps each agent tool to the permission string required to use it.
  // Permission values mirror the users.permissions column: 'org', 'risk', 'ops', 'audit', 'admin'
  const AGENT_TOOL_PERMISSIONS = {
    get_dashboard_summary:    'org',
    get_documents:            'org',
    create_document:          'org',
    get_open_actions:         'org',
    create_action:            'org',
    update_action:            'org',
    get_tasks:                'ops',
    create_task:              'ops',
    complete_task:            'ops',
    update_task:              'ops',
    get_risks:                'risk',
    create_risk:              'risk',
    update_risk:              'risk',
    create_treatment:         'risk',
    update_treatment:         'risk',
    get_nonconformities:      'audit',
    create_nonconformity:     'audit',
    update_nonconformity:     'audit',
    get_audits:                  'audit',
    create_audit:                'audit',
    update_audit:                'audit',
    rate_checklist_item:         'audit',
    get_management_reviews:      'org',
    create_management_review:    'org',
    get_mission:                 'org',
    update_mission:              'org',
    get_architecture:            'org',
    create_architecture_item:    'org',
    update_architecture_item:    'org',
    delete_architecture_item:    'org',
  };

  const AGENT_TOOLS = [
    {
      type: 'function',
      function: {
        name: 'get_dashboard_summary',
        description: 'Fetches KPI counts: open risks, open non-conformities, overdue tasks, upcoming audits (next 30 days), total documents.',
        parameters: { type: 'object', properties: {}, required: [] },
      },
    },
    {
      type: 'function',
      function: {
        name: 'get_risks',
        description: 'Fetches the risk register. Optionally filter by status.',
        parameters: {
          type: 'object',
          properties: {
            status: { type: 'string', description: 'identified | analyzing | treating | accepted | closed', enum: ['identified', 'analyzing', 'treating', 'accepted', 'closed'] },
          },
          required: [],
        },
      },
    },
    {
      type: 'function',
      function: {
        name: 'create_risk',
        description: 'Creates a new risk in the risk register.',
        parameters: {
          type: 'object',
          properties: {
            title:       { type: 'string', description: 'Short descriptive title' },
            description: { type: 'string', description: 'Full description' },
            likelihood:  { type: 'number', description: 'Likelihood 1–5' },
            impact:      { type: 'number', description: 'Impact 1–5' },
            category:    { type: 'string', description: 'Must be an existing risk category from the system (see available options in context). Leave blank if none match.' },
            owner:       { type: 'string', description: 'Must be an active user from the system (see available users in context). Leave blank if not found.' },
          },
          required: ['title', 'likelihood', 'impact'],
        },
      },
    },
    {
      type: 'function',
      function: {
        name: 'get_nonconformities',
        description: 'Fetches non-conformities. Optionally filter by status.',
        parameters: {
          type: 'object',
          properties: {
            status: { type: 'string', description: 'open | in_progress | closed | verified', enum: ['open', 'in_progress', 'closed', 'verified'] },
          },
          required: [],
        },
      },
    },
    {
      type: 'function',
      function: {
        name: 'create_nonconformity',
        description: 'Creates a new non-conformity attached to the most recent audit.',
        parameters: {
          type: 'object',
          properties: {
            title:       { type: 'string', description: 'Short title' },
            description: { type: 'string', description: 'Description' },
            severity:    { type: 'string', description: 'minor | major', enum: ['minor', 'major'] },
            clause:      { type: 'string', description: 'Related ISO clause e.g. 6.1.2' },
            assigned_to: { type: 'string', description: 'Must be an active user from the system (see context). Leave blank if not found.' },
          },
          required: ['title', 'severity'],
        },
      },
    },
    {
      type: 'function',
      function: {
        name: 'get_tasks',
        description: 'Fetches recurring compliance tasks. Optionally filter by status or assignee.',
        parameters: {
          type: 'object',
          properties: {
            status:   { type: 'string', description: 'active | inactive' },
            assignee: { type: 'string', description: 'Filter by assignee name (partial match)' },
          },
          required: [],
        },
      },
    },
    {
      type: 'function',
      function: {
        name: 'create_task',
        description: 'Creates a new recurring compliance task.',
        parameters: {
          type: 'object',
          properties: {
            title:       { type: 'string', description: 'Task title' },
            description: { type: 'string', description: 'What needs to be done' },
            assignee:    { type: 'string', description: 'Must be an active user from the system (see available users in context). Leave blank if not found.' },
            recurrence:  { type: 'string', description: 'daily | weekly | biweekly | monthly | quarterly | yearly', enum: ['daily', 'weekly', 'biweekly', 'monthly', 'quarterly', 'yearly'] },
            category:    { type: 'string', description: 'Must be an existing task category from the system (see available options in context). Leave blank if none match.' },
            priority:    { type: 'string', description: 'Low | Medium | High | Critical', enum: ['Low', 'Medium', 'High', 'Critical'] },
          },
          required: ['title', 'recurrence'],
        },
      },
    },
    {
      type: 'function',
      function: {
        name: 'get_audits',
        description: 'Fetches audits from the audit plan.',
        parameters: {
          type: 'object',
          properties: {
            status: { type: 'string', description: 'planned | in_progress | completed', enum: ['planned', 'in_progress', 'completed'] },
          },
          required: [],
        },
      },
    },
    {
      type: 'function',
      function: {
        name: 'get_documents',
        description: 'Fetches the document register.',
        parameters: { type: 'object', properties: {}, required: [] },
      },
    },
    {
      type: 'function',
      function: {
        name: 'get_open_actions',
        description: 'Fetches all open follow-up actions.',
        parameters: { type: 'object', properties: {}, required: [] },
      },
    },
    {
      type: 'function',
      function: {
        name: 'complete_task',
        description: 'Marks a recurring compliance task as completed for this cycle, advancing its next due date.',
        parameters: {
          type: 'object',
          properties: {
            expected_due: {type:'string',description:'The next_due date from get_tasks. Required to prevent completing the wrong occurrence.'},
            task_id:      { type: 'number', description: 'ID of the task to complete' },
            completed_by: { type: 'string', description: 'Name of person completing the task' },
            notes:        { type: 'string', description: 'Completion notes' },
          },
          required: ['task_id','expected_due'],
        },
      },
    },
    {
      type: 'function',
      function: {
        name: 'update_task',
        description: 'Updates fields of an existing compliance task (title, assignee, priority, recurrence, status, etc.).',
        parameters: {
          type: 'object',
          properties: {
            task_id:    { type: 'number', description: 'ID of the task' },
            title:      { type: 'string' },
            description:{ type: 'string' },
            assignee:   { type: 'string', description: 'Must be an active user from the system (see context). Leave blank if not found.' },
            priority:   { type: 'string', enum: ['Low', 'Medium', 'High', 'Critical'] },
            recurrence: { type: 'string', enum: ['daily', 'weekly', 'biweekly', 'monthly', 'quarterly', 'yearly'] },
            category:   { type: 'string', description: 'Must be an existing task category from the system (see context). Leave blank if none match.' },
            status:     { type: 'string', enum: ['active', 'inactive'] },
          },
          required: ['task_id'],
        },
      },
    },
    {
      type: 'function',
      function: {
        name: 'update_risk',
        description: 'Updates an existing risk (status, likelihood, impact, owner, description, etc.).',
        parameters: {
          type: 'object',
          properties: {
            risk_id:       { type: 'number', description: 'ID of the risk' },
            title:         { type: 'string' },
            description:   { type: 'string' },
            likelihood:    { type: 'number', description: '1–5' },
            impact:        { type: 'number', description: '1–5' },
            category:      { type: 'string', description: 'Must be an existing risk category from the system (see context). Leave blank if none match.' },
            status:        { type: 'string', enum: ['identified', 'analyzing', 'treating', 'accepted', 'closed'] },
            risk_owner:    { type: 'string', description: 'Must be an active user from the system (see context). Leave blank if not found.' },
            source:        { type: 'string' },
            asset:         { type: 'string' },
            threat:        { type: 'string' },
            vulnerability: { type: 'string' },
          },
          required: ['risk_id'],
        },
      },
    },
    {
      type: 'function',
      function: {
        name: 'update_nonconformity',
        description: 'Updates a non-conformity: set status, add root cause, correction, corrective action, assign responsible, set due date.',
        parameters: {
          type: 'object',
          properties: {
            nc_id:              { type: 'number', description: 'ID of the non-conformity' },
            status:             { type: 'string', enum: ['open', 'in_progress', 'closed', 'verified'] },
            root_cause:         { type: 'string' },
            correction:         { type: 'string' },
            corrective_action:  { type: 'string' },
            responsible:        { type: 'string', description: 'Must be an active user from the system (see context). Leave blank if not found.' },
            due_date:           { type: 'string', description: 'ISO date YYYY-MM-DD' },
            verification_notes: { type: 'string' },
            severity:           { type: 'string', enum: ['minor', 'major'] },
          },
          required: ['nc_id'],
        },
      },
    },
    {
      type: 'function',
      function: {
        name: 'create_action',
        description: 'Creates a new follow-up action item.',
        parameters: {
          type: 'object',
          properties: {
            title:       { type: 'string', description: 'Short action title' },
            description: { type: 'string' },
            assignee:    { type: 'string', description: 'Must be an active user from the system (see context). Leave blank if not found.' },
            priority:    { type: 'string', enum: ['Low', 'Medium', 'High', 'Critical'] },
            due_date:    { type: 'string', description: 'ISO date YYYY-MM-DD' },
          },
          required: ['title'],
        },
      },
    },
    {
      type: 'function',
      function: {
        name: 'update_action',
        description: 'Updates a follow-up action: close/resolve it, change assignee, priority, or due date.',
        parameters: {
          type: 'object',
          properties: {
            action_id:   { type: 'number', description: 'ID of the action' },
            title:       { type: 'string' },
            description: { type: 'string' },
            assignee:    { type: 'string', description: 'Must be an active user from the system (see context). Leave blank if not found.' },
            priority:    { type: 'string', enum: ['Low', 'Medium', 'High', 'Critical'] },
            status:      { type: 'string', enum: ['open', 'in_progress', 'resolved', 'closed'] },
            due_date:    { type: 'string', description: 'ISO date YYYY-MM-DD' },
            resolved_by: { type: 'string', description: 'Must be an active user from the system (see context). Leave blank if not found.' },
          },
          required: ['action_id'],
        },
      },
    },
    {
      type: 'function',
      function: {
        name: 'create_audit',
        description: 'Creates a new audit in the audit plan.',
        parameters: {
          type: 'object',
          properties: {
            title:         { type: 'string', description: 'Audit title' },
            standard:      { type: 'string', description: 'e.g. ISO 27001, ISO 9001' },
            planned_date:  { type: 'string', description: 'ISO date YYYY-MM-DD' },
            lead_auditor:  { type: 'string', description: 'Must be an active user from the system (see context). Leave blank if not found.' },
            scope:         { type: 'string' },
          },
          required: ['title', 'planned_date'],
        },
      },
    },
    {
      type: 'function',
      function: {
        name: 'update_audit',
        description: 'Updates an audit: change status (planned → in_progress → completed), update planned date, lead auditor, etc.',
        parameters: {
          type: 'object',
          properties: {
            audit_id:       { type: 'number', description: 'ID of the audit' },
            status:         { type: 'string', enum: ['planned', 'in_progress', 'completed'] },
            planned_date:   { type: 'string', description: 'ISO date YYYY-MM-DD' },
            completed_date: { type: 'string', description: 'ISO date YYYY-MM-DD' },
            lead_auditor:   { type: 'string', description: 'Must be an active user from the system (see context). Leave blank if not found.' },
            title:          { type: 'string' },
            scope:          { type: 'string' },
          },
          required: ['audit_id'],
        },
      },
    },
    {
      type: 'function',
      function: {
        name: 'create_treatment',
        description: 'Adds a risk treatment to an existing risk.',
        parameters: {
          type: 'object',
          properties: {
            risk_id:     { type: 'number', description: 'ID of the risk' },
            description: { type: 'string', description: 'What will be done to treat the risk' },
            status:      { type: 'string', enum: ['planned', 'in_progress', 'implemented', 'verified'], description: 'Default: planned' },
            due_date:    { type: 'string', description: 'ISO date YYYY-MM-DD' },
            owner:       { type: 'string', description: 'Must be an active user from the system (see context). Leave blank if not found.' },
          },
          required: ['risk_id', 'description'],
        },
      },
    },
    {
      type: 'function',
      function: {
        name: 'update_treatment',
        description: 'Updates a risk treatment status or description.',
        parameters: {
          type: 'object',
          properties: {
            treatment_id: { type: 'number', description: 'ID of the treatment' },
            description:  { type: 'string' },
            status:       { type: 'string', enum: ['planned', 'in_progress', 'implemented', 'verified'] },
            due_date:     { type: 'string', description: 'ISO date YYYY-MM-DD' },
            responsible:  { type: 'string', description: 'Must be an active user from the system (see context). Leave blank if not found.' },
          },
          required: ['treatment_id'],
        },
      },
    },
    {
      type: 'function',
      function: {
        name: 'get_management_reviews',
        description: 'Fetches management reviews (ISO management review meetings). Optionally filter by status.',
        parameters: {
          type: 'object',
          properties: {
            status: { type: 'string', description: 'scheduled | in_progress | completed', enum: ['scheduled', 'in_progress', 'completed'] },
          },
          required: [],
        },
      },
    },
    {
      type: 'function',
      function: {
        name: 'create_management_review',
        description: 'Plans (creates) a new management review meeting.',
        parameters: {
          type: 'object',
          properties: {
            title:            { type: 'string', description: 'Title of the management review' },
            review_date:      { type: 'string', description: 'ISO date YYYY-MM-DD when the review is planned' },
            chairperson:      { type: 'string', description: 'Must be an active user from the system (see context). Leave blank if not found.' },
            attendees:        { type: 'string', description: 'Comma-separated list of attendees (use names from available users in context)' },
            next_review_date: { type: 'string', description: 'ISO date YYYY-MM-DD for the next review' },
          },
          required: ['title', 'review_date'],
        },
      },
    },
    {
      type: 'function',
      function: {
        name: 'get_mission',
        description: "Fetches the organization's mission statement, vision, and values.",
        parameters: { type: 'object', properties: {}, required: [] },
      },
    },
    {
      type: 'function',
      function: {
        name: 'update_mission',
        description: "Updates the organization's mission statement, vision, and/or values. Only provided fields are updated.",
        parameters: {
          type: 'object',
          properties: {
            content:     { type: 'string', description: 'Mission statement text' },
            vision:      { type: 'string', description: 'Vision statement text' },
            values_text: { type: 'string', description: 'Values text' },
          },
          required: [],
        },
      },
    },
    {
      type: 'function',
      function: {
        name: 'get_architecture',
        description: 'Fetches architecture items (roles, processes, systems, assets, facilities). Optionally filter by type.',
        parameters: {
          type: 'object',
          properties: {
            arch_type: { type: 'string', description: 'Filter by type', enum: ['role', 'process', 'system', 'asset', 'facility'] },
          },
          required: [],
        },
      },
    },
    {
      type: 'function',
      function: {
        name: 'create_architecture_item',
        description: 'Creates a new architecture item such as a role, process, system, asset, or facility.',
        parameters: {
          type: 'object',
          properties: {
            arch_type:   { type: 'string', description: 'Type of item', enum: ['role', 'process', 'system', 'asset', 'facility'] },
            name:        { type: 'string', description: 'Name of the item' },
            description: { type: 'string', description: 'Description' },
            owner:       { type: 'string', description: 'Must be an active user from the system (see context). Leave blank if not found.' },
            status:      { type: 'string', description: 'active | inactive', enum: ['active', 'inactive'] },
            parent_id:   { type: 'number', description: 'ID of parent architecture item (for hierarchy)' },
          },
          required: ['arch_type', 'name'],
        },
      },
    },
    {
      type: 'function',
      function: {
        name: 'update_architecture_item',
        description: 'Updates an existing architecture item (role, process, system, asset, or facility).',
        parameters: {
          type: 'object',
          properties: {
            item_id:     { type: 'number', description: 'ID of the architecture item' },
            name:        { type: 'string' },
            description: { type: 'string' },
            owner:       { type: 'string', description: 'Must be an active user from the system (see context). Leave blank if not found.' },
            status:      { type: 'string', enum: ['active', 'inactive'] },
            parent_id:   { type: 'number', description: 'ID of parent item (set to 0 to remove parent)' },
          },
          required: ['item_id'],
        },
      },
    },
    {
      type: 'function',
      function: {
        name: 'delete_architecture_item',
        description: 'Deletes an architecture item. Use with caution — this is permanent.',
        parameters: {
          type: 'object',
          properties: {
            item_id: { type: 'number', description: 'ID of the architecture item to delete' },
          },
          required: ['item_id'],
        },
      },
    },
    {
      type: 'function',
      function: {
        name: 'create_document',
        description: 'Registers a document in the document register (metadata only, no file upload).',
        parameters: {
          type: 'object',
          properties: {
            title:       { type: 'string', description: 'Document title' },
            doc_type:    { type: 'string', description: 'e.g. Policy, Procedure, Record, Manual' },
            version:     { type: 'string', description: 'e.g. 1.0' },
            owner:       { type: 'string', description: 'Must be an active user from the system (see context). Leave blank if not found.' },
            status:      { type: 'string', enum: ['draft', 'review', 'approved', 'obsolete'] },
            review_date: { type: 'string', description: 'ISO date YYYY-MM-DD' },
          },
          required: ['title'],
        },
      },
    },
    {
      type: 'function',
      function: {
        name: 'rate_checklist_item',
        description: 'Rates an audit checklist item during audit execution (conformant, non_conformant, not_applicable, open).',
        parameters: {
          type: 'object',
          properties: {
            checklist_id: { type: 'number', description: 'ID of the checklist item' },
            rating:       { type: 'string', enum: ['open', 'conformant', 'non_conformant', 'not_applicable'], description: 'Assessment result' },
            notes:        { type: 'string', description: 'Optional auditor notes' },
          },
          required: ['checklist_id', 'rating'],
        },
      },
    },
  ];

  // Resolves a value against a list of available options (case-insensitive).
  // Returns the matched option with correct casing, '' if the value is empty,
  // or null if the value is non-empty but not found in the available list.
  function resolveFieldOption(value, available) {
    if (!value) return '';
    if (!available || !available.length) return null;
    const lower = String(value).toLowerCase();
    return available.find(opt => String(opt).toLowerCase() === lower) ?? null;
  }

  async function executeAgentTool(toolName, args, orgId, meta = {}) {
    switch (toolName) {
      case 'get_dashboard_summary': {
        const openRisks      = (await db.prepare("SELECT COUNT(*) as c FROM risks WHERE organization_id = $1 AND status NOT IN ('accepted','closed')").get(orgId))?.c ?? 0;
        const openNCs        = (await db.prepare("SELECT COUNT(*) as c FROM non_conformities n JOIN audits a ON n.audit_id = a.id WHERE a.organization_id = $1 AND n.status IN ('open','in_progress')").get(orgId))?.c ?? 0;
        const overdueTasks   = (await db.prepare("SELECT COUNT(*) as c FROM tasks WHERE organization_id = $1 AND is_active = 1 AND next_due < CURRENT_DATE::text").get(orgId))?.c ?? 0;
        const upcomingAudits = (await db.prepare("SELECT COUNT(*) as c FROM audits WHERE organization_id = $1 AND status = 'planned' AND planned_date BETWEEN CURRENT_DATE::text AND (CURRENT_DATE + 30)::text").get(orgId))?.c ?? 0;
        const docCount       = (await db.prepare("SELECT COUNT(*) as c FROM documents WHERE organization_id = $1").get(orgId))?.c ?? 0;
        return { open_risks: openRisks, open_nonconformities: openNCs, overdue_tasks: overdueTasks, upcoming_audits_30d: upcomingAudits, total_documents: docCount };
      }
      case 'get_risks': {
        const params = [orgId];
        let sql = 'SELECT id, title, description, likelihood, impact, inherent_score, status, category, risk_owner, created_at FROM risks WHERE organization_id = $1';
        if (args.status) { sql += ' AND status = $2'; params.push(args.status); }
        sql += ' ORDER BY inherent_score DESC NULLS LAST LIMIT 50';
        const risks = await db.prepare(sql).all(...params);
        return { risks, count: risks.length };
      }
      case 'create_risk': {
        const { title, description = '', likelihood, impact } = args;
        const category = resolveFieldOption(args.category, meta.riskCategories) ?? '';
        const owner = resolveFieldOption(args.owner, meta.userNames) ?? '';
        const score = Math.round((likelihood ?? 1) * (impact ?? 1));
        const result = await db.prepare(`
          INSERT INTO risks (organization_id, title, description, likelihood, impact, inherent_score, category, risk_owner, status)
          VALUES ($1, $2, $3, $4, $5, $6, $7, $8, 'identified')
        `).run(orgId, title, description, likelihood, impact, score, category, owner);
        return { success: true, id: result.lastInsertRowid, title, inherent_score: score };
      }
      case 'get_nonconformities': {
        const params = [orgId];
        let sql = `SELECT n.id, n.description, n.severity, n.status, n.clause, n.responsible, n.created_at
                   FROM non_conformities n JOIN audits a ON n.audit_id = a.id WHERE a.organization_id = $1`;
        if (args.status) { sql += ' AND n.status = $2'; params.push(args.status); }
        sql += ' ORDER BY n.created_at DESC LIMIT 50';
        const ncs = await db.prepare(sql).all(...params);
        return { nonconformities: ncs, count: ncs.length };
      }
      case 'create_nonconformity': {
        const latest = await db.prepare('SELECT id FROM audits WHERE organization_id = $1 ORDER BY created_at DESC LIMIT 1').get(orgId);
        if (!latest) return { error: 'No audit found. Please create an audit first before adding a non-conformity.' };
        const { title = '', description = '', severity = 'minor', clause = '' } = args;
        const assigned_to = resolveFieldOption(args.assigned_to, meta.userNames) ?? '';
        // non_conformities has no title column — combine title+description into description
        const fullDescription = title ? (description ? `${title}: ${description}` : title) : description;
        const result = await db.prepare(`
          INSERT INTO non_conformities (organization_id, audit_id, description, severity, status, clause, responsible)
          VALUES ($1, $2, $3, $4, 'open', $5, $6)
        `).run(orgId, latest.id, fullDescription, severity, clause, assigned_to);
        return { success: true, id: result.lastInsertRowid, description: fullDescription, severity, audit_id: latest.id };
      }
      case 'get_tasks': {
        const params = [orgId];
        let sql = 'SELECT id, title, description, assignee, recurrence, category, priority, is_active, next_due FROM tasks WHERE organization_id = $1';
        if (args.status === 'active')   { sql += ` AND is_active = 1`; }
        if (args.status === 'inactive') { sql += ` AND is_active = 0`; }
        if (args.assignee) { sql += ` AND assignee ILIKE $${params.length + 1}`; params.push(`%${args.assignee}%`); }
        sql += ' ORDER BY next_due ASC NULLS LAST LIMIT 50';
        const tasks = await db.prepare(sql).all(...params);
        return { tasks, count: tasks.length };
      }
      case 'create_task': {
        const { title, description = '', recurrence, priority = 'Medium' } = args;
        const category = resolveFieldOption(args.category, meta.taskCategories) ?? '';
        const assignee = resolveFieldOption(args.assignee, meta.userNames) ?? '';
        // Normalize priority to title-case to match schema CHECK constraint
        const normPriority = priority.charAt(0).toUpperCase() + priority.slice(1).toLowerCase();
        // Normalize recurrence: agent may send 'annually' but schema uses 'yearly'
        const normRecurrence = recurrence === 'annually' ? 'yearly' : recurrence;
        const result = await db.prepare(`
          INSERT INTO tasks (organization_id, title, description, assignee, recurrence, category, priority, start_date, next_due)
          VALUES ($1, $2, $3, $4, $5, $6, $7, CURRENT_DATE, CURRENT_DATE)
        `).run(orgId, title, description, assignee, normRecurrence, category, normPriority);
        return { success: true, id: result.lastInsertRowid, title, recurrence: normRecurrence };
      }
      case 'get_audits': {
        const params = [orgId];
        let sql = 'SELECT id, title, standard, status, planned_date, completed_date, lead_auditor FROM audits WHERE organization_id = $1';
        if (args.status) { sql += ' AND status = $2'; params.push(args.status); }
        sql += ' ORDER BY planned_date DESC LIMIT 30';
        const audits = await db.prepare(sql).all(...params);
        return { audits, count: audits.length };
      }
      case 'get_documents': {
        const docs = await db.prepare(`
          SELECT id, title, doc_type, version, status, owner, review_date
          FROM documents WHERE organization_id = $1 ORDER BY updated_at DESC LIMIT 50
        `).all(orgId);
        return { documents: docs, count: docs.length };
      }
      case 'get_open_actions': {
        const actions = await db.prepare(`
          SELECT id, title, description, assignee, due_date, status, priority
          FROM actions WHERE organization_id = $1 AND status = 'open' ORDER BY due_date ASC NULLS LAST LIMIT 50
        `).all(orgId);
        return { actions, count: actions.length };
      }
      case 'complete_task': {
        if(!args.expected_due) throw new HttpError(400,'Read the task first and provide its next_due as expected_due.');
        const task=await completeTaskSeries(orgId,args.task_id,args);
        return {success:true,task_id:task.id,instance_id:task.instance_id,next_due:task.next_due};
      }
      case 'update_task': {
        const { task_id, ...fields } = args;
        const allowed = ['title', 'description', 'assignee', 'priority', 'recurrence', 'category'];
        let updates = Object.entries(fields).filter(([k]) => allowed.includes(k));
        // Normalize priority casing and validate option-constrained fields
        updates = updates.map(([k, v]) => {
          if (k === 'priority') return [k, v.charAt(0).toUpperCase() + v.slice(1).toLowerCase()];
          if (k === 'recurrence') return [k, v === 'annually' ? 'yearly' : v];
          if (k === 'category') { const r = resolveFieldOption(v, meta.taskCategories); return r !== null ? [k, r] : null; }
          if (k === 'assignee') { const r = resolveFieldOption(v, meta.userNames); return r !== null ? [k, r] : null; }
          return [k, v];
        }).filter(Boolean);
        if (!updates.length) return { error: 'No valid fields to update.' };
        const verify = await db.prepare('SELECT id FROM tasks WHERE id = $1 AND organization_id = $2').get(task_id, orgId);
        if (!verify) return { error: `Task ${task_id} not found.` };
        const setClauses = updates.map(([k], i) => `${k} = $${i + 2}`).join(', ');
        await db.prepare(`UPDATE tasks SET ${setClauses}, updated_at = NOW() WHERE id = $1`)
          .run(task_id, ...updates.map(([, v]) => v));
        return { success: true, task_id, updated_fields: updates.map(([k]) => k) };
      }
      case 'update_risk': {
        const { risk_id, ...fields } = args;
        const allowed = ['title', 'description', 'category', 'source', 'asset', 'threat', 'vulnerability', 'likelihood', 'impact', 'risk_owner', 'status'];
        let updates = Object.entries(fields).filter(([k]) => allowed.includes(k));
        // Validate option-constrained fields; drop fields where no valid match exists in the system
        updates = updates.map(([k, v]) => {
          if (k === 'category') { const r = resolveFieldOption(v, meta.riskCategories); return r !== null ? [k, r] : null; }
          if (k === 'risk_owner') { const r = resolveFieldOption(v, meta.userNames); return r !== null ? [k, r] : null; }
          return [k, v];
        }).filter(Boolean);
        if (!updates.length) return { error: 'No valid fields to update.' };
        const verify = await db.prepare('SELECT id, likelihood, impact FROM risks WHERE id = $1 AND organization_id = $2').get(risk_id, orgId);
        if (!verify) return { error: `Risk ${risk_id} not found.` };
        // Recalculate score if likelihood/impact changed
        const newLikelihood = fields.likelihood ?? verify.likelihood;
        const newImpact = fields.impact ?? verify.impact;
        const scoreUpdate = (fields.likelihood || fields.impact) ? `, inherent_score = ${Math.round(newLikelihood * newImpact)}` : '';
        const setClauses = updates.map(([k], i) => `${k} = $${i + 2}`).join(', ');
        await db.prepare(`UPDATE risks SET ${setClauses}${scoreUpdate}, updated_at = NOW() WHERE id = $1`)
          .run(risk_id, ...updates.map(([, v]) => v));
        return { success: true, risk_id, updated_fields: updates.map(([k]) => k) };
      }
      case 'update_nonconformity': {
        const { nc_id, ...fields } = args;
        const allowed = ['clause', 'description', 'severity', 'root_cause', 'correction', 'corrective_action', 'responsible', 'due_date', 'status', 'verification_notes'];
        let updates = Object.entries(fields).filter(([k]) => allowed.includes(k));
        updates = updates.map(([k, v]) => {
          if (k === 'responsible') { const r = resolveFieldOption(v, meta.userNames); return r !== null ? [k, r] : null; }
          return [k, v];
        }).filter(Boolean);
        if (!updates.length) return { error: 'No valid fields to update.' };
        // Verify belongs to org via audit join
        const verify = await db.prepare(
          `SELECT n.id FROM non_conformities n JOIN audits a ON n.audit_id = a.id WHERE n.id = $1 AND a.organization_id = $2`
        ).get(nc_id, orgId);
        if (!verify) return { error: `Non-conformity ${nc_id} not found.` };
        // Auto-set closed_date when closing
        const closedDateClause = (fields.status === 'closed' || fields.status === 'verified') ? ', closed_date = CURRENT_DATE' : '';
        const setClauses = updates.map(([k], i) => `${k} = $${i + 2}`).join(', ');
        await db.prepare(`UPDATE non_conformities SET ${setClauses}${closedDateClause} WHERE id = $1`)
          .run(nc_id, ...updates.map(([, v]) => v));
        return { success: true, nc_id, updated_fields: updates.map(([k]) => k) };
      }
      case 'create_action': {
        const { title, description = '', priority = 'Medium', due_date = null } = args;
        const assignee = resolveFieldOption(args.assignee, meta.userNames) ?? '';
        const normPriority = priority.charAt(0).toUpperCase() + priority.slice(1).toLowerCase();
        const result = await db.prepare(
          `INSERT INTO actions (organization_id, title, description, assignee, priority, status, due_date)
           VALUES ($1, $2, $3, $4, $5, 'open', $6)`
        ).run(orgId, title, description, assignee, normPriority, due_date);
        return { success: true, id: result.lastInsertRowid, title, priority };
      }
      case 'update_action': {
        const {action_id,...fields}=args;
        if(fields.priority)fields.priority=fields.priority.charAt(0).toUpperCase()+fields.priority.slice(1).toLowerCase();
        for(const key of ['assignee','resolved_by'])if(fields[key]!==undefined)fields[key]=resolveFieldOption(fields[key],meta.userNames)??'';
        await updateFollowup(orgId,action_id,fields);
        return {success:true,action_id};
      }
      case 'create_audit': {
        const { title, standard = '', planned_date, scope = '' } = args;
        const lead_auditor = resolveFieldOption(args.lead_auditor, meta.userNames) ?? '';
        const result = await db.prepare(
          `INSERT INTO audits (organization_id, title, standard, status, planned_date, lead_auditor, scope)
           VALUES ($1, $2, $3, 'planned', $4, $5, $6)`
        ).run(orgId, title, standard, planned_date, lead_auditor, scope);
        return { success: true, id: result.lastInsertRowid, title, planned_date };
      }
      case 'update_audit': {
        const { audit_id, ...fields } = args;
        const allowed = ['title', 'standard', 'status', 'planned_date', 'completed_date', 'lead_auditor', 'scope'];
        let updates = Object.entries(fields).filter(([k]) => allowed.includes(k));
        updates = updates.map(([k, v]) => {
          if (k === 'lead_auditor') { const r = resolveFieldOption(v, meta.userNames); return r !== null ? [k, r] : null; }
          return [k, v];
        }).filter(Boolean);
        if (!updates.length) return { error: 'No valid fields to update.' };
        const verify = await db.prepare('SELECT id FROM audits WHERE id = $1 AND organization_id = $2').get(audit_id, orgId);
        if (!verify) return { error: `Audit ${audit_id} not found.` };
        const setClauses = updates.map(([k], i) => `${k} = $${i + 2}`).join(', ');
        await db.prepare(`UPDATE audits SET ${setClauses} WHERE id = $1`)
          .run(audit_id, ...updates.map(([, v]) => v));
        return { success: true, audit_id, updated_fields: updates.map(([k]) => k) };
      }
      case 'create_treatment': {
        const { risk_id, description, status = 'planned', due_date = null } = args;
        const owner = resolveFieldOption(args.owner, meta.userNames) ?? '';
        const verify = await db.prepare('SELECT id FROM risks WHERE id = $1 AND organization_id = $2').get(risk_id, orgId);
        if (!verify) return { error: `Risk ${risk_id} not found.` };
        const result = await db.prepare(
          `INSERT INTO risk_treatments (organization_id, risk_id, description, status, due_date, responsible)
           VALUES ($1, $2, $3, $4, $5, $6)`
        ).run(orgId, risk_id, description, status, due_date, owner);
        return { success: true, id: result.lastInsertRowid, risk_id, description };
      }
      case 'update_treatment': {
        const { treatment_id, ...fields } = args;
        const allowed = ['description', 'status', 'due_date', 'responsible'];
        let updates = Object.entries(fields).filter(([k]) => allowed.includes(k));
        updates = updates.map(([k, v]) => {
          if (k === 'responsible') { const r = resolveFieldOption(v, meta.userNames); return r !== null ? [k, r] : null; }
          return [k, v];
        }).filter(Boolean);
        if (!updates.length) return { error: 'No valid fields to update.' };
        // Verify ownership via risk join
        const verify = await db.prepare(
          `SELECT rt.id FROM risk_treatments rt JOIN risks r ON rt.risk_id = r.id WHERE rt.id = $1 AND r.organization_id = $2`
        ).get(treatment_id, orgId);
        if (!verify) return { error: `Treatment ${treatment_id} not found.` };
        const setClauses = updates.map(([k], i) => `${k} = $${i + 2}`).join(', ');
        await db.prepare(`UPDATE risk_treatments SET ${setClauses} WHERE id = $1`)
          .run(treatment_id, ...updates.map(([, v]) => v));
        return { success: true, treatment_id, updated_fields: updates.map(([k]) => k) };
      }
      case 'create_document': {
        const { title, doc_type = 'policy', version = '1.0', status = 'draft', review_date = null } = args;
        const owner = resolveFieldOption(args.owner, meta.userNames) ?? '';
        const result = await db.prepare(
          `INSERT INTO documents (organization_id, title, doc_type, version, owner, status, review_date)
           VALUES ($1, $2, $3, $4, $5, $6, $7)`
        ).run(orgId, title, doc_type, version, owner, status, review_date);
        return { success: true, id: result.lastInsertRowid, title, doc_type, status };
      }
      case 'rate_checklist_item': {
        const item=await updateChecklistItem(orgId,args.checklist_id,{rating:args.rating,notes:args.notes||''});
        return {success:true,checklist_id:item.id,rating:item.rating,audit_status:item._auditStatus};
      }
      case 'get_mission': {
        const mission = await db.prepare('SELECT content, vision, values_text FROM org_mission WHERE organization_id = $1').get(orgId);
        const org = await db.prepare('SELECT name FROM organizations WHERE id = $1').get(orgId);
        return { org_name: org?.name || '', ...mission };
      }
      case 'update_mission': {
        const { content, vision, values_text } = args;
        const existing = await db.prepare('SELECT content, vision, values_text FROM org_mission WHERE organization_id = $1').get(orgId);
        if (!existing) return { error: 'Mission record not found for this organization.' };
        await db.prepare(`
          UPDATE org_mission SET
            content = $1, vision = $2, values_text = $3, updated_at = NOW()
          WHERE organization_id = $4
        `).run(
          content     !== undefined ? content     : existing.content,
          vision      !== undefined ? vision      : existing.vision,
          values_text !== undefined ? values_text : existing.values_text,
          orgId
        );
        const updated = await db.prepare('SELECT content, vision, values_text FROM org_mission WHERE organization_id = $1').get(orgId);
        return { success: true, ...updated };
      }
      case 'get_architecture': {
        const params = [orgId];
        let sql = 'SELECT id, arch_type, name, description, owner, status, parent_id, sort_order FROM org_architecture WHERE organization_id = $1';
        if (args.arch_type) { sql += ' AND arch_type = $2'; params.push(args.arch_type); }
        sql += ' ORDER BY arch_type, sort_order, name';
        const items = await db.prepare(sql).all(...params);
        return { items, count: items.length };
      }
      case 'create_architecture_item': {
        const { arch_type, name, description = '', status = 'active', parent_id = null } = args;
        const owner = resolveFieldOption(args.owner, meta.userNames) ?? '';
        const result = await db.prepare(`
          INSERT INTO org_architecture (organization_id, arch_type, name, description, owner, status, parent_id)
          VALUES ($1, $2, $3, $4, $5, $6, $7)
        `).run(orgId, arch_type, name, description, owner, status, parent_id || null);
        return { success: true, id: result.lastInsertRowid, arch_type, name };
      }
      case 'update_architecture_item': {
        const { item_id, ...fields } = args;
        const verify = await db.prepare('SELECT id FROM org_architecture WHERE id = $1 AND organization_id = $2').get(item_id, orgId);
        if (!verify) return { error: `Architecture item ${item_id} not found.` };
        const allowed = ['name', 'description', 'owner', 'status', 'parent_id'];
        let updates = Object.entries(fields).filter(([k]) => allowed.includes(k));
        updates = updates.map(([k, v]) => {
          if (k === 'owner') { const r = resolveFieldOption(v, meta.userNames); return r !== null ? [k, r] : null; }
          return [k, v];
        }).filter(Boolean);
        if (!updates.length) return { error: 'No valid fields to update.' };
        // Allow parent_id = 0 to mean "remove parent" → set to NULL
        updates = updates.map(([k, v]) => [k, k === 'parent_id' && v === 0 ? null : v]);
        const setClauses = updates.map(([k], i) => `${k} = $${i + 2}`).join(', ');
        await db.prepare(`UPDATE org_architecture SET ${setClauses}, updated_at = NOW() WHERE id = $1`)
          .run(item_id, ...updates.map(([, v]) => v));
        return { success: true, item_id, updated_fields: updates.map(([k]) => k) };
      }
      case 'delete_architecture_item': {
        const { item_id } = args;
        const verify = await db.prepare('SELECT id, name, arch_type FROM org_architecture WHERE id = $1 AND organization_id = $2').get(item_id, orgId);
        if (!verify) return { error: `Architecture item ${item_id} not found.` };
        await db.prepare('DELETE FROM org_architecture WHERE id = $1 AND organization_id = $2').run(item_id, orgId);
        return { success: true, item_id, deleted: verify.name, arch_type: verify.arch_type };
      }
      case 'get_management_reviews': {
        const params = [orgId];
        let sql = 'SELECT id, title, review_date, status, chairperson, next_review_date, summary FROM management_reviews WHERE organization_id = $1';
        if (args.status) { sql += ' AND status = $2'; params.push(args.status); }
        sql += ' ORDER BY review_date DESC LIMIT 20';
        const reviews = await db.prepare(sql).all(...params);
        return { management_reviews: reviews, count: reviews.length };
      }
      case 'create_management_review': {
        const { title, review_date, attendees = '', next_review_date = null } = args;
        const chairperson = resolveFieldOption(args.chairperson, meta.userNames) ?? '';
        // Store attendees as JSON array if passed as comma-separated string
        const attendeesJson = Array.isArray(attendees)
          ? JSON.stringify(attendees)
          : JSON.stringify(attendees.split(',').map(a => a.trim()).filter(Boolean));
        const result = await db.prepare(`
          INSERT INTO management_reviews (organization_id, title, review_date, status, chairperson, attendees, next_review_date)
          VALUES ($1, $2, $3, 'scheduled', $4, $5, $6)
        `).run(orgId, title, review_date, chairperson, attendeesJson, next_review_date);
        return { success: true, id: result.lastInsertRowid, title, review_date, status: 'scheduled' };
      }
      default:
        return { error: `Unknown tool: ${toolName}` };
    }
  }

  app.post('/api/agent', requireOrgContext, async (req, res) => {

    const openai = getOpenAI();
    if (!openai) {
      console.error('[Agent] No OpenAI client — OPENAI_API_KEY missing or openai package failed to load');
      return res.status(503).json({ error: 'AI Agent is not configured. Ask your administrator to set the OPENAI_API_KEY environment variable.' });
    }

    const { message, history = [] } = req.body;
    if (typeof message !== 'string' || message.length > 8000 || !Array.isArray(history) || history.length > 20 || !message.trim()) return res.status(400).json({ error: 'Message is required' });

    // Load the current user's permissions from the database
    let userRecord;
    try {
      userRecord = await db.prepare('SELECT permissions FROM users WHERE id = $1').get(req.session.userId);
    } catch (dbErr) {
      console.error('[Agent] DB error loading user permissions:', { code: dbErr.code });
      return res.status(500).json({ error: 'Failed to load user permissions: ' + dbErr.message });
    }

    let userPerms = [];
    try {
      userPerms = JSON.parse(userRecord?.permissions || '[]');
    } catch (_) { userPerms = []; }
    // Superadmins and org admins get all permissions
    if (['superadmin','org_admin','admin'].includes(req.session.userRole)) {
      userPerms = Object.values(AGENT_TOOL_PERMISSIONS);
    }

    // Fetch available field options so the agent can only assign values that exist in the system
    let agentMeta = { riskCategories: [], taskCategories: [], userNames: [] };
    try {
      const [riskCats, taskCats, orgUsers] = await Promise.all([
        db.prepare("SELECT DISTINCT category FROM risks WHERE organization_id = $1 AND category IS NOT NULL AND category != '' ORDER BY category").all(req.orgId),
        db.prepare("SELECT DISTINCT category FROM tasks WHERE organization_id = $1 AND category IS NOT NULL AND category != '' ORDER BY category").all(req.orgId),
        db.prepare("SELECT name FROM users WHERE organization_id = $1 AND status = 'active' AND role != 'superadmin' ORDER BY name").all(req.orgId),
      ]);
      agentMeta = {
        riskCategories: riskCats.map(r => r.category),
        taskCategories: taskCats.map(r => r.category),
        userNames: orgUsers.map(r => r.name),
      };
    } catch (metaErr) {
      console.warn('[Agent] Could not load field metadata:', { code: metaErr.code });
    }

    // Build a context block listing available options so the agent behaves like a normal user
    const contextParts = [
      'FIELD OPTIONS — you MUST only use values from these lists when filling in category, owner, assignee, responsible, lead_auditor, or chairperson fields.',
      'If no suitable match exists in the list, leave the field blank (empty string). Do NOT invent or guess values.',
    ];
    if (agentMeta.riskCategories.length) {
      contextParts.push(`Available risk categories: ${agentMeta.riskCategories.join(', ')}`);
    } else {
      contextParts.push('Available risk categories: (none defined — leave category blank)');
    }
    if (agentMeta.taskCategories.length) {
      contextParts.push(`Available task categories: ${agentMeta.taskCategories.join(', ')}`);
    } else {
      contextParts.push('Available task categories: (none defined — leave category blank)');
    }
    if (agentMeta.userNames.length) {
      contextParts.push(`Available users (for owner/assignee/responsible/lead_auditor/chairperson fields): ${agentMeta.userNames.join(', ')}`);
    } else {
      contextParts.push('Available users: (none — leave all owner/assignee/responsible fields blank)');
    }
    const agentFieldContext = contextParts.join('\n');

    // Filter tools to only those the user has permission to use
    const allowedTools = AGENT_TOOLS.filter(t => {
      const required = AGENT_TOOL_PERMISSIONS[t.function.name];
      return (!required || userPerms.includes(required)) && (t.function.name !== 'get_dashboard_summary' || ['org','risk','ops','audit'].every(p => userPerms.includes(p)));
    });

    // System + last 20 history messages + new user turn
    const messages = [
      { role: 'system', content: AGENT_SYSTEM_PROMPT + '\n\n' + agentFieldContext },
      ...history.filter(m => m && ['user','assistant'].includes(m.role) && typeof m.content === 'string').map(m => ({ role: m.role, content: m.content.slice(0,8000) })),
      { role: 'user', content: message.trim() },
    ];

    const openaiPayload = {
      model: 'gpt-4o-mini',
      messages,
      tools: allowedTools,
      tool_choice: 'auto',
      max_tokens: 1024,
    };

    try {
      let response = await openai.chat.completions.create(openaiPayload);

      let assistantMsg = response.choices[0].message;

      // Agentic loop: resolve all tool calls before returning to the user
      const MAX_ROUNDS = 5;
      let rounds = 0;
      while (assistantMsg.tool_calls?.length && rounds < MAX_ROUNDS) {
        rounds++;
        messages.push(assistantMsg);

        const toolResults = await Promise.all(
          assistantMsg.tool_calls.map(async tc => {
            let result;
            try {
              // Defense-in-depth: verify permission even if tool slipped through
              const required = AGENT_TOOL_PERMISSIONS[tc.function.name];
              if ((required && !userPerms.includes(required)) || (tc.function.name === 'get_dashboard_summary' && !['org','risk','ops','audit'].every(p => userPerms.includes(p)))) {
                console.warn('[Agent] Permission denied for tool', tc.function.name, '— required:', required);
                result = { error: `Permission denied. You do not have access to the '${required}' module.` };
              } else {
                const toolArgs = JSON.parse(tc.function.arguments || '{}');
                result = await executeAgentTool(tc.function.name, toolArgs, req.orgId, agentMeta);
              }
            } catch (err) {
              console.error('[Agent] Tool execution error for', tc.function.name, ':', { code: err.code, status: err.status });
              result = { error: `Tool failed: ${err.message}` };
            }
            return { role: 'tool', tool_call_id: tc.id, content: JSON.stringify(result) };
          })
        );

        messages.push(...toolResults);

        response = await openai.chat.completions.create({
          model: 'gpt-4o-mini',
          messages,
          tools: allowedTools,
          tool_choice: 'auto',
          max_tokens: 1024,
        });
        assistantMsg = response.choices[0].message;
      }

      res.json({ reply: assistantMsg.content || '_(no response)_' });
    } catch (err) {
      console.error('[Agent] OpenAI request failed', { status: err.status });
      if (err.status === 429) return res.status(429).json({ error: 'Rate limit reached. Please wait a moment and try again.' });
      if (err.status === 401) return res.status(503).json({ error: 'Invalid OpenAI API key. Please check your server configuration.' });
      if (err.status === 400) return res.status(400).json({ error: 'Bad request to OpenAI: ' + (err.message || 'unknown error') });
      if (err.code === 'ECONNREFUSED' || err.code === 'ENOTFOUND') {
        return res.status(503).json({ error: 'Cannot reach OpenAI API. Check network connectivity: ' + err.message });
      }
      res.status(500).json({ error: 'AI request failed. Please retry later.' });
    }
  });

  return { executeAgentTool };
}

module.exports = { registerAgentRoutes };
