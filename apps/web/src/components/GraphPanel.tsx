/**
 * 图谱视图（A3，P1）
 *
 * 只读，不提供图形编辑器（§3.6）。
 *
 * ⚠️ **如实呈现数据现状**：图谱的边由教学模块产出，在其提示词补齐之前
 * `edges` 为空 —— 此时界面明确说明"只有节点、没有关系边"，
 * 而不是画一张看起来有结构、实际是前端臆造的图（§9）。
 */

import { useState } from 'react';
import type { WorkbenchActions, WorkbenchState } from '../hooks/useWorkbench';
import { SOURCE_LABELS, STATUS_LABELS, statusClass } from '../lib/labels';

type Props = { wb: WorkbenchState & WorkbenchActions };

const NODE_W = 150;
const NODE_H = 46;
const GAP_X = 30;
const GAP_Y = 44;

export function GraphPanel({ wb }: Props) {
  const graph = wb.graph;
  const [selected, setSelected] = useState<string | null>(null);

  const nodes = graph?.nodes ?? [];
  const edges = graph?.edges ?? [];
  const hasEdges = edges.length > 0;

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

  return (
    <section className="panel">
      <header className="panel-head">
        <h2>图谱</h2>
        <span className="meta">
          {nodes.length} 节点 · {edges.length} 关系
        </span>
      </header>

      {nodes.length === 0 ? (
        <p className="hint">
          图谱为空。解析材料后，概念层节点会出现在这里，可点击节点查看它的来源与验证状态。
        </p>
      ) : (
        <>
          {!hasEdges && (
            <p className="warn-inline">
              当前图谱只有节点、没有关系边：关系抽取尚未产出显式的 <code>from → to</code> 依赖，
              界面不会凭空连线。前置缺口请看上方「前置依赖」区。
            </p>
          )}

          <div className="graph-scroll">
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
                const status = wb.gaps[node.id]?.status;
                const cls = status ? statusClass(status) : 'tag tag-local';
                const isGap = status === 'MISSING' || status === 'PENDING';
                return (
                  <g
                    key={node.id}
                    className="graph-node"
                    onClick={() => setSelected(selected === node.id ? null : node.id)}
                  >
                    <rect
                      x={spot.x}
                      y={spot.y}
                      width={NODE_W}
                      height={NODE_H}
                      rx={8}
                      className={isGap ? 'graph-rect graph-rect-gap' : 'graph-rect'}
                    />
                    <text className="graph-node-title" x={spot.x + 12} y={spot.y + 20}>
                      {clip(node.name, 11)}
                    </text>
                    <text className="graph-node-sub" x={spot.x + 12} y={spot.y + 36}>
                      {status ? STATUS_LABELS[status] : '材料已覆盖'}
                    </text>
                  </g>
                );
              })}
            </svg>
          </div>

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
