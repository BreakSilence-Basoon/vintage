import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mayAccessTimetable } from '../src/index.mjs';

const viewer = { businessId: 'shop-a', staffId: 'staff-a', active: true, role: 'VIEWER' };
const admin = { ...viewer, staffId: 'staff-b', role: 'ADMIN' };
const resource = { businessId: 'shop-a', staffId: 'staff-a' };
const decide = (actor, action, target = resource) => mayAccessTimetable({ actor, action, resource: target });

test('viewer may read the schedule and own history but not manage records', () => {
  assert.equal(decide(viewer, 'schedule:read'), true);
  assert.equal(decide(viewer, 'history:read'), true);
  assert.equal(decide(viewer, 'history:read', { ...resource, staffId: 'staff-b' }), false);
  assert.equal(decide(viewer, 'schedule:write'), false);
  assert.equal(decide(viewer, 'attendance:adjust'), false);
});

test('admin may read history and manage schedules and attendance in the same business', () => {
  for (const action of ['schedule:read', 'history:read', 'schedule:write', 'attendance:adjust']) {
    assert.equal(decide(admin, action), true, action);
  }
});

test('different businesses, inactive staff and unknown actions are denied', () => {
  for (const actor of [viewer, admin]) {
    for (const action of ['schedule:read', 'history:read', 'schedule:write', 'attendance:adjust']) {
      assert.equal(decide(actor, action, { ...resource, businessId: 'shop-b' }), false);
      assert.equal(decide({ ...actor, active: false }, action), false);
    }
    assert.equal(decide(actor, 'unknown:write'), false);
  }
});

test('missing or malformed identity, role, and resource information deny access', () => {
  assert.equal(mayAccessTimetable(), false);
  assert.equal(mayAccessTimetable(null), false);
  assert.equal(mayAccessTimetable('invalid'), false);
  for (const actor of [null, {}, { ...admin, role: 'OWNER' }, { ...admin, active: 1 }, { ...admin, businessId: '' }, { ...admin, staffId: ' staff-a ' }]) {
    assert.equal(decide(actor, 'schedule:read'), false);
  }
  for (const target of [null, {}, { businessId: '' }, { businessId: 'shop-a', staffId: '' }]) {
    assert.equal(decide(admin, 'history:read', target), false);
  }
});
