// Node shim for uBO's src/js/logger.js.  Cosmetic compile drops are surfaced
// by cosmetic-filtering.js through logger.writeOne(); this shim records them
// so the pipeline can gate on rules stock uBO would silently ignore.
const messages = [];

export function takeLoggedMessages() {
  const out = messages.splice(0, messages.length);
  return out;
}

const logger = {
  enabled: false,
  ownerId: undefined,
  writeOne(details) {
    messages.push(details);
  },
};

export default logger;