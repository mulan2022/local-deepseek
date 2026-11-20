import assert from 'node:assert/strict'
import { revealMessage, getVisibleMessages } from '../../src/services/chat/branches.ts'

const session = {
  rootMessageId: 'u1',
  messages: [
    { id: 'u1', parentId: null, selectedChildId: 'a1-new', content: 'original question' },
    { id: 'a1-old', parentId: 'u1', selectedChildId: 'u2-old', content: 'old parent answer' },
    { id: 'u2-old', parentId: 'a1-old', selectedChildId: 'a2-new', content: 'old follow-up' },
    { id: 'a2-old', parentId: 'u2-old', selectedChildId: 'u3', content: 'favorite' },
    { id: 'u3', parentId: 'a2-old', content: 'retained future' },
    { id: 'a2-new', parentId: 'u2-old', content: 'regenerated follow-up' },
    { id: 'a1-new', parentId: 'u1', selectedChildId: 'u2-new', content: 'regenerated parent answer' },
    { id: 'u2-new', parentId: 'a1-new', content: 'new branch' },
  ],
}
const original = structuredClone(session)
const revealed = revealMessage(session, 'a2-old')
assert.deepEqual(getVisibleMessages(revealed).map(m => m.id), ['u1', 'a1-old', 'u2-old', 'a2-old', 'u3'])
assert.deepEqual(session, original, 'Navigation does not mutate the original or snapshot')
assert.equal(revealed.messages.length, session.messages.length, 'Keep every alternate version')
assert.deepEqual(revealed.messages.map(m => m.content), session.messages.map(m => m.content), 'No context content rewriting')
assert.equal(revealMessage(session, 'missing'), null)
assert.equal(revealMessage({ rootMessageId: 'a', messages: [{ id: 'a', parentId: 'b' }, { id: 'b', parentId: 'a' }] }, 'a'), null)
assert.equal(revealMessage({ rootMessageId: 'a', messages: [{ id: 'a', parentId: 'missing' }] }, 'a'), null)
assert.deepEqual(getVisibleMessages(revealMessage({ messages: [{ id: '1' }, { id: '2' }] }, '2')).map(m => m.id), ['1', '2'])
console.log('PASS favorite jump restores edited ancestors and exact reply, preserves future/alternate branches, handles legacy and missing/corrupt paths')
