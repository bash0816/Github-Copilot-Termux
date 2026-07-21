'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { isIssueNeeded, generateIssueBody } = require('./napi-issue-body.js');

test('isIssueNeeded and generateIssueBody', async (t) => {
  await t.test('fixture_normal - basic sections with diverse items', () => {
    const audit = {
      newTokio: ['function_one', 'function_two'],
      newPendingGitAsync: ['async_func_alpha', 'async_func_beta', 'async_func_gamma'],
      newStreamRisk: ['stream_one', 'stream_two'],
      newUnknown: ['unknown_a', 'unknown_b', 'unknown_c'],
      tokioPatchOk: true,
    };

    const body = generateIssueBody(audit, '1.0.72');

    // Check length is within limit
    assert.ok(body.length <= 50000, `Body length ${body.length} should be <= 50000`);

    // Check balanced details/summary tags
    const detailsCount = (body.match(/<details>/g) || []).length;
    const closingDetailsCount = (body.match(/<\/details>/g) || []).length;
    assert.strictEqual(detailsCount, closingDetailsCount, 'Unbalanced <details> tags');

    // Check newTokio and newUnknown have collapsible details
    assert.ok(body.includes('<details><summary>'), 'Should have collapsible sections');
    assert.ok(body.includes('newTokio (2件、クリックして展開)'), 'newTokio title with count in summary');
    assert.ok(body.includes('newUnknown (3件、クリックして展開)'), 'newUnknown title with count in summary');

    // Check newPendingGitAsync and newStreamRisk are NOT collapsible
    assert.ok(body.includes('## newPendingGitAsync（手動レビュー後にスタブ追加が必要）'), 'newPendingGitAsync plain heading');
    assert.ok(body.includes('## newStreamRisk（ストリーム経路、必ず手動確認）'), 'newStreamRisk plain heading');

    // Check items are included
    assert.ok(body.includes('function_one'), 'Should contain tokio items');
    assert.ok(body.includes('async_func_alpha'), 'Should contain pending items');
    assert.ok(body.includes('stream_one'), 'Should contain stream items');
    assert.ok(body.includes('unknown_a'), 'Should contain unknown items');

    // Check summary stats
    assert.ok(body.includes('newTokio: 2'), 'Should show newTokio count');
    assert.ok(body.includes('newPendingGitAsync: 3'), 'Should show newPendingGitAsync count');
    assert.ok(body.includes('newStreamRisk: 2'), 'Should show newStreamRisk count');
    assert.ok(body.includes('newUnknown: 3'), 'Should show newUnknown count');
  });

  await t.test('fixture_tokio_patch_failed - isIssueNeeded with tokioPatchOk false', () => {
    const audit = {
      newTokio: ['function_one', 'function_two'],
      newPendingGitAsync: [],
      newStreamRisk: [],
      newUnknown: [],
      tokioPatchOk: false,
    };

    assert.strictEqual(isIssueNeeded(audit), true, 'Should need issue when tokioPatchOk is false');

    const body = generateIssueBody(audit, '1.0.72');
    assert.ok(body.length > 0, 'Should generate body');
    assert.ok(body.includes('newTokio (2件、クリックして展開)'), 'Should include tokio section');
  });

  await t.test('fixture_no_issue_needed - newUnknown alone does not trigger issue', () => {
    const audit = {
      newTokio: [],
      newPendingGitAsync: [],
      newStreamRisk: [],
      newUnknown: Array(100).fill('unknown_item'),
      tokioPatchOk: true,
    };

    assert.strictEqual(isIssueNeeded(audit), false, 'Should NOT need issue when only newUnknown has items');

    const body = generateIssueBody(audit, '1.0.72');
    assert.ok(body.length > 0, 'Should still generate body');
    assert.ok(body.includes('newUnknown: 100'), 'Should show count even if issue not needed');
  });

  await t.test('fixture_truncation - large audit data triggers truncation', () => {
    // Generate large dummy items to exceed SAFE_LIMIT (50000 chars)
    const dummyItem = 'function_abcdefghijklmnopqrstuvwxyz_';  // ~32 chars per item
    const largeArray = Array(2000).fill(null).map((_, i) => `${dummyItem}${i}`);

    const audit = {
      newTokio: largeArray.slice(0, 2000),
      newPendingGitAsync: largeArray.slice(0, 500),
      newStreamRisk: [],
      newUnknown: [],
      tokioPatchOk: true,
    };

    const body = generateIssueBody(audit, '1.0.72');

    // Check that body is within limit
    assert.ok(body.length <= 50000, `Body length ${body.length} should be <= 50000`);

    // Check balanced details tags
    const detailsCount = (body.match(/<details>/g) || []).length;
    const closingDetailsCount = (body.match(/<\/details>/g) || []).length;
    assert.strictEqual(detailsCount, closingDetailsCount, 'Unbalanced <details> tags after truncation');

    // Check truncation message is present
    assert.ok(body.includes('本文上限により表示を省略しました'), 'Should include truncation notice');

    // Check that not all items are included (truncation happened)
    const itemCount = (body.match(/^- /gm) || []).length;
    assert.ok(itemCount < 2500, `Should have fewer than all items due to truncation (got ${itemCount})`);
  });

  await t.test('fixture_truncation - verifies closeTag integrity in truncated output', () => {
    // Generate large arrays to force truncation
    const dummyItem = 'verylongfunctionname_withsuffix_';  // ~34 chars
    const largeArray = Array(2000).fill(null).map((_, i) => `${dummyItem}${i}`);

    const audit = {
      newTokio: largeArray.slice(0, 2000),
      newPendingGitAsync: largeArray.slice(0, 800),
      newStreamRisk: largeArray.slice(0, 500),
      newUnknown: largeArray.slice(0, 1000),
      tokioPatchOk: true,
    };

    const body = generateIssueBody(audit, '1.0.72');

    // Verify length constraint
    assert.ok(body.length <= 50000, 'Output must not exceed SAFE_LIMIT');

    // Count details/closing tag pairs
    const detailsOpen = (body.match(/<details>/g) || []).length;
    const detailsClose = (body.match(/<\/details>/g) || []).length;
    assert.strictEqual(detailsOpen, detailsClose, 'All opened <details> must be closed');

    // Ensure no orphaned closing tags
    const lines = body.split('\n');
    let detailsBalance = 0;
    for (const line of lines) {
      if (line.includes('<details>')) detailsBalance++;
      if (line.includes('</details>')) detailsBalance--;
      assert.ok(detailsBalance >= 0, 'Closing tag without matching opening tag found');
    }
    assert.strictEqual(detailsBalance, 0, 'Unmatched details tags at end of document');

    // Ensure truncation message exists
    assert.ok(body.includes('本文上限により表示を省略しました'), 'Truncation notice must be present');
  });
});
