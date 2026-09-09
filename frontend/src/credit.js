export function discountRateForScore(score) {
  if (score >= 900) return 0.01;
  if (score >= 800) return 0.03;
  if (score >= 650) return 0.07;
  if (score >= 500) return 0.15;
  return null;
}
