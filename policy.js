const LAMPORTS_PER_SOL = 1_000_000_000;

export function calculateDevFeeLamports(realizedProfitSol, percent = 10) {
  const profit = Number(realizedProfitSol);
  const rate = Number(percent);
  if (!Number.isFinite(profit) || profit <= 0) return 0;
  if (!Number.isFinite(rate) || rate < 0 || rate > 100) throw new Error('Fee percent must be between 0 and 100.');
  return Math.floor(profit * LAMPORTS_PER_SOL * rate / 100);
}
