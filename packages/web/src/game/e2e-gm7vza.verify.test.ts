/**
 * brass-GM7VZA 真实回放驱动的一站式验证（验证后删除）。
 * bug1 高亮 / bug2 双修酒源 / bug3 一键出售最长集。
 */
import { describe, expect, it } from 'vitest';
import { enumerateActions, newGame } from '@brass/engine';
import { applyAction } from '@brass/engine';
import type { Action, GameState } from '@brass/engine';
import { filterStateFor } from '@brass/protocol';
import { readFileSync } from 'node:fs';
import { buildSlotTargets, networkBeerSources, sellOptions, targetsFor } from './interactions';

interface ReplayAction {
  seq: number;
  player: number;
  action: Action;
}
const rec = JSON.parse(
  readFileSync(`${__dirname}/../../../server/replays/brass-GM7VZA-anon.json`, 'utf8'),
) as { seed: number; actions: ReplayAction[] };

function replayTo(seq: number): GameState {
  let state = newGame(4, rec.seed);
  for (const a of rec.actions) {
    if (a.seq === seq) break;
    state = applyAction(state, a.action);
  }
  return state;
}

describe('brass-GM7VZA 真实局面回归', () => {
  it('bug1: 运河时代 wild-location 候选含 (uttoxeter, brewery) 但空槽不高亮', () => {
    const st = replayTo(41);
    const legal = enumerateActions(st, 1);
    const targets = targetsFor('wild-location-0', legal);
    expect(targets.industries.get('uttoxeter' as never)).toContain('brewery');
    const refs = buildSlotTargets(filterStateFor(st, 1), 1, targets);
    expect(refs.filter((r) => r.location === 'uttoxeter')).toEqual([]);
    expect(refs.length).toBeGreaterThan(0); // 其它城市空槽照常高亮
  });

  it('bug2: 双修 [36,24] 酒源含 uttoxeter 对手酒厂(2 桶)', () => {
    const st = replayTo(67);
    const opts = networkBeerSources(filterStateFor(st, 0), 0, [36, 24]);
    expect(opts).toContainEqual({ location: 'uttoxeter', slotIndex: 0, own: false, barrels: 2 });
    expect(opts.some((o) => o.location === 'derby')).toBe(true); // 原误选源仍在
  });

  it('bug3: 一键出售 fullSet 为 3 块最大集', () => {
    const st = replayTo(123);
    const legal = enumerateActions(st, 0);
    const { fullSet } = sellOptions(legal);
    expect(fullSet?.sales).toHaveLength(3);
    expect(fullSet?.sales.filter((s) => s.useMerchantBeer)).toHaveLength(1); // 一桶商人酒 + 两桶自家
  });
});
