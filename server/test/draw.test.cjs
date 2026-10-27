const test = require('node:test')
const assert = require('node:assert/strict')
const { drawPartners } = require('../dist/draw.js')

test('draw assigns each participant exactly one different participant', () => {
  for (let count = 3; count <= 20; count += 1) {
    const participants = Array.from({ length: count }, (_, index) => index)
    const assignments = drawPartners(participants)

    assert.equal(assignments.size, count)
    assert.deepEqual(new Set(assignments.values()), new Set(participants))
    for (const participant of participants) {
      assert.notEqual(assignments.get(participant), participant)
    }
  }
})

test('draw rejects participant counts outside the supported range', () => {
  assert.throws(() => drawPartners([1, 2]))
  assert.throws(() => drawPartners(Array.from({ length: 21 }, (_, index) => index)))
})
