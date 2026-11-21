#!/usr/bin/env node
/**
 * Замер скорости скачивания по HTTP(S).
 *
 * Делает N последовательных запросов к указанному адресу (по умолчанию 10),
 * каждый раз дочитывает ответ до конца, затем печатает среднее время запроса,
 * общий объём скачанных данных и среднюю скорость.
 *
 * Без зависимостей, Node.js 18+ (встроенный fetch).
 *
 * Пример:
 *   node speedtest.js https://example.com/big-image.jpg
 */

'use strict';

const { parseArgs } = require('node:util');
const { performance } = require('node:perf_hooks');

const USER_AGENT = 'speedtest.js/1.0';

const USAGE = `Использование: node speedtest.js <адрес> [-n COUNT] [-t TIMEOUT]

  <адрес>              что скачивать (http:// или https://)
  -n, --count COUNT    сколько запросов сделать (по умолчанию 10)
  -t, --timeout SEC    таймаут неактивности сети, секунд (по умолчанию 30)
  -h, --help           показать эту справку`;

class UsageError extends Error {}

function parseCli(argv) {
  let parsed;
  try {
    parsed = parseArgs({
      args: argv,
      allowPositionals: true,
      options: {
        count: { type: 'string', short: 'n', default: '10' },
        timeout: { type: 'string', short: 't', default: '30' },
        help: { type: 'boolean', short: 'h', default: false },
      },
    });
  } catch (e) {
    throw new UsageError(e.message);
  }

  const { values, positionals } = parsed;
  if (values.help) return { help: true };

  if (positionals.length !== 1) {
    throw new UsageError('нужно указать ровно один адрес');
  }
  const url = positionals[0];
  if (!/^https?:\/\//i.test(url)) {
    throw new UsageError('адрес должен начинаться с http:// или https://');
  }
  try {
    new URL(url);
  } catch {
    throw new UsageError(`некорректный адрес: ${url}`);
  }

  const count = Number(values.count);
  if (!Number.isInteger(count) || count < 1) {
    throw new UsageError('--count должен быть целым числом не меньше 1');
  }
  const timeout = Number(values.timeout);
  if (!Number.isFinite(timeout) || timeout <= 0) {
    throw new UsageError('--timeout должен быть числом больше 0');
  }

  return { url, count, timeoutMs: timeout * 1000 };
}

/**
 * Скачивает url целиком. Возвращает { bytes, seconds }.
 *
 * Время считается от отправки запроса до получения последнего байта тела:
 * сюда входят DNS, установка соединения (и TLS, если соединение новое),
 * ожидание ответа и сама передача данных.
 *
 * Таймаут — на неактивность: если за timeoutMs не пришло ни одного байта,
 * запрос прерывается. Медленная, но идущая загрузка не обрывается.
 */
async function fetchOnce(url, timeoutMs) {
  const controller = new AbortController();
  let timer;
  const arm = () => {
    clearTimeout(timer);
    timer = setTimeout(
      () => controller.abort(new Error(`нет данных дольше ${timeoutMs / 1000} с`)),
      timeoutMs,
    );
  };

  let bytes = 0;
  const start = performance.now();
  arm();
  try {
    const response = await fetch(url, {
      signal: controller.signal,
      redirect: 'follow',
      cache: 'no-store',
      headers: {
        'User-Agent': USER_AGENT,
        // Просим промежуточные кэши не отдавать сохранённую копию.
        'Cache-Control': 'no-cache',
        Pragma: 'no-cache',
        // Просим тело без сжатия, чтобы считать реально переданные байты.
        'Accept-Encoding': 'identity',
      },
    });

    if (!response.ok) {
      // Дочитывать тело ошибки не нужно — освобождаем соединение.
      await response.body?.cancel().catch(() => {});
      const err = new Error(`HTTP ${response.status} ${response.statusText}`.trim());
      err.isHttp = true;
      throw err;
    }

    if (response.body) {
      for await (const chunk of response.body) {
        bytes += chunk.byteLength;
        arm();
      }
    }
  } finally {
    clearTimeout(timer);
  }
  const seconds = (performance.now() - start) / 1000;
  return { bytes, seconds };
}

const megabytes = (bytes) => bytes / 1_000_000;
const mbitPerSec = (bytes, seconds) =>
  seconds > 0 ? (bytes * 8) / 1_000_000 / seconds : Infinity;

function describeError(err) {
  if (err.isHttp) return `ошибка ${err.message}`;
  // fetch прячет настоящую причину (ECONNREFUSED, ENOTFOUND, таймаут…) в cause.
  const cause = err.cause;
  const reason = cause?.code
    ? `${cause.code}${cause.message ? ` (${cause.message})` : ''}`
    : cause?.message || err.message;
  return `ошибка сети: ${reason}`;
}

let interrupted = false;

async function main() {
  let opts;
  try {
    opts = parseCli(process.argv.slice(2));
  } catch (e) {
    if (e instanceof UsageError) {
      console.error(`${USAGE}\n\nОшибка: ${e.message}`);
      return 2;
    }
    throw e;
  }
  if (opts.help) {
    console.log(USAGE);
    return 0;
  }

  const { url, count, timeoutMs } = opts;
  console.log(`Адрес:    ${url}`);
  console.log(`Запросов: ${count}, последовательно\n`);

  const sizes = [];
  const durations = [];
  let failures = 0;
  const width = String(count).length;

  for (let i = 1; i <= count && !interrupted; i++) {
    const label = `[${String(i).padStart(width)}/${count}]`;
    try {
      const { bytes, seconds } = await fetchOnce(url, timeoutMs);
      sizes.push(bytes);
      durations.push(seconds);
      console.log(
        `${label} ${megabytes(bytes).toFixed(3).padStart(10)} МБ  ` +
          `за ${seconds.toFixed(3).padStart(8)} с  ` +
          `→ ${mbitPerSec(bytes, seconds).toFixed(2).padStart(9)} Мбит/с`,
      );
    } catch (err) {
      failures++;
      console.log(`${label} ${describeError(err)}`);
    }
  }

  console.log();
  if (durations.length === 0) {
    console.log('Ни один запрос не завершился успешно — посчитать скорость нельзя.');
    return 1;
  }

  const totalBytes = sizes.reduce((a, b) => a + b, 0);
  const totalTime = durations.reduce((a, b) => a + b, 0);
  const avgTime = totalTime / durations.length;

  console.log('Итого');
  console.log(
    `  Успешных запросов:    ${durations.length} из ${count}` +
      (failures ? ` (ошибок: ${failures})` : ''),
  );
  console.log(`  Среднее время:        ${avgTime.toFixed(3)} с`);
  console.log(
    `  Скачано всего:        ${megabytes(totalBytes).toFixed(3)} МБ (${totalBytes} байт)`,
  );
  console.log(
    `  Скорость скачивания:  ${mbitPerSec(totalBytes, totalTime).toFixed(2)} Мбит/с ` +
      `(${(megabytes(totalBytes) / totalTime).toFixed(2)} МБ/с)`,
  );

  if (interrupted) return 130;
  return failures === 0 ? 0 : 2;
}

// Первый Ctrl+C — дождаться текущего запроса и вывести итог по готовым.
// Второй — выйти сразу.
process.on('SIGINT', () => {
  if (interrupted) process.exit(130);
  interrupted = true;
  console.log('\nОстанавливаюсь после текущего запроса (Ctrl+C ещё раз — выйти сразу)…');
});

main().then(
  (code) => process.exit(code),
  (err) => {
    console.error(err);
    process.exit(1);
  },
);
