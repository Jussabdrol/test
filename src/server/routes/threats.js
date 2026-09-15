// Register on the shared app to retain middleware and transaction boundaries.
function registerThreatsRoutes(app, { db, requireOrgContext }) {
  // --- Threat Intelligence API ---

  // List feeds
  app.get('/api/threat-feeds', requireOrgContext, async (req, res) => {
    const feeds = await db.prepare('SELECT * FROM threat_feeds WHERE organization_id = ? ORDER BY tier, name').all(req.orgId);
    for (const f of feeds) {
      f.item_count = (await db.prepare('SELECT COUNT(*) as c FROM threat_items WHERE feed_id = ?').get(f.id)).c;
      f.new_count = (await db.prepare("SELECT COUNT(*) as c FROM threat_items WHERE feed_id = ? AND status = 'new'").get(f.id)).c;
    }
    res.json(feeds);
  });

  // Add feed
  app.post('/api/threat-feeds', requireOrgContext, async (req, res) => {
    const { name, url, tier } = req.body;
    if (!name || !url) return res.status(400).json({ error: 'name and url required' });
    const result = await db.prepare('INSERT INTO threat_feeds (organization_id, name, url, tier) VALUES (?, ?, ?, ?)').run(req.orgId, name, url, tier || 1);
    res.status(201).json(await db.prepare('SELECT * FROM threat_feeds WHERE id = ?').get(result.lastInsertRowid));
  });

  // Update feed
  app.put('/api/threat-feeds/:id', requireOrgContext, async (req, res) => {
    const existing = await db.prepare('SELECT * FROM threat_feeds WHERE id = ? AND organization_id = ?').get(req.params.id, req.orgId);
    if (!existing) return res.status(404).json({ error: 'Feed not found' });
    const fields = ['name', 'url', 'tier', 'enabled'];
    const updates = []; const params = [];
    for (const f of fields) {
      if (req.body[f] !== undefined) { updates.push(`${f} = ?`); params.push(req.body[f]); }
    }
    if (updates.length === 0) return res.status(400).json({ error: 'No fields to update' });
    params.push(req.params.id);
    await db.prepare(`UPDATE threat_feeds SET ${updates.join(', ')} WHERE id = ? AND organization_id = ?`).run(...params, req.orgId);
    res.json(await db.prepare('SELECT * FROM threat_feeds WHERE id = ? AND organization_id = ?').get(req.params.id, req.orgId));
  });

  // Delete feed
  app.delete('/api/threat-feeds/:id', requireOrgContext, async (req, res) => {
    await db.prepare('DELETE FROM threat_feeds WHERE id = ? AND organization_id = ?').run(req.params.id, req.orgId);
    res.json({ success: true });
  });

  // Fetch/refresh a single feed (server-side RSS proxy)
  app.post('/api/threat-feeds/:id/fetch', requireOrgContext, async (req, res) => {
    const feed = await db.prepare('SELECT * FROM threat_feeds WHERE id = ? AND organization_id = ?').get(req.params.id, req.orgId);
    if (!feed) return res.status(404).json({ error: 'Feed not found' });

    try {
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), 15000);
      const response = await fetch(feed.url, {
        signal: controller.signal,
        headers: { 'User-Agent': 'LetTheFrameWork/1.0 ThreatIntelFetcher' }
      });
      clearTimeout(timeout);

      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      const text = await response.text();

      // Simple XML parser for RSS/Atom - extract items
      const items = [];
      // Try RSS <item> format
      const rssItems = text.match(/<item[\s>][\s\S]*?<\/item>/gi) || [];
      for (const raw of rssItems) {
        const title = (raw.match(/<title[^>]*>([\s\S]*?)<\/title>/i) || [])[1] || '';
        const desc = (raw.match(/<description[^>]*>([\s\S]*?)<\/description>/i) || [])[1] || '';
        const link = (raw.match(/<link[^>]*>([\s\S]*?)<\/link>/i) || [])[1] || '';
        const guid = (raw.match(/<guid[^>]*>([\s\S]*?)<\/guid>/i) || [])[1] || link || title;
        const pubDate = (raw.match(/<pubDate[^>]*>([\s\S]*?)<\/pubDate>/i) || [])[1] || '';
        if (title || desc) items.push({ title: stripTags(title).trim(), description: stripTags(desc).trim().substring(0, 2000), link: stripTags(link).trim(), guid: stripTags(guid).trim(), pub_date: pubDate.trim() });
      }
      // Try Atom <entry> format if no RSS items found
      if (items.length === 0) {
        const atomEntries = text.match(/<entry[\s>][\s\S]*?<\/entry>/gi) || [];
        for (const raw of atomEntries) {
          const title = (raw.match(/<title[^>]*>([\s\S]*?)<\/title>/i) || [])[1] || '';
          const desc = (raw.match(/<(?:summary|content)[^>]*>([\s\S]*?)<\/(?:summary|content)>/i) || [])[1] || '';
          const linkMatch = raw.match(/<link[^>]*href=["']([^"']+)["'][^>]*\/?>/i);
          const link = linkMatch ? linkMatch[1] : '';
          const idTag = (raw.match(/<id[^>]*>([\s\S]*?)<\/id>/i) || [])[1] || link || title;
          const updated = (raw.match(/<(?:updated|published)[^>]*>([\s\S]*?)<\/(?:updated|published)>/i) || [])[1] || '';
          if (title || desc) items.push({ title: stripTags(title).trim(), description: stripTags(desc).trim().substring(0, 2000), link: stripTags(link).trim(), guid: stripTags(idTag).trim(), pub_date: updated.trim() });
        }
      }

      // Upsert items (improvement 9: proper transaction with txDB)
      await db.transaction(async (txDB) => {
        for (const i of items) {
          await txDB.run(`INSERT INTO threat_items (organization_id, feed_id, guid, title, description, link, pub_date) VALUES (?, ?, ?, ?, ?, ?, ?) ON CONFLICT(feed_id, guid) DO UPDATE SET title=excluded.title, description=excluded.description, link=excluded.link, pub_date=excluded.pub_date`,
            req.orgId, feed.id, i.guid || i.title, i.title, i.description, i.link, i.pub_date);
        }
      });

      // Improvement 6: update feed health on success
      await db.prepare(
        "UPDATE threat_feeds SET last_fetched = datetime('now'), last_success = datetime('now'), consecutive_failures = 0, last_error = NULL WHERE id = ? AND organization_id = ?"
      ).run(feed.id, req.orgId);

      res.json({ success: true, count: items.length });
    } catch (err) {
      // Improvement 6: track failure count and last error
      await db.prepare(
        "UPDATE threat_feeds SET last_fetched = datetime('now'), consecutive_failures = consecutive_failures + 1, last_error = ? WHERE id = ? AND organization_id = ?"
      ).run(err.message.substring(0, 500), feed.id, req.orgId).catch(() => {});
      res.json({ success: false, error: err.message, count: 0 });
    }
  });

  // Get threat items (with filters)
  app.get('/api/threat-items', requireOrgContext, async (req, res) => {
    const { feed_id, tier, status, limit: lim } = req.query;
    let sql = `SELECT ti.*, tf.name as feed_name, tf.tier FROM threat_items ti JOIN threat_feeds tf ON ti.feed_id = tf.id WHERE ti.organization_id = ? AND tf.enabled = 1`;
    const params = [req.orgId];
    if (feed_id) { sql += ' AND ti.feed_id = ?'; params.push(feed_id); }
    if (tier) { sql += ' AND tf.tier = ?'; params.push(tier); }
    if (status) { sql += ' AND ti.status = ?'; params.push(status); }
    sql += ' ORDER BY ti.fetched_at DESC, ti.pub_date DESC';
    if (lim) { sql += ' LIMIT ?'; params.push(parseInt(lim)); }
    else { sql += ' LIMIT 200'; }
    res.json(await db.prepare(sql).all(...params));
  });

  // Update threat item status
  app.put('/api/threat-items/:id', requireOrgContext, async (req, res) => {
    const existing = await db.prepare('SELECT * FROM threat_items WHERE id = ? AND organization_id = ?').get(req.params.id, req.orgId);
    if (!existing) return res.status(404).json({ error: 'Threat item not found' });
    const { status, created_risk_id } = req.body;
    const updates = []; const params = [];
    if (status) { updates.push('status = ?'); params.push(status); }
    if (created_risk_id !== undefined) { updates.push('created_risk_id = ?'); params.push(created_risk_id); }
    if (updates.length === 0) return res.status(400).json({ error: 'Nothing to update' });
    params.push(req.params.id);
    await db.prepare(`UPDATE threat_items SET ${updates.join(', ')} WHERE id = ? AND organization_id = ?`).run(...params, req.orgId);
    res.json(await db.prepare('SELECT * FROM threat_items WHERE id = ? AND organization_id = ?').get(req.params.id, req.orgId));
  });

  function stripTags(str) {
    if (!str) return '';
    return str.replace(/<!\[CDATA\[([\s\S]*?)\]\]>/gi, '$1').replace(/<[^>]+>/g, '').replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&#39;/g, "'");
  }
}

module.exports = { registerThreatsRoutes };
