import 'dotenv/config';

const LEVELS = { error: 0, warn: 1, info: 2, debug: 3 };

const COLOURS = {
    error: '\x1b[31m',
    warn: '\x1b[33m',
    info: '\x1b[36m',
    debug: '\x1b[35m',
    reset: '\x1b[0m',
};

const activeLevel = LEVELS[process.env.LOG_LEVEL] ?? LEVELS.info;
const isProduction = process.env.NODE_ENV === 'production';

// Spreading an Error yields nothing — its standard fields are non-enumerable.
function toPlainObject(value) {
    if (value instanceof Error) {
        return { errorName: value.name, errorMessage: value.message, errorStack: value.stack };
    }
    if (value && typeof value === 'object') return value;
    if (value === undefined) return {};
    return { detail: String(value) };
}

// A circular reference would otherwise throw inside the logger and take down the caller.
function stringify(value, indent) {
    const seen = new WeakSet();
    return JSON.stringify(value, (_key, val) => {
        if (typeof val === 'object' && val !== null) {
            if (seen.has(val)) return '[Circular]';
            seen.add(val);
        }
        if (val instanceof Map) return Object.fromEntries(val);
        if (val instanceof Set) return [...val];
        return val;
    }, indent);
}

function format(context, level, message, data) {
    const timestamp = new Date().toISOString();

    if (isProduction) {
        // Envelope fields last: a payload carrying its own `message` key would
        // otherwise silently replace the log line's message.
        return stringify({ ...data, timestamp, level, context, message });
    }

    const head = `${COLOURS[level]}[${timestamp}] [${level.toUpperCase()}] [${context}]${COLOURS.reset}`;
    return `${head} ${message}${Object.keys(data).length > 0 ? `\n${stringify(data, 2)}` : ''}`;
}

function write(context, level, message, data) {
    if (LEVELS[level] > activeLevel) return;

    const line = format(context, level, message, toPlainObject(data));

    if (level === 'error') console.error(line);
    else if (level === 'warn') console.warn(line);
    else console.log(line);
}

export function createLogger(context) {
    return {
        error: (message, data) => write(context, 'error', message, data),
        warn: (message, data) => write(context, 'warn', message, data),
        info: (message, data) => write(context, 'info', message, data),
        debug: (message, data) => write(context, 'debug', message, data),
        child: (name) => createLogger(`${context}:${name}`),
    };
}

export const logger = createLogger('CRM-Sync');
