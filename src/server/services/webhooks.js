const db = require('../database');
const crypto = require('node:crypto');

// ---------------------------------------------------------------------------
// SSRF protection for webhook delivery
// - Rejects non-http(s) schemes
// - Rejects localhost / metadata hostnames by name
// - Resolves DNS and rejects any private / loopback / link-local / multicast IP
// - Connects to the resolved IP directly (with Host header) to mitigate
//   DNS rebinding between the lookup and the request
// ---------------------------------------------------------------------------
const dns = require('dns').promises;
const net = require('net');

function isBlockedIp(ip) {
  if (net.isIPv4(ip)) {
    const [a, b] = ip.split('.').map(Number);
    if (a === 0) return true;                            // 0.0.0.0/8
    if (a === 10) return true;                           // 10.0.0.0/8 (RFC1918)
    if (a === 127) return true;                          // loopback
    if (a === 169 && b === 254) return true;             // link-local incl. AWS metadata 169.254.169.254
    if (a === 172 && b >= 16 && b <= 31) return true;    // 172.16.0.0/12 (RFC1918)
    if (a === 192 && b === 168) return true;             // 192.168.0.0/16 (RFC1918)
    if (a === 100 && b >= 64 && b <= 127) return true;   // 100.64.0.0/10 (CGNAT)
    if (a >= 224) return true;                           // multicast + reserved
    return false;
  }
  if (net.isIPv6(ip)) {
    const lower = ip.toLowerCase();
    if (lower === '::1' || lower === '::') return true;
    if (lower.startsWith('fc') || lower.startsWith('fd')) return true; // ULA fc00::/7
    if (lower.startsWith('fe80')) return true;                          // link-local
    if (lower.startsWith('ff')) return true;                            // multicast
    const mapped = lower.match(/^::ffff:(\d+\.\d+\.\d+\.\d+)$/);
    if (mapped) return isBlockedIp(mapped[1]);
    return false;
  }
  return true; // unknown family: block
}

const BLOCKED_WEBHOOK_HOSTS = new Set([
  'localhost',
  'metadata.google.internal',
  'metadata.goog',
]);

async function validateWebhookUrl(rawUrl) {
  let url;
  try { url = new URL(rawUrl); }
  catch { throw new Error('Invalid webhook URL'); }
  if (!['http:', 'https:'].includes(url.protocol)) {
    throw new Error('Webhook URL must use http or https');
  }
  const host = url.hostname.toLowerCase();
  if (BLOCKED_WEBHOOK_HOSTS.has(host) || host.endsWith('.localhost')) {
    throw new Error('Webhook host is not allowed');
  }
  // If the hostname is already an IP literal, validate it directly
  if (net.isIP(host)) {
    if (isBlockedIp(host)) throw new Error('Webhook URL resolves to a blocked address');
    return { url, addrs: [{ address: host, family: net.isIPv6(host) ? 6 : 4 }] };
  }
  let addrs;
  try { addrs = await dns.lookup(host, { all: true }); }
  catch { throw new Error('Webhook host could not be resolved'); }
  if (!addrs.length) throw new Error('Webhook host could not be resolved');
  for (const a of addrs) {
    if (isBlockedIp(a.address)) throw new Error('Webhook URL resolves to a blocked address');
  }
  return { url, addrs };
}

// Dispatch a webhook request to an already-validated URL, connecting to the
// resolved IP directly (mitigates DNS rebinding). Returns { statusCode, body }.
function sendValidatedWebhook({ url, addrs }, payloadStr, headers, timeoutMs = 10000) {
  const https = require('https');
  const http = require('http');
  const client = url.protocol === 'https:' ? https : http;
  const ip = addrs[0].address;
  const options = {
    host: ip,
    port: url.port || (url.protocol === 'https:' ? 443 : 80),
    path: url.pathname + url.search,
    method: 'POST',
    headers: { ...headers, Host: url.host },
    timeout: timeoutMs,
  };
  if (url.protocol === 'https:') {
    options.servername = url.hostname; // TLS SNI + cert validation against the real hostname
  }
  return new Promise((resolve, reject) => {
    const req = client.request(options, (res) => {
      let body = '';
      res.on('data', c => body += c);
      res.on('end', () => resolve({ statusCode: res.statusCode, body: body.substring(0, 500) }));
    });
    req.on('error', reject);
    req.on('timeout', () => { req.destroy(); reject(new Error('Timeout')); });
    req.write(payloadStr);
    req.end();
  });
}

// Webhook delivery – fire-and-forget, never throws into caller
function fireWebhooks(orgId, event, data) {
  if (db.deferUntilCommit(() => fireWebhooks(orgId, event, data))) return;
  (async () => {
    try {
      const webhooks = await db.prepare(
        "SELECT * FROM webhooks WHERE organization_id = ? AND status = 'active'"
      ).all(orgId);

      const matching = webhooks.filter(w => {
        try { return JSON.parse(w.events || '[]').includes(event); } catch { return false; }
      });
      if (!matching.length) return;

      const https = require('https');
      const http  = require('http');
      const payloadStr = JSON.stringify({ event, timestamp: new Date().toISOString(), organization_id: orgId, data });

      for (const webhook of matching) {
        (async () => {
          try {
            const validated = await validateWebhookUrl(webhook.url);
            const headers = {
              'Content-Type': 'application/json',
              'Content-Length': Buffer.byteLength(payloadStr),
              'User-Agent': 'LetTheFrameWork/1.0',
            };
            if (webhook.secret) {
              headers['X-Webhook-Signature'] = 'sha256=' + crypto.createHmac('sha256', webhook.secret).update(payloadStr).digest('hex');
            }
            await sendValidatedWebhook(validated, payloadStr, headers);
            await db.prepare("UPDATE webhooks SET last_triggered = NOW() WHERE id = ?").run(webhook.id);
          } catch (err) {
            await db.prepare('UPDATE webhooks SET failure_count = failure_count + 1 WHERE id = ?').run(webhook.id);
            console.warn(`[webhook] delivery failed for "${webhook.name}" (${event}):`, err.message);
          }
        })().catch(() => {});
      }
    } catch (err) {
      console.warn('[webhook] fireWebhooks error:', err.message);
    }
  })();
}

module.exports = { validateWebhookUrl, sendValidatedWebhook, fireWebhooks };
