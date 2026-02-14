function timestamp() {
  return new Date().toISOString();
}

function format(level, msg) {
  return `[${timestamp()}] [${level}] ${msg}`;
}

module.exports = {
  info: (msg) => console.log(format('INFO', msg)),
  warn: (msg) => console.warn(format('WARN', msg)),
  error: (msg) => console.error(format('ERROR', msg)),
  step: (name) => console.log(`\n${format('STEP', name)}`),
};
