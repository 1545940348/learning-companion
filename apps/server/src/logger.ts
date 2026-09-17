/**
 * 极简结构化日志。
 *
 * 目的：让服务端日志可机读（一行一个对象），便于把"这次调用用的哪条通道、
 * 耗时多少、失败原因是什么"留在开发记录里（说明书 V1.4 要求记录真实耗时与错误）。
 *
 * 刻意不引入日志库：初赛只需要单行结构化输出，加依赖不划算。
 * 本模块**不替换**既有的启动日志，只服务于新增的模型调用与重试链路。
 */

export type LogLevel = 'info' | 'warn' | 'error';

export interface Logger {
  info(message: string, fields?: Readonly<Record<string, unknown>>): void;
  warn(message: string, fields?: Readonly<Record<string, unknown>>): void;
  error(message: string, fields?: Readonly<Record<string, unknown>>): void;
}

/**
 * 序列化附加字段。
 *
 * 只做浅层 JSON 序列化并丢弃 undefined：调用方有责任保证字段里
 * **不含密钥**（模型层的错误文本已由 redact() 处理过）。
 */
function formatFields(fields?: Readonly<Record<string, unknown>>): string {
  if (!fields) return '';
  const entries = Object.entries(fields).filter(([, value]) => value !== undefined);
  if (entries.length === 0) return '';
  return ` ${JSON.stringify(Object.fromEntries(entries))}`;
}

function write(
  level: LogLevel,
  message: string,
  fields?: Readonly<Record<string, unknown>>,
): void {
  const line = `[${new Date().toISOString()}] ${level.toUpperCase()} ${message}${formatFields(fields)}`;
  // 错误走 stderr，便于部署时把正常输出与故障分开收集
  const sink = level === 'error' ? process.stderr : process.stdout;
  sink.write(`${line}\n`);
}

export const logger: Logger = {
  info: (message, fields) => write('info', message, fields),
  warn: (message, fields) => write('warn', message, fields),
  error: (message, fields) => write('error', message, fields),
};
