import { createOnlineDeadline, DEFAULT_ONLINE_BUDGET_MS } from '../src/online/deadline.js';

// The deadline is a wall clock, not a step counter, so every test here
// drives an injected clock rather than sleeping. A test that slept would
// be both slow and flaky, and would prove nothing the injected clock does
// not prove exactly.
describe('createOnlineDeadline', () => {
  test('is not expired before the budget is spent', () => {
    let now = 1_000;
    const deadline = createOnlineDeadline(500, () => now);
    expect(deadline.expired()).toBe(false);
    now = 1_499;
    expect(deadline.expired()).toBe(false);
  });

  test('is expired once the budget is exactly spent, and stays expired', () => {
    let now = 1_000;
    const deadline = createOnlineDeadline(500, () => now);
    now = 1_500;
    expect(deadline.expired()).toBe(true);
    now = 9_000;
    expect(deadline.expired()).toBe(true);
  });

  test('reports the remaining budget, floored at zero', () => {
    let now = 1_000;
    const deadline = createOnlineDeadline(500, () => now);
    expect(deadline.remainingMs()).toBe(500);
    now = 1_400;
    expect(deadline.remainingMs()).toBe(100);
    now = 5_000;
    expect(deadline.remainingMs()).toBe(0);
  });

  test('a budget of zero or less is expired from the first question', () => {
    // A caller that asks for no budget at all must get no online calls,
    // not one free call before the first check. The online subsystem's
    // whole promise is that it never adds latency it did not account for.
    const deadline = createOnlineDeadline(0, () => 1_000);
    expect(deadline.expired()).toBe(true);
    expect(createOnlineDeadline(-1, () => 1_000).expired()).toBe(true);
  });

  test('the default budget is a positive number of milliseconds', () => {
    expect(DEFAULT_ONLINE_BUDGET_MS).toBeGreaterThan(0);
  });
});
