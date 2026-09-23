/**
 * 图谱视图（A3，P1）
 *
 * 只读，不提供图形编辑器（§3.6）。
 *
 * ⚠️ **如实呈现数据现状**（`I1` 已把"提示词要求显式 `edges`"补上，mock 通道也已产出边）：
 * - `edges` 为空 → 界面明确说明"只有节点、没有关系边"；
 * - 有边、但**边的端点不是节点**（典型情况：前置缺口概念尚未从材料中抽为节点，
 *   如 `kp-monotonicity → kp-derivative` 里的 `kp-derivative`）→ 界面明确说明
 *   "有 N 条关系未画出连线"及原因。
 * 两者都**不**画一张看起来有结构、实际是前端臆造的图（§9），也**不静默丢边**。
 *
 * ⚠️ **节点状态同样要如实**（`I20①`）：本会话没有覆盖判定记录的节点标「未判定」，
 * **不得默认显示「材料已覆盖」** —— 那是一个系统从未做出的判定。
 *
 * P-A8：选中的知识点与知识卡片**共用同一份状态**（`wb.focusedNodeId`），
 * 卡片上点一下，这里定位并高亮；反过来点节点，卡片也高亮。
 */

import { useEffect, useRef } from 'react';
import type { PrerequisiteStatus } from '@lc/contracts';
import type { GapRecord, WorkbenchActions, WorkbenchState } from '../app/model/workbench-types';
import { SOURCE_LABELS, STATUS_LABELS } from '../shared/lib/labels';

type Props = { wb: WorkbenchState & WorkbenchActions };

const NODE_W = 150;
const NODE_H = 46;
const GAP_X = 30;
const GAP_Y = 44;

/** 无覆盖判定记录时的标注 —— 它**不是**六态之一，因为它不是一次判定，而是"没有判定" */
const UNDETERMINED_LABEL = '未判定';

/**
 * 取该节点**本会话实际记录**的覆盖状态（`I20①`，第三个来源见 `I34`）。
 *
 * 判定顺序：
 * 1. **补充记录**（学生刚点过「补上这一段」）—— 最新、优先；
 * 2. **前置关系判定**（`/api/knowledge` 的 `prerequisites[].conceptId`）—— 节点本身作为前置概念出现时；
 * 3. **知识点自身的材料引用**（`points[].id === nodeId` 且 `citations` 非空）→ `LOCAL`。
 *
 * 三者都没有就返回 `null`，由调用方如实标注「未判定」。
 *
 * 原先写的是 `wb.gaps[node.id]?.status`，缺失时直接显示「材料已覆盖」——
 * 而 `gaps` 只在点过「补上这一段」之后才有条目，于是**每个节点默认都显示"材料已覆盖"**，
 * 与同一面板详情里的「暂无引用」自相矛盾（LOCAL 的定义要求"能定位来源"）。
 *
 * ### 为什么必须补第 3 条（`I34`）
 *
 * 图谱节点来自 `points[].id`（如 `kp-monotonicity`），而"覆盖判定"原先只在
 * `prerequisites[].conceptId` 里找（如 `kp-derivative`）—— 这两个是**不同的东西**：
 * 前置概念讲的是"学这个之前需要什么"，知识点讲的是"这里有什么"。
 * 生成器产出的数据里两者从不重叠（示例数据：节点 `kp-monotonicity`，
 * 前置 `kp-derivative`），于是**每个节点恒落 `null` → 永久「未判定」**，
 * 哪怕材料里确实覆盖了它、`points[].citations` 里就有可定位的原文。
 *
 * ⚠️ 只在 `citations` **非空**时才判 `LOCAL`：契约对 LOCAL 的定义是
 * "能定位到原文"，没有引用就不是一次覆盖判定 —— 此时仍标「未判定」，
 * 不把"模型没给引用"说成"材料未覆盖"（那也是一次它没做过的判定）。
 */
function nodeStatus(
  nodeId: string,
  gaps: Record<string, GapRecord>,
  knowledge: WorkbenchState['knowledge'],
): PrerequisiteStatus | null {
  const gap = gaps[nodeId];
  if (gap) return gap.status;
  const relation = knowledge?.prerequisites.find((item) => item.conceptId === nodeId);
  if (relation) return relation.status;
  const point = knowledge?.points.find((item) => item.id === nodeId);
  if (point && point.citations.length > 0) return 'LOCAL';
  return null;
}

