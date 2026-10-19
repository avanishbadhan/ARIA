import test from 'node:test';
import assert from 'node:assert/strict';
import { AutonomousToolReasoner } from '../src/autonomous-tool-reasoner.js';

const reasoner = new AutonomousToolReasoner();

const checkInboxCases = ['check my email', 'check my inbox', 'check my gmail', 'check email', 'any new email', 'any new emails'];
for (const query of checkInboxCases) {
  test(`classifies "${query}" as GMAIL_CHECK_INBOX`, () => {
    const decision = reasoner.evaluateIntent(query);
    assert.equal(decision.toolName, 'GMAIL_CHECK_INBOX');
  });
}

test('classifies "search my email for the invoice" as GMAIL_SEARCH with the parsed query', () => {
  const decision = reasoner.evaluateIntent('search my email for the invoice');
  assert.equal(decision.toolName, 'GMAIL_SEARCH');
  assert.equal(decision.params.query, 'the invoice');
});

test('classifies "find my inbox for receipts" as GMAIL_SEARCH', () => {
  const decision = reasoner.evaluateIntent('find my inbox for receipts');
  assert.equal(decision.toolName, 'GMAIL_SEARCH');
  assert.equal(decision.params.query, 'receipts');
});

test('classifies "read me the email from sarah" as GMAIL_READ_MESSAGE with the parsed sender', () => {
  const decision = reasoner.evaluateIntent('read me the email from sarah');
  assert.equal(decision.toolName, 'GMAIL_READ_MESSAGE');
  assert.equal(decision.params.query, 'sarah');
});

test('classifies "read the message from github" as GMAIL_READ_MESSAGE', () => {
  const decision = reasoner.evaluateIntent('read the message from github');
  assert.equal(decision.toolName, 'GMAIL_READ_MESSAGE');
  assert.equal(decision.params.query, 'github');
});

const nonGmailQueries = [
  'what is the capital of France',
  'play Cyberpunk 2077',
  'switch mode to high',
  'open gmail',
  'open spotify',
  "what's on my screen",
  'open camera'
];
for (const query of nonGmailQueries) {
  test(`does not classify "${query}" as a Gmail command`, () => {
    const decision = reasoner.evaluateIntent(query);
    assert.notEqual(decision.toolName, 'GMAIL_CHECK_INBOX');
    assert.notEqual(decision.toolName, 'GMAIL_SEARCH');
    assert.notEqual(decision.toolName, 'GMAIL_READ_MESSAGE');
  });
}
