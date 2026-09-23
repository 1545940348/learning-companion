# Derivatives and Monotonicity（中英对照笔记）

The derivative of a function f at a point x is defined as the limit of the difference quotient:

    f'(x) = lim_{h→0} [f(x + h) − f(x)] / h

中文补充：导数就是"瞬时变化率"。如果这个极限存在，就说 f 在 x 处**可导**。

Geometrically, f'(x) is the slope of the tangent line to the curve y = f(x) at the point (x, f(x)).
中文补充：所以 f'(x) > 0 表示切线向右上方倾斜，函数在这一带递增。

Monotonicity test（单调性判别法）:

- If f'(x) > 0 for all x in an interval, then f is increasing on that interval.
- If f'(x) < 0 for all x in an interval, then f is decreasing on that interval.

⚠️ 老师提醒：derivative（导数）和 differential（微分）是两个不同的东西，
不要把英文里的这两个词当成同一个知识点记。
