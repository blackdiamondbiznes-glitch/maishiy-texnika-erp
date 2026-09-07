function toNum(x) {
  const n = Number(x);
  if (!Number.isFinite(n)) return 0;
  return n;
}

function round2(x) {
  return Math.round(toNum(x) * 100) / 100;
}

function round3(x) {
  return Math.round(toNum(x) * 1000) / 1000;
}

function eq2(a, b) {
  return round2(a) === round2(b);
}

module.exports = { toNum, round2, round3, eq2 };
