import { readFileSync } from 'node:fs';
import { expect, it } from 'vitest';
import type { GroupMessage } from '../src/types.js';

interface Scenario {
  id: string;
  split: string;
  tags: string[];
  messages: GroupMessage[];
  expected: Array<{ messageId: string; actions: string[]; threadFrom?: string }>;
}
it('has independently scoped multi-message replay cases and earlier-only Thread references', () => {
  const data = JSON.parse(readFileSync(new URL('../fixtures/group-replay.json', import.meta.url), 'utf8')) as { scenarios: Scenario[] };
  expect(data.scenarios.length).toBeGreaterThanOrEqual(12);
  expect(data.scenarios.some(s => s.split === 'holdout')).toBe(true);
  expect(data.scenarios.some(s => s.split === 'development')).toBe(true);
  const seen = new Set<string>();
  for (const scenario of data.scenarios) {
    expect(scenario.messages.length).toBeGreaterThanOrEqual(3);
    expect(scenario.expected).toHaveLength(scenario.messages.length);
    const previous = new Set<string>();
    for (const [i, message] of scenario.messages.entries()) {
      expect(seen.has(message.id)).toBe(false); seen.add(message.id);
      const expected = scenario.expected[i];
      expect(expected.messageId).toBe(message.id);
      expect(expected.actions.length).toBeGreaterThan(0);
      if (expected.threadFrom) expect(previous.has(expected.threadFrom)).toBe(true);
      if (message.replyToMessageId) expect(scenario.messages.slice(0, i).some(m => m.messageId === message.replyToMessageId)).toBe(true);
      previous.add(message.id);
    }
  }
  expect(seen.size).toBe(data.scenarios.reduce((total, scenario) => total + scenario.messages.length, 0));
  const tags = new Set(data.scenarios.flatMap(s => s.tags));
  for (const tag of ['专业', '简单推理', '多人', '更正', '图片', '澄清', '取消']) expect(tags.has(tag)).toBe(true);
});
