import { describe, it, expect } from 'vitest';
import { LOCATIONS, LINKS, MERCHANTS, neighborsOf } from '../src/data/board.js';

describe('board data', () => {
  it('has 20 named locations + 2 farm breweries', () => {
    const ids = Object.keys(LOCATIONS);
    expect(ids).toHaveLength(22);
    expect(ids.filter((id) => LOCATIONS[id]!.region === 'farm')).toHaveLength(2);
  });
  it('has 39 links; 30 both-era, 1 canal-only, 8 rail-only', () => {
    expect(LINKS).toHaveLength(39);
    expect(LINKS.filter((l) => l.canal && l.rail)).toHaveLength(30);
    expect(LINKS.filter((l) => l.canal && !l.rail)).toHaveLength(1);
    expect(LINKS.filter((l) => !l.canal && l.rail)).toHaveLength(8);
  });
  it('burton-walsall is the only canal-only link', () => {
    const l = LINKS.find((x) => x.canal && !x.rail);
    expect(new Set([l!.a, l!.b])).toEqual(new Set(['burton-on-trent', 'walsall']));
  });
  it('every link endpoint is a known location or merchant', () => {
    for (const l of LINKS) {
      const ok = (id: string) => id in LOCATIONS || id in MERCHANTS;
      expect(ok(l.a) && ok(l.b)).toBe(true);
    }
  });
  it('graph in canal era reaches 26/27 nodes (farms reachable; uttoxeter is rail-only)', () => {
    // BFS from birmingham over canal edges. 注意：与 task brief 的 27 不同——
    // uttoxeter 的两条边（#25 derby、#37 stone）均为仅铁路（rules-reference §1.2，[T][N] 一致），
    // 运河时代网络无法到达 uttoxeter（符合实体版图），故运河 BFS = 26。
    const seen = new Set<string>(['birmingham']);
    const queue = ['birmingham'];
    while (queue.length) {
      const cur = queue.pop()!;
      for (const n of neighborsOf(cur as never, 'canal'))
        if (!seen.has(n)) { seen.add(n); queue.push(n); }
    }
    expect(seen.size).toBe(26);
    expect(seen.has('uttoxeter')).toBe(false);
    expect(seen.has('farm-north')).toBe(true);
    expect(seen.has('farm-south')).toBe(true);
  });
  it('graph is fully connected in rail era (all 22 locations + 5 merchants)', () => {
    const seen = new Set<string>(['birmingham']);
    const queue = ['birmingham'];
    while (queue.length) {
      const cur = queue.pop()!;
      for (const n of neighborsOf(cur as never, 'rail'))
        if (!seen.has(n)) { seen.add(n); queue.push(n); }
    }
    expect(seen.size).toBe(27);
  });
  it('kidderminster-worcester is a single three-endpoint link through farm-south', () => {
    // LINKS 仍计 39 条；farm-south 经 LINK_EXTRA_ENDPOINTS 并入同一条边
    expect(new Set(neighborsOf('farm-south', 'canal'))).toEqual(new Set(['kidderminster', 'worcester']));
    expect(neighborsOf('kidderminster', 'canal')).toContain('farm-south');
    expect(neighborsOf('worcester', 'canal')).toContain('farm-south');
  });
  it('farm slots accept only brewery', () => {
    for (const id of ['farm-north', 'farm-south']) {
      expect(LOCATIONS[id]!.slots).toEqual([{ industries: ['brewery'] }]);
    }
  });
  it('merchant bonuses match rulebook', () => {
    expect(MERCHANTS.shrewsbury.bonus).toEqual({ type: 'vp', amount: 4 });
    expect(MERCHANTS.oxford.bonus).toEqual({ type: 'income', amount: 2 });
    expect(MERCHANTS.warrington.bonus).toEqual({ type: 'money', amount: 5 });
    expect(MERCHANTS.nottingham.bonus).toEqual({ type: 'vp', amount: 3 });
    expect(MERCHANTS.gloucester.bonus).toEqual({ type: 'develop', amount: 1 });
  });
  it('birmingham has 4 slots, first is cotton/manufacturer', () => {
    expect(LOCATIONS.birmingham.slots).toHaveLength(4);
    expect(LOCATIONS.birmingham.slots[0]!.industries).toEqual(['cotton', 'manufacturer']);
  });
});
