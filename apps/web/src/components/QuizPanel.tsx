/**
 * 练习与反馈（A5）
 *
 * 说明书 §2.6 的硬要求：
 * - **提交前不展示答案**；
 * - 题目来源身份必须标注清楚（「项目自编练习」/「基于你的材料生成」），
 *   自编题的解析**不计为材料证据**；
 * - 解析注明所用规则与验证状态。
 */

import { useState } from 'react';
import type { QuizItem, QuizSource, Topic } from '@lc/contracts';
import { FIXED_QUIZ_PER_TOPIC, TOPIC_LABELS } from '@lc/contracts';
import type { WorkbenchActions, WorkbenchState } from '../app/model/workbench-types';
import type { QuizReportOutcome } from '../app/model/workbench-types';
import { QUIZ_SOURCE_LABELS, VERIFICATION_LABELS, verificationClass } from '../shared/lib/labels';

type Props = {
  wb: WorkbenchState & WorkbenchActions;
  /**
   * 初始的题目来源。
   *
   * **仅供 `verify:render` 使用**：`source` 平时只能靠点击切换，而该脚本走
   * `react-dom/server`、模拟不了交互 —— 于是"零材料时不许按材料出题"这条
   * 真实性红线的文案就没有任何断言能覆盖（本环境也做不了浏览器验证，见 I8）。
   * 给学生用的默认值仍是「项目自编题」。
   */
  initialSource?: QuizSource;
};

const TOPICS: Topic[] = ['derivative', 'tangent', 'monotonicity'];

