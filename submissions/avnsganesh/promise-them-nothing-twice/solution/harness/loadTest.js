// Load-generating harness.
//
// SKELETON ONLY — not implemented yet.
//
// Planned: drive the cluster at quota boundaries for a set of fake customers
// and print a legible report (stdout table + JSON) that makes correct vs.
// incorrect behavior obvious without reading the limiter source. Scenarios to
// cover: two customers at exactly 100 RPM, one customer over 100 RPM, Northwind
// inside vs. outside the 02:00-04:00 UTC burst window, and the fixed-window
// boundary double-spend that token bucket should avoid.

console.error('harness/loadTest.js: not implemented yet (skeleton).');
process.exit(1);
