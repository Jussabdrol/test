const { test } = require('node:test');
const assert = require('node:assert/strict');
const { cleanHtml } = require('../../src/server/services/document-conversion');
const { validateFileContent } = require('../../src/server/services/file-validation');
test('document conversion strips network URLs and active content', () => {
  const result = cleanHtml('<h1>Report</h1><img src="http://127.0.0.1/private"><svg onload="alert(1)"></svg><p style="background:url(https://remote.invalid)">Safe</p><script>danger()</script>');
  assert.match(result, /Report/); assert.match(result,/Safe/);
  assert.doesNotMatch(result,/127\.0\.0\.1|remote|script|onload|svg|style|img/);
});
test('upload contents must match the selected format', () => {
  assert.throws(() => validateFileContent({originalname:'image.png',mimetype:'image/png',buffer:Buffer.from('<script>bad</script>')}), /contents/);
  assert.doesNotThrow(() => validateFileContent({originalname:'report.pdf',mimetype:'application/pdf',buffer:Buffer.from('%PDF-1.7\n')}));
  assert.throws(() => validateFileContent({originalname:'data.json',mimetype:'application/json',buffer:Buffer.from('not JSON')}), /contents/);
});