export function QuizPanel({ wb, initialSource = 'fixed' }: Props) {
  const [topic, setTopic] = useState<Topic>('derivative');
  const [source, setSource] = useState<QuizSource>(initialSource);
  const [items, setItems] = useState<QuizItem[] | null>(null);
  const [picked, setPicked] = useState<Record<string, string>>({});
  const [submitted, setSubmitted] = useState(false);
  /**
   * 这次提交的画像上报结果（`I33`）。
   *
   * 原先这里没有状态，面板直接写死「已作为一条画像事件上报」—— 而默认的
   * 「项目自编题」来源**不会建会话**，上报函数在开头就返回，**请求根本没发出**。
   * 现在把真实结果记下来，文案按结果分叉。
   */
  const [report, setReport] = useState<QuizReportOutcome | null>(null);
  /**
   * 当前这组题**实际是用哪个主题 / 哪个来源取回来的**（`I20②`）。
   *
   * 原先上报直接读 `topic` / `source` 两个开关的**当前值**：学生取完题后
   * 中途点一下切换按钮（题不会重取），上报给画像的 `topic`/`source` 就与实际
   * 做的那组题不符 —— 画像里的记录张冠李戴。切换开关不等于换了题。
   */
  const [loaded, setLoaded] = useState<{ topic: Topic; source: QuizSource } | null>(null);

  const busy = wb.isBusy('quiz');
  /**
   * 零材料时「按我的材料出题」不可用（`I20⑥`）。
   *
   * 原先这条路会**静默建一个空会话**、拿写死的题回来标成「基于你的材料生成」——
   * 来源声明不成立（§9 真实性红线）。服务端现在也会拒绝（400），
   * 这里同时把入口关掉并说清原因，不让按钮点下去才报错。
   */
  const materialBlocked = source === 'material' && wb.materials.length === 0;

  async function load() {
    const result = await wb.loadQuiz(topic, source);
    /*
     * `I32`：`null` 表示**没取到题**（零材料被拦、或请求失败），
     * 不等于"这次没有题"。原实现无条件 `setItems(null)` / `setPicked({})` /
     * `setSubmitted(false)`，于是学生在「答完 → 切到按材料出题（零材料）→
     * 点『再来一组』」这条路上，**已答结果会被整片抹掉**。
     * 症状相同、原因不同：拿不到题就不该动现有状态，失败提示已由 hook 抛出。
     */
    if (result === null) return;
    setItems(result);
    setPicked({});
    setSubmitted(false);
    setReport(null);
    // I20②：记住这组题是用哪个主题/来源取回来的，上报时以它为准
    setLoaded({ topic, source });
  }

  const answered = items ? items.filter((item) => picked[item.id]).length : 0;
  const correct = items
    ? items.filter((item) => picked[item.id] && picked[item.id] === item.answer).length
    : 0;

  return (
    <section className="panel">
      <header className="panel-head">
        <h2>练习</h2>
        {items && (
          <span className="meta">
            {items.length} 道 · 已答 {answered}
            {submitted ? ` · 答对 ${correct}` : ''}
          </span>
        )}
      </header>

      <div className="actions">
        <div className="mode-group" role="group" aria-label="主题">
          {TOPICS.map((item) => (
            <button
              key={item}
              className={item === topic ? 'mode mode-active' : 'mode'}
              onClick={() => setTopic(item)}
            >
              {TOPIC_LABELS[item]}
            </button>
          ))}
        </div>
        <div className="mode-group" role="group" aria-label="题目来源">
          <button
            className={source === 'fixed' ? 'mode mode-active' : 'mode'}
            onClick={() => setSource('fixed')}
          >
            项目自编题
          </button>
          <button
            className={source === 'material' ? 'mode mode-active' : 'mode'}
            onClick={() => setSource('material')}
          >
            按我的材料出题
          </button>
          <button
            className={source === 'variant' ? 'mode mode-active' : 'mode'}
            onClick={() => setSource('variant')}
          >
            针对需加强的概念
          </button>
        </div>
        {/*
          ⚠️ 只有 `material` 受"零材料"限制：变式题（`P-B17`）依据的是**掌握情况**，
          会话里一份讲义都没有时也该能练。至于"有没有可练的概念"，
          由**服务端**判定（挑不出就返回空集），界面照实说明 —— 前端不猜。
        */}
        <button
          className="btn"
          onClick={load}
          disabled={busy || (source === 'material' && materialBlocked)}
        >
          {busy ? '正在出题…' : items ? '换一组' : '开始练习'}
        </button>
      </div>

      {materialBlocked && (
        <p className="warn-inline">
          还没有可用的材料，因此不能「按我的材料出题」—— 那样只会得到一组与你的材料无关的题，
          却标着「基于你的材料生成」。请先在「材料」面板提交讲义；也可以改用「项目自编题」，
          它本来就不依赖材料。
        </p>
      )}

      {source === 'fixed' && (
        <p className="hint-inline">
          自编题每主题 {FIXED_QUIZ_PER_TOPIC} 道，答案唯一。它的解析「不算作你材料的证据」。
        </p>
      )}

      {source === 'variant' && (
        /*
         * ⚠️ 这里写「需要加强的概念」而不是「你的薄弱点」：与出题提示词第 4 条同一条纪律 ——
         * 别在学生做题时反复提醒他"你是差生"。
         */
        <p className="hint-inline">
          题目按你的「需要加强的概念」来出，不依赖材料；题目里不会出现任何个人信息。
        </p>
      )}

      {!items ? (
        <p className="hint">选好主题与来源后开始练习。答案在你提交之前不会显示。</p>
      ) : items.length === 0 ? (
        <p className="hint">
          {source === 'variant'
            ? '暂时没有可练的「需要加强的概念」—— 现有记录里这些概念都已掌握，或还没有足够的学习记录。先做几道题、或补充一份讲义，这里就会有内容。'
            : '这个主题暂时没有可用题目。'}
        </p>
      ) : (
        <>
          {items.map((item, index) => (
            <div key={item.id} className="quiz-item">
              <div className="quiz-head">
                <span className="quiz-index">第 {index + 1} 题</span>
                <span className="tag tag-muted">{QUIZ_SOURCE_LABELS[item.source]}</span>
                <span className={verificationClass(item.verification ?? 'unverified')}>
                  {VERIFICATION_LABELS[item.verification ?? 'unverified']}
                </span>
              </div>

              <p className="quiz-stem">{item.stem}</p>

              <ul className="options">
                {item.options.map((option) => {
                  const chosen = picked[item.id] === option.id;
                  const isRight = submitted && option.id === item.answer;
                  const isWrongChoice = submitted && chosen && option.id !== item.answer;
                  const cls = [
                    'option',
                    chosen ? 'option-chosen' : '',
                    isRight ? 'option-right' : '',
                    isWrongChoice ? 'option-wrong' : '',
                  ]
                    .filter(Boolean)
                    .join(' ');
                  return (
                    <li key={option.id}>
                      <button
                        className={cls}
                        disabled={submitted}
                        onClick={() =>
                          setPicked((previous) => ({ ...previous, [item.id]: option.id }))
                        }
                      >
                        <span className="option-id">{option.id}</span>
                        {option.text}
                      </button>
                    </li>
                  );
                })}
              </ul>

              {/* 提交后才展示答案与解析（§2.6） */}
              {submitted && (
                <div className="quiz-explain">
                  {picked[item.id] === item.answer ? (
                    <p className="quiz-right">答对了。可以继续下一题，或者回到答疑追问细节。</p>
                  ) : (
                    <p className="quiz-wrong">
                      这题选错了。正确答案是 {item.answer}。先看一下解析里的规则，回到上面「知识点」区
                      复习对应概念，再回来做一遍。
                    </p>
                  )}
                  {item.explanation && <p>{item.explanation}</p>}
                  {item.citations && item.citations.length > 0 ? (
                    <p className="hint-inline">
                      解析依据：{item.citations.length} 处引用，可在「依据详情」中核对。
                    </p>
                  ) : (
                    <p className="hint-inline">解析未附引用来源。</p>
                  )}
                </div>
              )}
            </div>
          ))}

          <div className="actions">
            {!submitted ? (
              <button
                className="btn"
                disabled={answered < items.length}
                onClick={() => {
                  setSubmitted(true);
                  const right = items.filter(
                    (item) => picked[item.id] && picked[item.id] === item.answer,
                  ).length;
                  // I20②：上报用的是**已加载题目的**来源，不是当前开关值
                  const origin = loaded ?? { topic, source };
                  void wb
                    .reportQuizAttempt({
                      topic: origin.topic,
                      source: origin.source,
                      total: items.length,
                      correct: right,
                    })
                    .then(setReport);
                }}
              >
                {answered < items.length ? `还有 ${items.length - answered} 题未作答` : '提交答案'}
              </button>
            ) : (
              <button className="btn btn-ghost" onClick={load} disabled={busy || materialBlocked}>
                再来一组
              </button>
            )}
          </div>

          {submitted && (
            <p className="hint-inline">
              {report === 'sent' && (
                <>本次提交已作为一条画像事件上报（答对 {correct} / {items.length}）。</>
              )}
              {report === 'no-session' && (
                <>
                  本次提交「没有」上报画像事件：这一组是「项目自编题」，它不需要学习会话，
                  因此没有发出任何请求（答对 {correct} / {items.length}）。
                </>
              )}
              {report === 'failed' && (
                <>
                  本次提交的画像事件上报失败，画像可能未更新（不影响你的作答与判分：
                  答对 {correct} / {items.length}）。
                </>
              )}
              {report === null && <>正在上报本次作答（答对 {correct} / {items.length}）…</>}
              但画像里的「常见误区」不会因为这次提交而新增条目 —— 错题归因（概念误解 / 计算错误 /
              条件遗漏 / 识别错误）尚未实现，它需要诊断 Agent 给出可核对的理由，
              仅凭"答错"就下结论会是编造（§2.6）。
            </p>
          )}
        </>
      )}
    </section>
  );
}
