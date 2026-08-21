import type { Action, Card, GameState, IndustryType, LocationId, MerchantId, PlayerIndex, PlayerState } from '@brass/engine';

export const PROTOCOL_VERSION = 1;

export { filterStateFor } from './filter.js';

// 房间配置与大厅
export type AIDifficulty = 'easy' | 'normal' | 'hard';
/** AI 座位配置：count 合法域 1..playerCount-1（createRoom 校验，非法回 'invalid-config'）。 */
export interface AISeatConfig { count: number; difficulty: AIDifficulty }
export interface RoomConfig { playerCount: 2|3|4; seed?: number; aiSeats?: AISeatConfig }
export interface SeatInfo { seat: PlayerIndex; nickname: string; isAI: boolean; connected: boolean }
export interface RoomState { code: string; config: RoomConfig; customSeed: boolean; seats: (SeatInfo|null)[]; started: boolean }
// customSeed：client 供 seed 时 true（公开标记，大厅可展示"房主指定了种子"）；广播 config 不含 seed 值。

// 下行
export type ServerMessage =
  | { type: 'room_state'; protocolVersion: number; room: RoomState; yourSeat: PlayerIndex | null } // 广播安全：绝不含 token
  | { type: 'credentials'; protocolVersion: number; seat: PlayerIndex; token: string } // 仅 create/join/resume 时单发给本人
  | { type: 'snapshot'; protocolVersion: number; seq: number; state: FilteredState; legalActions: Action[]; turnHold?: PlayerIndex | null; playedCards?: Card[][] } // turnHold：该座位行动完但尚未显式"结束回合"——对局被扣住,等其 end_turn/reset_turn；playedCards：各座位本时代已打出的牌(按打出顺序,Wild 不入列)
  | { type: 'action_applied'; protocolVersion: number; seq: number; player: PlayerIndex; action: Action; events: unknown[]; reason?: string; degraded?: boolean } // reason：AI 决策理由（真人行动无此字段）；degraded=true：非 LLM 降级路径（启发式/兜底）
  | { type: 'player_draft'; protocolVersion: number; seat: PlayerIndex; draft: DraftPreview | null } // 某座位暂存预览(考虑中的行动);null=清除
  | { type: 'turn_reset'; protocolVersion: number; seat: PlayerIndex } // 某座位重置了本回合(全场播报用)
  | { type: 'ai_thinking'; protocolVersion: number; seat: PlayerIndex; thinking: boolean } // AI 决策中指示（true→false 成对）
  | { type: 'game_over'; protocolVersion: number; winner: PlayerIndex[]; finalScores: number[] } // finalScores = 终局 state.players[].vp 按座位序
  | { type: 'error'; protocolVersion: number; code: string; message: string }
  | { type: 'pong'; protocolVersion: number };

/**
 * 暂存预览（多玩家实时同步）：当前行动方正在考虑/点选中的行动，广播给同房
 * 其他玩家——他人棋盘渲染同样的幽灵落子，并同步 5 秒播报（改动即替换）。
 * text 由发送方本地生成（与确认钮文案一致）。
 */
export interface DraftPreview {
  /** 建造幽灵（落槽已按引擎规范化解析——与实际结算一致）。 */
  build?: { location: LocationId; slotIndex: number; industry: IndustryType };
  /** 铺路幽灵（已点选的边，按放置顺序）。 */
  links?: number[];
  /** 卖出幽灵：待卖板块 + 啤酒匹配线（来源 → 卖货地点）。 */
  sell?: {
    tiles: { location: LocationId; slotIndex: number }[];
    matches: { from: LocationId | MerchantId; to: LocationId }[];
  };
  /** 播报文案（如 "建造伯明翰棉纺厂" / "贷款 £30（收入 −3 级）"）。 */
  text: string;
}

// FilteredState = GameState 按座位视角过滤（filter.ts filterStateFor 产出）：
// 他人手牌与牌堆只露数量，弃牌堆顶公开，rngState 移除防推算洗牌。
export type HandView = { kind: 'full'; cards: Card[] } | { kind: 'count'; count: number };
export type FilteredPlayerState = Omit<PlayerState, 'hand'> & { hand: HandView };
export type FilteredState = Omit<GameState, 'players'|'deck'|'discard'|'rngState'> & {
  players: FilteredPlayerState[];
  deck: { count: number };
  discard: { count: number; top: Card | null };
};

// 上行
export type ClientMessage =
  | { type: 'create_room'; protocolVersion: number; nickname: string; config: RoomConfig }
  | { type: 'join_room'; protocolVersion: number; code: string; nickname: string }
  | { type: 'start_game'; protocolVersion: number; token: string }
  | { type: 'submit_action'; protocolVersion: number; token: string; action: Action }
  | { type: 'resume'; protocolVersion: number; token: string }
  | { type: 'end_turn'; protocolVersion: number; token: string } // 扣住的回合:显式结束(放行下一玩家/AI)
  | { type: 'reset_turn'; protocolVersion: number; token: string } // 扣住的回合:撤销本轮全部行动重来
  | { type: 'draft_update'; protocolVersion: number; token: string; draft: DraftPreview | null } // 暂存预览同步(null=清除);服务器广播 player_draft 给同房其他人
  | { type: 'leave'; protocolVersion: number; token: string } // 主动退出：清座位索引 + 广播 + 断开本连接（对局继续）
  | { type: 'ping'; protocolVersion: number };