export function GraphPanel({ wb }: Props) {
  const graph = wb.graph;
  const selected = wb.focusedNodeId;
  const scrollRef = useRef<HTMLDivElement | null>(null);

  const nodes = graph?.nodes ?? [];
  const edges = graph?.edges ?? [];
  const hasEdges = edges.length > 0;
  /*
   * 端点不是节点的边画不出来（SVG 的 `<path>` 需要两端坐标）。
   * **不静默丢边**（`I1` 落地后新增的数据形态）：契约里 `to` 是"被依赖的前置概念"，
   * 它可以是材料未覆盖、尚未被抽为节点的概念（正是演示案例里的导数缺口）。
   * 原先这种边被 `position.get()` 取空后悄悄 `return null` —— 头部显示"N 关系"却一条线都没有，
   * 看的人只会以为界面坏了。改为如实报出条数。
   */
  const nodeIds = new Set(nodes.map((node) => node.id));
  const dangling = edges.filter((edge) => !nodeIds.has(edge.from) || !nodeIds.has(edge.to)).length;
  const undetermined = nodes.filter((node) => nodeStatus(node.id, wb.gaps, wb.knowledge) === null).length;

  // 布局：按"被依赖的深度"分层。没有边时全部落在第一层，排成一行。
  const depth = computeDepth(nodes.map((node) => node.id), edges);
  const layers = new Map<number, string[]>();
  for (const node of nodes) {
    const level = depth.get(node.id) ?? 0;
    const bucket = layers.get(level) ?? [];
    bucket.push(node.id);
    layers.set(level, bucket);
  }
  const maxLevel = Math.max(0, ...[...layers.keys()]);
  const maxColumn = Math.max(1, ...[...layers.values()].map((list) => list.length));

  const width = GAP_X * 2 + (maxLevel + 1) * NODE_W + maxLevel * 42;
  const height = GAP_Y * 2 + maxColumn * (NODE_H + 16);

  const position = new Map<string, { x: number; y: number }>();
  for (const [level, ids] of layers) {
    ids.forEach((id, index) => {
      position.set(id, {
        x: GAP_X + level * (NODE_W + 42),
        y: GAP_Y + index * (NODE_H + 16),
      });
    });
  }

  const active = selected ? nodes.find((node) => node.id === selected) : undefined;

  /**
   * 由知识卡片触发的定位：选中项一变，就把它的节点滚进可视区。
   *
   * 只在节点存在时滚动 —— 选中了一个不在图谱里的概念时，
   * 下方给出如实说明，而不是假装滚到某个位置上。
   */
  const focusSpot = selected ? position.get(selected) : undefined;
  const focusX = focusSpot?.x;
  const focusY = focusSpot?.y;
  useEffect(() => {
    const box = scrollRef.current;
    if (!box || focusX === undefined || focusY === undefined) return;
    if (typeof box.scrollTo !== 'function') return;
    box.scrollTo({
      left: Math.max(0, focusX + NODE_W / 2 - box.clientWidth / 2),
      top: Math.max(0, focusY + NODE_H / 2 - box.clientHeight / 2),
      behavior: 'smooth',
    });
  }, [focusX, focusY]);

  return (
    <section className="panel">
      <header className="panel-head">
        <h2>图谱</h2>
        <span className="meta">
          {nodes.length} 节点 · {edges.length} 关系
        </span>
      </header>

      {nodes.length === 0 ? (
        /* 空态只说"没有"，不再解释"节点会怎么出现、可以点什么"（2026-09-23 精简） */
        <p className="hint">图谱为空 · 解析材料后出现</p>
      ) : (
        <>
          {!hasEdges && (
            <p className="warn-inline">
              当前图谱只有节点、没有关系边：关系抽取尚未产出显式的 <code>from → to</code> 依赖，
              界面不会凭空连线。前置缺口请看上方「前置依赖」区。
            </p>
          )}

          {dangling > 0 && (
            <p className="hint-inline">
              另有 {dangling} 条关系指向尚未抽取为节点的概念（通常是材料未覆盖的前置缺口），
              因此这里画不出连线；这些概念在上方「前置依赖」区可见。
            </p>
          )}

          <p className="hint-inline graph-focus-hint">
            {selected
              ? '已选中一个知识点：与上方「知识点与前置依赖」里的卡片互相高亮。'
              : '点击节点，或点击上方任意知识点卡片，两边会互相定位与高亮。'}
          </p>

          {undetermined > 0 && (
            <p className="hint-inline">
              有 {undetermined} 个节点本会话没有覆盖判定记录，一律标为「{UNDETERMINED_LABEL}」——
              没有做过判定就不算「材料已覆盖」。
            </p>
          )}

          <div className="graph-scroll" ref={scrollRef}>
            <svg
              className="graph-svg"
              viewBox={`0 0 ${width} ${height}`}
              width={width}
              height={height}
              role="img"
              aria-label="知识点图谱"
            >
              {edges.map((edge, index) => {
                const from = position.get(edge.from);
                const to = position.get(edge.to);
                if (!from || !to) return null;
                const x1 = from.x + NODE_W;
                const y1 = from.y + NODE_H / 2;
                const x2 = to.x;
                const y2 = to.y + NODE_H / 2;
                return (
                  <g key={`${edge.from}-${edge.to}-${index}`}>
                    <path
                      className={`graph-edge graph-edge-${edge.status.toLowerCase()}`}
                      d={`M ${x1} ${y1} C ${x1 + 20} ${y1}, ${x2 - 20} ${y2}, ${x2} ${y2}`}
                      fill="none"
                    />
                    <text className="graph-edge-label" x={(x1 + x2) / 2} y={(y1 + y2) / 2 - 6}>
                      {relationLabel(edge.kind)}
                      {edge.inferred ? '（推断）' : ''}
                    </text>
                  </g>
                );
              })}

              {nodes.map((node) => {
                const spot = position.get(node.id);
                if (!spot) return null;
                const status = nodeStatus(node.id, wb.gaps, wb.knowledge);
                const isGap = status === 'MISSING' || status === 'PENDING';
                const isFocused = selected === node.id;
                const rectClass = [
                  'graph-rect',
                  isGap ? 'graph-rect-gap' : '',
                  isFocused ? 'graph-rect-focus' : '',
                ]
                  .filter(Boolean)
                  .join(' ');
                return (
                  <g
                    key={node.id}
                    className={isFocused ? 'graph-node graph-node-focus' : 'graph-node'}
                    onClick={() => wb.focusNode(isFocused ? null : node.id)}
                  >
                    <rect
                      x={spot.x}
                      y={spot.y}
                      width={NODE_W}
                      height={NODE_H}
                      rx={8}
                      className={rectClass}
                    />
                    <text className="graph-node-title" x={spot.x + 12} y={spot.y + 20}>
                      {clip(node.name, 11)}
                    </text>
                    <text className="graph-node-sub" x={spot.x + 12} y={spot.y + 36}>
                      {status ? STATUS_LABELS[status] : UNDETERMINED_LABEL}
                    </text>
                  </g>
                );
              })}
            </svg>
          </div>

          {selected && !active && (
            <p className="hint-inline">
              选中的知识点「{selected}」不在当前图谱的节点里，因此没有可定位的位置。
              图谱只收录本次材料解析出的概念；缺口的完整信息在上方「前置依赖」区。
            </p>
          )}

          {active && (
            <div className="graph-detail">
              <h3>{active.name}</h3>
              <p>{active.explanation}</p>
              {active.formula && (
                <p>
                  <span className="kp-label">公式</span>
                  {active.formula}
                </p>
              )}
              <p>
                <span className="kp-label">来源</span>
                {active.citations.length === 0
                  ? '暂无引用'
                  : active.citations
                      .map((citation) => SOURCE_LABELS[citation.sourceType])
                      .join('、')}
              </p>
              <button className="link" onClick={() => wb.focusNode(null)}>
                取消选中
              </button>
            </div>
          )}
        </>
      )}
    </section>
  );
}

/** 计算每个节点"离叶子有多远"，用于分层。无边时全部为 0。 */
function computeDepth(ids: string[], edges: { from: string; to: string }[]): Map<string, number> {
  const depth = new Map<string, number>(ids.map((id) => [id, 0]));
  if (edges.length === 0) return depth;

  // 依赖边的 from 指向被依赖的 to：to 在左侧，from 逐层向右
  for (let round = 0; round < ids.length; round += 1) {
    let changed = false;
    for (const edge of edges) {
      const from = depth.get(edge.from) ?? 0;
      const to = depth.get(edge.to) ?? 0;
      if (from <= to) {
        depth.set(edge.from, to + 1);
        changed = true;
      }
    }
    if (!changed) break;
  }
  return depth;
}

function relationLabel(kind: string): string {
  switch (kind) {
    case 'prerequisite':
      return '前置';
    case 'derives':
      return '可推导';
    case 'illustrates':
      return '例证';
    case 'contrasts':
      return '对比';
    case 'extends':
      return '推广';
    case 'depends_on':
      return '计算依赖';
    default:
      return kind;
  }
}

function clip(text: string, max: number): string {
  return text.length > max ? `${text.slice(0, max)}…` : text;
}
