import { evaluateGate } from '../src/gate.js';
import { DepGuardError } from '../src/types.js';

const f = (severity: any) => ({ ruleId: 'typosquat', severity, packageName: 'x',
  message: '', manifestPath: 'package.json', fingerprint: 'aa' } as any);

test('medium threshold blocks medium and above', () => {
  const r = evaluateGate([f('low'), f('medium'), f('critical')], 'medium');
  expect(r.blockingMatches).toBe(2);
  expect(r.exitCode).toBe(1);
});

test('none never blocks', () => {
  expect(evaluateGate([f('critical')], 'none').exitCode).toBe(0);
});

test('empty findings pass', () => {
  expect(evaluateGate([], 'low').exitCode).toBe(0);
});

test('critical threshold blocks only critical', () => {
  const r = evaluateGate([f('low'), f('medium'), f('high'), f('critical')], 'critical');
  expect(r.blockingMatches).toBe(1);
  expect(r.exitCode).toBe(1);
});

test('low threshold blocks everything', () => {
  const r = evaluateGate([f('low'), f('medium'), f('high'), f('critical')], 'low');
  expect(r.blockingMatches).toBe(4);
  expect(r.exitCode).toBe(1);
});

test('threshold above all findings does not block', () => {
  const r = evaluateGate([f('low'), f('medium')], 'critical');
  expect(r.blockingMatches).toBe(0);
  expect(r.exitCode).toBe(0);
});

// T2-3: a severity outside the known order used to score below every
// threshold, so a finding carrying one passed the gate silently. No rule
// can produce that today, which is exactly why it has to fail loudly if one
// ever starts to.
test('a severity outside the known order fails closed rather than passing', () => {
  expect(() => evaluateGate([f('catastrophic')], 'medium')).toThrow(DepGuardError);
});

test('an unknown fail_on threshold fails closed too', () => {
  expect(() => evaluateGate([f('low')], 'catastrophic' as never)).toThrow(DepGuardError);
});
