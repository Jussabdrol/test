const db = require('../database');

async function logAuditAction(userId, userName, action, entityType, entityId, entityName, details = '', orgId = null) {
  await db.run(`
    INSERT INTO admin_audit_log (organization_id, user_id, user_name, action, entity_type, entity_id, entity_name, details)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?)
  `, orgId, userId, userName, action, entityType, entityId, entityName, details);
}

module.exports = { logAuditAction };
