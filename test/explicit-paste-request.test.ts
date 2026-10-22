import assert from 'node:assert/strict'
import test from 'node:test'
import { ExplicitPasteRequestTracker } from '../src/explicit-paste-request'

test('keeps an explicit paste request available until it is consumed', () => {
  const tracker = new ExplicitPasteRequestTracker(50)
  tracker.request()
  tracker.arm()

  assert.equal(tracker.consume(), true)
  assert.equal(tracker.consume(), false)
})

test('does not arm a timer after a provider consumes during the command', async () => {
  const tracker = new ExplicitPasteRequestTracker(0)
  tracker.request()
  assert.equal(tracker.consume(), true)
  tracker.arm()
  await new Promise((resolve) => setTimeout(resolve, 10))
  assert.equal(tracker.consume(), false)
})

test('expires an explicit paste request that is never dispatched', async () => {
  const tracker = new ExplicitPasteRequestTracker(1)
  tracker.request()
  tracker.arm()
  await new Promise((resolve) => setTimeout(resolve, 10))

  assert.equal(tracker.consume(), false)
})
