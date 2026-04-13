const LOG_LEVELS = {
  debug: 10,
  info: 20,
  warn: 30,
  error: 40,
};

const configuredLevel = String(process.env.LOG_LEVEL || 'info').toLowerCase();
const activeLevel = LOG_LEVELS[configuredLevel] || LOG_LEVELS.info;

const SUPPRESSED_PATTERNS = [
  /^addDecimals\b/,
  /^bigint: Failed to load bindings\b/,
];

function installConsoleFilters() {
  const originalLog = console.log.bind(console);
  const originalWarn = console.warn.bind(console);
  const originalError = console.error.bind(console);

  console.log = (...args) => {
    if (shouldSuppress(args)) return;
    originalLog(...args);
  };
  console.warn = (...args) => {
    if (shouldSuppress(args)) return;
    originalWarn(...args);
  };
  console.error = (...args) => {
    if (shouldSuppress(args)) return;
    originalError(...args);
  };
}

function debug(message, data = null) {
  write('debug', message, data);
}

function info(message, data = null) {
  write('info', message, data);
}

function warn(message, data = null) {
  write('warn', message, data);
}

function error(message, data = null) {
  write('error', message, data);
}

function request(req, res, extra = {}) {
  if (process.env.LOG_REQUESTS === 'false') return;
  info(`${req.method} ${req.path}`, {
    status: res.statusCode,
    ip: req.ip,
    ...extra,
  });
}

function write(level, message, data = null) {
  if ((LOG_LEVELS[level] || LOG_LEVELS.info) < activeLevel) return;
  const ts = new Date().toISOString();
  const suffix = data ? ` ${JSON.stringify(data)}` : '';
  const line = `[${ts}] [${level}] ${message}${suffix}`;

  if (level === 'error') console.error(line);
  else if (level === 'warn') console.warn(line);
  else console.log(line);
}

function shouldSuppress(args) {
  const text = args.map((arg) => stringify(arg)).join(' ');
  return SUPPRESSED_PATTERNS.some((pattern) => pattern.test(text));
}

function stringify(value) {
  if (typeof value === 'string') return value;
  if (value instanceof Error) return value.message;
  try {
    return JSON.stringify(value);
  } catch {
    return String(value);
  }
}

module.exports = {
  installConsoleFilters,
  debug,
  info,
  warn,
  error,
  request,
};
