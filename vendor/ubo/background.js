// Node shim for uBO's src/js/background.js.  cosmetic-filtering.js reads only
// µb.hiddenSettings.allowGenericProceduralFilters; ship the stock default
// (false), which is what a default Firefox uBO applies: generic procedural
// cosmetic filters (e.g. `##div:has(...)` with no host) are dropped at load.
const µb = {
  hiddenSettings: {
    allowGenericProceduralFilters: false,
  },
};

export default µb;